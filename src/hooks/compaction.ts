/**
 * Compaction hook — Ingest conversation into memory on compaction.
 * Also opportunistically refreshes the manifest (T4 trigger).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import { refreshManifest } from "../manifest.js";

export function registerCompactionHook(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
) {
	pi.on("session_before_compact", async (event, ctx) => {
		const client = getClient();
		const config = getConfig();
		if (!client || !config || !config.hooks.autoIngest) return;

		const { preparation } = event;
		const { messagesToSummarize } = preparation;
		if (messagesToSummarize.length === 0) return;

		// Extract a summary of the conversation to store as a memory
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

		if (parts.length < 2) return;

		// Store the compaction summary as a memory document
		const summary = `Session compaction summary (${new Date().toISOString()}):\n\n${parts.join("\n\n")}`;

		try {
			await client.remember(config.projectMemoryInstance, summary, { type: "compaction" });
			ctx.ui.setStatus("memory-ingest", ctx.ui.theme.fg("success", `🧠 Ingested ${parts.length} msgs`));
			setTimeout(() => ctx.ui.setStatus("memory-ingest", undefined), 5000);

			// T4: opportunistic manifest refresh.
			if (
				config.features.manifest.enabled &&
				config.features.manifest.autoUpdateOnCompaction &&
				config.projectId
			) {
				refreshManifest(client, config).catch(() => {
					// best-effort; don't disturb the user
				});
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Unknown error";
			ctx.ui.notify(`Memory ingest failed: ${msg}`, "warning");
		}
	});
}
