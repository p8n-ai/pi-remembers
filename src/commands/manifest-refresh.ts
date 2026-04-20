/**
 * /memory-manifest-refresh — Manually rebuild and publish the current project's
 * manifest record (T5 trigger).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import { refreshManifest, listDirty } from "../manifest.js";

export function registerManifestRefreshCommand(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
) {
	pi.registerCommand("memory-manifest-refresh", {
		description:
			"Rebuild and publish the current project's manifest record (for cross-project discovery). Use --status to inspect dirty projects.",
		handler: async (args, ctx) => {
			const client = getClient();
			const config = getConfig();
			if (!client || !config) {
				ctx.ui.notify("Not configured. Run /memory-setup first.", "error");
				return;
			}

			const flag = args.trim().split(/\s+/)[0] ?? "";

			if (flag === "--status" || flag === "status") {
				const dirty = listDirty();
				const lines = [
					`Manifest enabled: ${config.features.manifest.enabled}`,
					`Instance: ${config.features.manifest.instanceId}`,
					`Debounce window: ${config.features.manifest.debounceMs}ms`,
					`TTL: ${config.features.manifest.ttlDays}d`,
					`Triggers: onWrite=${config.features.manifest.autoUpdateOnWrite} onSessionEnd=${config.features.manifest.autoUpdateOnSessionEnd} onAgentStartTTL=${config.features.manifest.autoUpdateOnAgentStartTTL} onCompaction=${config.features.manifest.autoUpdateOnCompaction}`,
					`Dirty projects: ${dirty.length > 0 ? dirty.join(", ") : "(none)"}`,
				];
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			if (!config.features.manifest.enabled) {
				ctx.ui.notify(
					"Manifest is disabled. Enable via features.manifest.enabled=true in ~/.pi/pi-remembers.json.",
					"warning",
				);
				return;
			}
			if (!config.projectId) {
				ctx.ui.notify(
					"Current project has no stable id (legacy mode). Run /memory-project --init first.",
					"warning",
				);
				return;
			}

			try {
				ctx.ui.notify("Refreshing manifest…", "info");
				const rec = await refreshManifest(client, config);
				if (rec) {
					ctx.ui.notify(
						`✓ Manifest published for "${rec.name}" (${rec.id}) — ${rec.memoryCount} memories, ${rec.topics.length} topics`,
						"info",
					);
				} else {
					ctx.ui.notify("Nothing to refresh.", "info");
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Manifest refresh failed: ${msg}`, "error");
			}
		},
	});
}
