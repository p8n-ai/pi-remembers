/**
 * session_before_compact hook — auto-ingest compacted conversation as a memory.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import { refreshManifest } from "../manifest.js";
import type { StatsLogger } from "../stats/logger.js";
import { createRecorder } from "../stats/recorder.js";

export function registerCompactionHook(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
	getLogger: (() => StatsLogger | null) | null,
) {
	pi.on("session_before_compact", async (event, ctx) => {
		const client = getClient();
		const config = getConfig();
		if (!client || !config || !config.hooks.autoIngest) return;

		const rec = createRecorder(getLogger?.() ?? null, "compaction_ingest", {
			projectId: config.projectId,
			projectName: config.projectName,
		});

		try {
			const { preparation } = event;
			const { messagesToSummarize } = preparation;

			if (messagesToSummarize.length === 0) {
				rec.step("hook_config", { input: { autoIngest: true }, metadata: { skippedReason: "no_messages" } });
				rec.skip();
				return;
			}

			// Extract messages
			const parts: string[] = [];
			for (const m of messagesToSummarize) {
				if (m.role !== "user" && m.role !== "assistant") continue;
				const text =
					typeof m.content === "string"
						? m.content
						: Array.isArray(m.content)
							? m.content
									.filter((c): c is { type: "text"; text: string } => c.type === "text")
									.map((c) => c.text)
									.join("\n")
							: "";
				if (text.length > 0) {
					parts.push(`[${m.role}] ${text.slice(0, 500)}`);
				}
			}

			if (parts.length < 2) {
				rec.step("extract_messages", {
					input: { totalMessages: messagesToSummarize.length },
					metadata: { skippedReason: "too_few_parts" },
				});
				rec.skip();
				return;
			}

			const summary = `Session compaction summary (${new Date().toISOString()}):\n\n${parts.join("\n\n")}`;
			rec.step("extract_messages", {
				input: { totalMessages: messagesToSummarize.length },
				output: { extractedParts: parts.length, summaryLength: summary.length },
			});

			// Upload to Cloudflare
			const tUpload = Date.now();
			const res = await client.remember(config.projectMemoryInstance, summary, { type: "compaction" });
			rec.step("cloudflare_upload", {
				input: { instance: config.projectMemoryInstance, contentLength: summary.length },
				output: { id: res.id, key: res.key, status: res.status },
				durationMs: Date.now() - tUpload,
			});

			ctx.ui.setStatus("memory-ingest", ctx.ui.theme.fg("success", `🧠 Ingested ${parts.length} msgs`));
			setTimeout(() => ctx.ui.setStatus("memory-ingest", undefined), 5000);

			// Manifest refresh
			if (
				config.features.manifest.enabled &&
				config.features.manifest.autoUpdateOnCompaction &&
				config.projectId
			) {
				const tManifest = Date.now();
				try {
					await refreshManifest(client, config);
					rec.step("manifest_refresh", {
						input: { enabled: true, projectId: config.projectId },
						output: { success: true },
						durationMs: Date.now() - tManifest,
					});
				} catch (mErr) {
					rec.step("manifest_refresh", {
						input: { enabled: true, projectId: config.projectId },
						output: { success: false },
						durationMs: Date.now() - tManifest,
						error: mErr instanceof Error ? mErr.message : String(mErr),
					});
				}
			} else {
				rec.step("manifest_refresh", { input: { enabled: false } });
			}

			rec.success();
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			ctx.ui.notify(`Memory ingest failed: ${msg}`, "warning");
			rec.error(msg);
		}
	});
}
