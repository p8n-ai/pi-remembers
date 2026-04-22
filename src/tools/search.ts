/**
 * memory_search tool — Search indexed project files via Cloudflare AI Search.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import { synthesize } from "../subagent/synthesizer.js";
export function registerSearchTool(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
) {
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search indexed project files and docs using hybrid vector + keyword search. Files must be indexed first via /memory-index.",
		promptSnippet: "Search indexed project files/docs using hybrid vector+keyword search",
		promptGuidelines: [
			"Use memory_search to find specific info across project files.",
			"If search returns no results, suggest running /memory-index.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query — natural language or keywords" }),
		}),

		async execute(_toolCallId, params, signal) {
			const client = getClient();
			const config = getConfig();
			if (!client || !config) throw new Error("Not configured. Run /memory-setup first.");

			const result = await client.search(config.searchInstance, params.query, signal);

			if (result.count === 0) {
				return {
					content: [{ type: "text", text: "No results found. Project files may not be indexed. Suggest running /memory-index." }],
					details: { query: params.query, count: 0 } as Record<string, unknown>,
				};
			}
			// Build raw text from chunks
			const rawText = result.chunks
				.map((c) => `--- ${c.item.key} (score: ${c.score.toFixed(2)}) ---\n${c.text}`)
				.join("\n\n");

			// Synthesize if enabled
			const subagentCfg = config.features.subagent;
			if (subagentCfg.enabled) {
				const synthesis = await synthesize({
					query: params.query,
					rawText,
					model: subagentCfg.model,
					thinking: subagentCfg.thinking,
					timeoutMs: subagentCfg.timeoutMs,
					maxOutputChars: subagentCfg.maxOutputChars,
					signal,
				});

				if (synthesis.success) {
					return {
						content: [{ type: "text", text: synthesis.text }],
						details: {
							query: params.query,
							count: result.count,
							synthesized: true,
							synthesisDurationMs: synthesis.durationMs,
						} as Record<string, unknown>,
					};
				}
				// Synthesis failed — fall through to raw output
			}

			// Raw output (fallback or synthesis disabled)
			const lines: string[] = [`Found ${result.count} result(s):\n`];
			for (const chunk of result.chunks) {
				lines.push(`--- ${chunk.item.key} (score: ${chunk.score.toFixed(2)}) ---`);
				lines.push(chunk.text);
				lines.push("");
			}

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: { query: params.query, count: result.count } as Record<string, unknown>,
			};
		},
	});
}
