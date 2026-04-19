//
// /memory-index — Index project files into Cloudflare AI Search.
//
// Usage:
//   /memory-index                   — Index all files (respecting .gitignore)
//   /memory-index src               — Index files under src/
//   /memory-index README.md docs    — Index specific files/dirs
//

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import { readFileSync, statSync } from "node:fs";
import { relative, join } from "node:path";

const MAX_FILE_SIZE = 100 * 1024;

const INDEXABLE_EXTENSIONS = new Set([
	".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json",
	".md", ".mdx", ".txt", ".yaml", ".yml", ".toml",
	".sh", ".py", ".go", ".rs", ".java", ".css", ".html",
	".sql", ".graphql", ".prisma", ".env.example",
]);

function isIndexable(filepath: string): boolean {
	const lower = filepath.toLowerCase();
	const base = lower.split("/").pop() ?? "";
	if (["dockerfile", "makefile", "readme", "license", "changelog"].includes(base)) return true;
	for (const ext of INDEXABLE_EXTENSIONS) {
		if (lower.endsWith(ext)) return true;
	}
	return false;
}

export function registerIndexCommand(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
) {
	pi.registerCommand("memory-index", {
		description: "Index project files into Cloudflare AI Search for searchable project knowledge",
		handler: async (args, ctx) => {
			const client = getClient();
			const config = getConfig();
			if (!client || !config) { ctx.ui.notify("Not configured. Run /memory-setup first.", "error"); return; }

			const patterns = args?.trim() ? args.trim().split(/\s+/) : ["."];

			ctx.ui.notify(`Finding files to index...`, "info");

			let files: string[];
			try {
				const result = await pi.exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { timeout: 10000 });
				if (result.code !== 0) { ctx.ui.notify("Not a git repository?", "error"); return; }
				files = result.stdout.split("\n").map((f) => f.trim()).filter((f) => f.length > 0);
			} catch { ctx.ui.notify("Failed to list files.", "error"); return; }

			// Filter by patterns
			if (patterns[0] !== ".") {
				const filtered: string[] = [];
				for (const file of files) {
					for (const pat of patterns) {
						if (file === pat || file.startsWith(pat + "/") || file.startsWith(pat)) {
							filtered.push(file);
							break;
						}
					}
				}
				files = filtered;
			}

			// Filter to indexable
			files = files.filter((f) => {
				if (!isIndexable(f)) return false;
				try {
					const stat = statSync(join(ctx.cwd, f));
					return stat.isFile() && stat.size <= MAX_FILE_SIZE;
				} catch { return false; }
			});

			if (files.length === 0) { ctx.ui.notify("No indexable files found.", "warning"); return; }

			const ok = await ctx.ui.confirm(`Index ${files.length} files?`, `Upload to AI Search instance "${config.searchInstance}".`);
			if (!ok) return;

			ctx.ui.notify(`Indexing ${files.length} files...`, "info");

			let indexed = 0;
			let errors = 0;
			const BATCH = 5;

			for (let i = 0; i < files.length; i += BATCH) {
				const batch = files.slice(i, i + BATCH);
				await Promise.all(batch.map(async (file) => {
					try {
						const content = readFileSync(join(ctx.cwd, file), "utf-8");
						const rel = relative(ctx.cwd, join(ctx.cwd, file));
						await client.uploadFile(config.searchInstance, rel, content, { path: rel });
						indexed++;
					} catch { errors++; }
				}));

				ctx.ui.setStatus("memory-index", ctx.ui.theme.fg("accent", `📂 ${indexed}/${files.length}`));
			}

			ctx.ui.setStatus("memory-index", undefined);
			ctx.ui.notify(`✓ Indexing complete: ${indexed} files${errors > 0 ? `, ${errors} errors` : ""}`, "info");
		},
	});
}
