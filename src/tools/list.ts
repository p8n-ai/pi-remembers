/**
 * memory_list tool — List stored memories by scope.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import type { StatsLogger } from "../stats/logger.js";
import { createRecorder } from "../stats/recorder.js";

export function registerListTool(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
	getLogger: (() => StatsLogger | null) | null,
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
			const config = getConfig();
			const rec = createRecorder(getLogger?.() ?? null, "list", {
				scope: params.scope ?? "project",
				projectId: config?.projectId,
				projectName: config?.projectName,
			});

			try {
				const client = getClient();
				if (!client || !config) throw new Error("Not configured. Run /memory-setup first.");

				const scope = params.scope ?? "project";
				const targets: Array<{ name: string; label: string }> = [];
				if (scope === "project" || scope === "both") targets.push({ name: config.projectMemoryInstance, label: "Project" });
				if (scope === "global" || scope === "both") targets.push({ name: config.globalMemoryInstance, label: "Global" });

				rec.step("input_params", { input: { scope } });
				rec.step("resolve_targets", { output: { targets } });

				const sections: string[] = [];
				let total = 0;

				for (const t of targets) {
					const tList = Date.now();
					try {
						const res = await client.listMemories(t.name, signal);
						total += res.count;
						if (res.count === 0) {
							sections.push(`[${t.label}] No memories stored.`);
						} else {
							const items = res.items.map((i) => `  • ${i.key} (${i.status})`);
							sections.push(`[${t.label}] ${res.count} memorie(s):\n${items.join("\n")}`);
						}
						rec.step("cloudflare_list", {
							input: { instance: t.name, label: t.label },
							output: { count: res.count },
							durationMs: Date.now() - tList,
						});
					} catch {
						sections.push(`[${t.label}] Failed to fetch memories.`);
						rec.step("cloudflare_list", {
							input: { instance: t.name, label: t.label },
							error: "Failed to fetch",
							durationMs: Date.now() - tList,
						});
					}
				}

				const text = sections.join("\n\n");
				rec.step("final_output", { output: { totalCount: total } });
				rec.success();

				return {
					content: [{ type: "text", text }],
					details: { scope, total } as Record<string, unknown>,
				};
			} catch (err) {
				rec.error(err instanceof Error ? err.message : String(err));
				throw err;
			}
		},
	});
}
