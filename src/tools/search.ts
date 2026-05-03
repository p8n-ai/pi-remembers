/**
 * memory_search tool — Search indexed project files/docs using hybrid vector+keyword search.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import { synthesize } from "../subagent/synthesizer.js";
import type { StatsLogger } from "../stats/logger.js";
import { createRecorder } from "../stats/recorder.js";

export function registerSearchTool(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
	getLogger: (() => StatsLogger | null) | null,
) {
	pi.registerTool({
		name: "memory_search",
		label: "Memory Search",
		description:
			"Search indexed project files and docs using hybrid vector + keyword search. " +
			'Files must be indexed first via /memory-index.',
		promptSnippet: "Search indexed project files/docs using hybrid vector+keyword search",
		parameters: Type.Object({
			query: Type.String({ description: "Search query — natural language or keywords" }),
		}),

		async execute(_toolCallId, params, signal) {
			const config = getConfig();
			const rec = createRecorder(getLogger?.() ?? null, "search", {
				query: params.query,
				projectId: config?.projectId,
				projectName: config?.projectName,
			});

			try {
				const client = getClient();
				if (!client || !config) throw new Error("Not configured. Run /memory-setup first.");

				rec.step("input_params", { input: { query: params.query } });

				// Cloudflare search
				const tSearch = Date.now();
				const result = await client.search(config.searchInstance, params.query, signal);
				rec.step("cloudflare_search", {
					input: { instance: config.searchInstance, query: params.query },
					output: { chunkCount: result.count },
					durationMs: Date.now() - tSearch,
				});

				if (result.count === 0) {
					const text = "No results found. Project files may not be indexed. Suggest running /memory-index.";
					rec.step("final_output", { output: { text, synthesized: false } });
					rec.success();
					return {
						content: [{ type: "text", text }],
						details: { query: params.query, count: 0 } as Record<string, unknown>,
					};
				}

				// Filter by search-specific minChunkScore (separate from recall)
				const minChunkScore = config.features.search.minChunkScore;
				const allChunks = result.chunks;
				const filteredChunks = allChunks.filter((c) => c.score >= minChunkScore);
				const droppedCount = allChunks.length - filteredChunks.length;

				const scores = filteredChunks.map((c) => c.score);
				const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;

				const rawText = filteredChunks
					.map((c) => `--- ${c.item.key} (score: ${c.score.toFixed(2)}) ---\n${c.text}`)
					.join("\n\n");

				rec.step("raw_chunks", {
					output: {
						chunks: allChunks.map((c) => ({
							key: c.item.key,
							score: c.score,
							textLength: c.text.length,
							filtered: c.score < minChunkScore,
						})),
					},
					metadata: {
						keptCount: filteredChunks.length,
						droppedCount,
						minChunkScore,
						avgScore: scores.length > 0 ? +avgScore.toFixed(3) : 0,
					},
				});

				// If all chunks filtered out
				if (filteredChunks.length === 0) {
					const text = `No results above score threshold ${minChunkScore}. ${allChunks.length} chunk(s) were below threshold. Try lowering features.search.minChunkScore or running /memory-index.`;
					rec.step("final_output", { output: { text, synthesized: false }, metadata: { allDropped: true } });
					rec.success();
					return {
						content: [{ type: "text", text }],
						details: { query: params.query, count: 0, droppedCount } as Record<string, unknown>,
					};
				}

				// Synthesize if enabled
				const subagentCfg = config.features.subagent;
				if (subagentCfg.enabled) {
					rec.step("synthesis_config", { input: { enabled: true, model: subagentCfg.model } });

					const synthesis = await synthesize({
						query: params.query,
						rawText,
						model: subagentCfg.model,
						thinking: subagentCfg.thinking,
						timeoutMs: subagentCfg.timeoutMs,
						maxOutputChars: subagentCfg.maxOutputChars,
						signal,
					});

					rec.step("synthesis_llm_call", {
						input: { taskPromptLength: synthesis.taskPrompt.length },
						output: { outputLength: synthesis.rawStdout.length },
						durationMs: synthesis.durationMs,
						metadata: { success: synthesis.success, timedOut: synthesis.timedOut, exitCode: synthesis.exitCode },
					});

					if (synthesis.success) {
						rec.step("final_output", { output: { synthesized: true, textLength: synthesis.text.length } });
						rec.success();
						return {
							content: [{ type: "text", text: synthesis.text }],
							details: {
								query: params.query, count: result.count,
								synthesized: true, synthesisDurationMs: synthesis.durationMs,
							} as Record<string, unknown>,
						};
					}
					// Synthesis failed — fall through to raw output
				} else {
					rec.step("synthesis_config", { input: { enabled: false }, metadata: { skippedReason: "synthesis_disabled" } });
				}

				// Raw output (fallback or synthesis disabled)
				const lines: string[] = [`Found ${filteredChunks.length} result(s):\n`];
				for (const chunk of filteredChunks) {
					lines.push(`--- ${chunk.item.key} (score: ${chunk.score.toFixed(2)}) ---`);
					lines.push(chunk.text);
					lines.push("");
				}

				rec.step("final_output", { output: { synthesized: false, chunkCount: filteredChunks.length } });
				rec.success();

				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: { query: params.query, count: result.count } as Record<string, unknown>,
				};
			} catch (err) {
				rec.error(err instanceof Error ? err.message : String(err));
				throw err;
			}
		},
	});
}
