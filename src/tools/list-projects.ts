/**
 * memory_list_projects tool — List known projects from the local registry.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ResolvedConfig } from "../config.js";
import { loadRegistry, listProjects } from "../registry.js";
import type { StatsLogger } from "../stats/logger.js";
import { createRecorder } from "../stats/recorder.js";

export function registerListProjectsTool(
	pi: ExtensionAPI,
	getConfig: () => ResolvedConfig | null,
	getLogger: (() => StatsLogger | null) | null,
) {
	pi.registerTool({
		name: "memory_list_projects",
		label: "Memory List Projects",
		description:
			"List projects known to Pi Remembers (from the local registry). " +
			"Use to discover which projects can be searched via memory_recall's `projects` parameter.",
		promptSnippet:
			"List known projects (cross-project memory discovery)",
		parameters: Type.Object({}),

		async execute(_toolCallId) {
			const config = getConfig();
			const rec = createRecorder(getLogger?.() ?? null, "list_projects", {
				projectId: config?.projectId,
				projectName: config?.projectName,
			});

			try {
				if (!config) throw new Error("Not configured. Run /memory-setup first.");

				const reg = loadRegistry();
				const projects = listProjects(reg);

				rec.step("load_registry", { output: { projectCount: projects.length } });

				if (projects.length === 0) {
					const text = "No projects in the local registry yet. The registry populates as sessions touch their projects.";
					rec.step("final_output", { output: { count: 0 } });
					rec.success();
					return {
						content: [{ type: "text", text }],
						details: { count: 0 } as Record<string, unknown>,
					};
				}

				const lines: string[] = [`${projects.length} known project(s):\n`];
				for (const p of projects) {
					const aliases = p.aliases.length > 0 ? ` [${p.aliases.join(", ")}]` : "";
					const current = p.id === config.projectId ? " (current)" : "";
					lines.push(`• ${p.name}${aliases} — ${p.id}${current}`);
					lines.push(`    lastSeen: ${p.lastSeen}`);
					if (p.workspace) lines.push(`    workspace: ${p.workspace}`);
				}

				rec.step("final_output", { output: { count: projects.length } });
				rec.success();

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						count: projects.length,
						currentProjectId: config.projectId,
						projects: projects.map((p) => ({
							id: p.id,
							name: p.name,
							aliases: p.aliases,
							lastSeen: p.lastSeen,
							workspace: p.workspace,
						})),
					} as Record<string, unknown>,
				};
			} catch (err) {
				rec.error(err instanceof Error ? err.message : String(err));
				throw err;
			}
		},
	});
}
