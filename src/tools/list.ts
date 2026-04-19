/**
 * memory_list tool — List stored memories.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";

export function registerListTool(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
) {
	pi.registerTool({
		name: "memory_list",
		label: "Memory List",
		description: "List stored memories for this project or globally.",
		promptSnippet: "List persistent memories stored for the current project or globally",
		parameters: Type.Object({
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("global"), Type.Literal("both")], {
					description: "'project' (default), 'global', or 'both'",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const client = getClient();
			const config = getConfig();
			if (!client || !config) throw new Error("Not configured. Run /memory-setup first.");

			const scope = params.scope ?? "project";
			const targets: Array<{ name: string; label: string }> = [];
			if (scope === "project" || scope === "both") targets.push({ name: config.projectMemoryInstance, label: "Project" });
			if (scope === "global" || scope === "both") targets.push({ name: config.globalMemoryInstance, label: "Global" });

			const sections: string[] = [];
			let total = 0;

			for (const t of targets) {
				try {
					const res = await client.listMemories(t.name, signal);
					total += res.count;
					if (res.count === 0) {
						sections.push(`[${t.label}] No memories stored.`);
					} else {
						const items = res.items.map((i) => `  • ${i.key} (${i.status})`);
						sections.push(`[${t.label}] ${res.count} memorie(s):\n${items.join("\n")}`);
					}
				} catch {
					sections.push(`[${t.label}] Failed to fetch memories.`);
				}
			}

			return {
				content: [{ type: "text", text: sections.join("\n\n") }],
				details: { scope, total } as Record<string, unknown>,
			};
		},
	});
}
