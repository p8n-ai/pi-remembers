/**
 * memory_remember tool — Store a persistent memory.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import type { Debouncer } from "../manifest.js";
import type { StatsLogger } from "../stats/logger.js";
import { createRecorder } from "../stats/recorder.js";

export function registerRememberTool(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
	debouncer?: Debouncer,
	getLogger: (() => StatsLogger | null) | null = null,
) {
	pi.registerTool({
		name: "memory_remember",
		label: "Memory Remember",
		description:
			"Store an important fact, decision, preference, or instruction as a persistent memory for future sessions.",
		promptSnippet: "Store a fact, decision, or preference as a persistent memory",
		promptGuidelines: [
			"Use memory_remember when the user states a preference or makes an important decision.",
			"Use memory_remember for architectural decisions, coding conventions, or project patterns.",
			"Store memories as clear, atomic statements.",
		],
		parameters: Type.Object({
			content: Type.String({ description: "The memory to store — a clear, self-contained statement" }),
			scope: Type.Optional(
				Type.Union([Type.Literal("project"), Type.Literal("global")], {
					description: "'project' (default) or 'global' (user-wide preference)",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const config = getConfig();
			const rec = createRecorder(getLogger?.() ?? null, "remember", {
				query: params.content,
				scope: params.scope ?? "project",
				projectId: config?.projectId,
				projectName: config?.projectName,
			});

			try {
				const client = getClient();
				if (!client || !config) throw new Error("Not configured. Run /memory-setup first.");

				const scope = params.scope ?? "project";
				const instance = scope === "global" ? config.globalMemoryInstance : config.projectMemoryInstance;

				rec.step("input_params", { input: { content: params.content, scope } });
				rec.step("resolve_instance", { input: { scope }, output: { instance } });

				const t1 = Date.now();
				const res = await client.remember(instance, params.content, { scope }, signal);
				rec.step("cloudflare_upload", {
					input: { instance, contentLength: params.content.length },
					output: { id: res.id, key: res.key, status: res.status },
					durationMs: Date.now() - t1,
				});

				// T1 write-through: schedule debounced manifest refresh for project writes.
				const scheduled = !!(scope === "project" && config.projectId && debouncer);
				if (scheduled) {
					debouncer!.schedule(config.projectId!);
				}
				rec.step("manifest_schedule", { output: { scheduled }, metadata: { projectId: config.projectId } });

				const text = `✓ Remembered (${scope}): ${params.content}`;
				rec.step("final_output", { output: { text } });
				rec.success();

				return {
					content: [{ type: "text", text }],
					details: { content: params.content, scope, id: res.id } as Record<string, unknown>,
				};
			} catch (err) {
				rec.error(err instanceof Error ? err.message : String(err));
				throw err;
			}
		},
	});
}
