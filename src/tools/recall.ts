/**
 * memory_recall tool — Search memories for context about a topic.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";

export function registerRecallTool(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
) {
	pi.registerTool({
		name: "memory_recall",
		label: "Memory Recall",
		description:
			"Search persistent memories for context about a topic. Returns relevant chunks from past sessions. Use when you need to remember past decisions, preferences, or project context.",
		promptSnippet: "Search persistent memories (past sessions, decisions, preferences) for context",
		promptGuidelines: [
			"Use memory_recall proactively when starting work to check for relevant past context.",
			"Use memory_recall when the user references past decisions or asks 'do you remember...'",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to search for in memories (natural language)" }),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("global"), Type.Literal("both")], {
					description: "Search scope: 'project', 'global', or 'both' (default)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const client = getClient();
			const config = getConfig();
			if (!client || !config) throw new Error("Not configured. Run /memory-setup first.");

			const scope = params.scope ?? "both";
			const instances: string[] = [];
			if (scope === "project" || scope === "both") instances.push(config.projectMemoryInstance);
			if (scope === "global" || scope === "both") instances.push(config.globalMemoryInstance);

			const result = await client.recall(instances, params.query, signal);

			if (result.count === 0) {
				return {
					content: [{ type: "text", text: "No relevant memories found." }],
					details: { query: params.query, scope, count: 0 },
				};
			}

			const lines: string[] = [`Found ${result.count} relevant memory chunk(s):\n`];
			for (const chunk of result.chunks) {
				const src = chunk.instance_id ?? "memory";
				lines.push(`[${src}] (score: ${chunk.score.toFixed(2)}) ${chunk.text}`);
				lines.push("");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { query: params.query, scope, count: result.count } as Record<string, unknown>,
			};
		},
	});
}
