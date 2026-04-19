/**
 * /memory-status — Show connection status, hook states, and statistics.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import { globalConfigPath, projectConfigPath } from "../config.js";

export function registerStatusCommand(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
) {
	pi.registerCommand("memory-status", {
		description: "Show Pi Remembers connection status, hook states, and statistics",
		handler: async (_args, ctx) => {
			const config = getConfig();
			if (!config) {
				ctx.ui.notify(
					`Memory not configured.\n  Global: ${globalConfigPath()} (missing)\n  Project: ${projectConfigPath(ctx.cwd)} (missing)\n\nRun /memory-setup to configure.`,
					"warning",
				);
				return;
			}

			const lines: string[] = [
				"🧠 Pi Remembers Status",
				"",
				`Account ID: ${config.accountId.slice(0, 8)}...`,
				`Namespace: ${config.namespace}`,
				`Global Memory: ${config.globalMemoryInstance}`,
				`Project Memory: ${config.projectMemoryInstance}`,
				`Search Instance: ${config.searchInstance}`,
				"",
				"Hooks:",
				`  ${config.hooks.autoRecall ? "✓" : "○"} Smart Context Recall (autoRecall)`,
				`  ${config.hooks.autoIngest ? "✓" : "○"} Compaction Ingest (autoIngest)`,
				`  ${config.hooks.showStatus ? "✓" : "○"} Footer Status (showStatus)`,
				"",
			];

			const client = getClient();
			if (client) {
				const valid = await client.validate();
				lines.push(`API: ${valid.valid ? "✓ connected" : "✗ " + (valid.error ?? "unreachable")}`);

				if (valid.valid) {
					try {
						const projMems = await client.listMemories(config.projectMemoryInstance);
						lines.push(`Project memories: ${projMems.count}`);
					} catch { lines.push("Project memories: unable to fetch"); }

					try {
						const globalMems = await client.listMemories(config.globalMemoryInstance);
						lines.push(`Global memories: ${globalMems.count}`);
					} catch { lines.push("Global memories: unable to fetch"); }

					try {
						const items = await client.listItems(config.searchInstance);
						lines.push(`Indexed files: ${items.count}`);
					} catch { lines.push("Indexed files: unable to count"); }
				}
			}

			lines.push("");
			lines.push("Use /memory-settings to toggle hooks.");

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
