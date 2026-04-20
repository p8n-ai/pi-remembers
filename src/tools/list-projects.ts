/**
 * memory_list_projects tool — Enumerate known projects from the registry.
 *
 * Returns identity metadata only (id, name, aliases, lastSeen). Enables the
 * LLM to discover what projects exist before issuing a cross-project recall.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { ResolvedConfig } from "../config.js";
import { loadRegistry, listProjects } from "../registry.js";

export function registerListProjectsTool(
	pi: ExtensionAPI,
	getConfig: () => ResolvedConfig | null,
) {
	pi.registerTool({
		name: "memory_list_projects",
		label: "Memory List Projects",
		description:
			"List projects known to Pi Remembers (from the local registry). " +
			"Use to discover which projects can be searched via memory_recall's `projects` parameter.",
		promptSnippet: "List known projects (cross-project memory discovery)",
		promptGuidelines: [
			"Call memory_list_projects when the user asks about 'another project' or 'project X' to find its id/name.",
			"Use results to pass ids or names into memory_recall({ projects: [...] }) for cross-project reads.",
		],
		parameters: Type.Object({}),

		async execute(_toolCallId) {
			const config = getConfig();
			if (!config) throw new Error("Not configured. Run /memory-setup first.");

			const reg = loadRegistry();
			const projects = listProjects(reg);

			if (projects.length === 0) {
				return {
					content: [
						{
							type: "text",
							text:
								"No projects in the local registry yet. The registry populates as sessions touch their projects.",
						},
					],
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
		},
	});
}
