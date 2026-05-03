/**
 * /memory-stats — Launch the pipeline observability dashboard.
 * /memory-stats-stop — Shut down the dashboard server.
 */

import { exec } from "node:child_process";
import { platform } from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ResolvedConfig } from "../config.js";
import type { StatsLogger } from "../stats/logger.js";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import { startStatsServer, type StatsServer } from "../stats/server.js";

let activeServer: StatsServer | null = null;

function openBrowser(url: string) {
	const cmd =
		platform() === "darwin"
			? `open "${url}"`
			: platform() === "win32"
				? `start "${url}"`
				: `xdg-open "${url}"`;
	exec(cmd, () => {
		/* best-effort */
	});
}

export function registerStatsCommand(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
	getLogger: () => StatsLogger | null,
) {
	pi.registerCommand("memory-stats", {
		description: "Open the Pi Remembers pipeline observability dashboard in your browser",
		handler: async (_args, ctx) => {
			const logger = getLogger();
			if (!logger) {
				ctx.ui.notify(
					"Stats logging is not enabled. Ensure stats.enabled is true in your config and restart the session.",
					"warning",
				);
				return;
			}

			// If server already running, just re-open browser
			if (activeServer) {
				openBrowser(activeServer.url);
				ctx.ui.notify(`📊 Dashboard already running at ${activeServer.url}`, "info");
				return;
			}

			try {
				activeServer = await startStatsServer(logger, getClient, getConfig);
				openBrowser(activeServer.url);
				ctx.ui.notify(
					`📊 Memory Stats dashboard at ${activeServer.url}\nRun /memory-stats-stop to close.`,
					"info",
				);

				// Clean up reference when server closes
				activeServer.server.on("close", () => {
					activeServer = null;
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to start stats server: ${msg}`, "error");
			}
		},
	});

	pi.registerCommand("memory-stats-stop", {
		description: "Stop the Pi Remembers dashboard server",
		handler: async (_args, ctx) => {
			if (!activeServer) {
				ctx.ui.notify("No dashboard server running.", "info");
				return;
			}
			try {
				await activeServer.close();
				activeServer = null;
				ctx.ui.notify("📊 Dashboard server stopped.", "info");
			} catch {
				activeServer = null;
				ctx.ui.notify("Dashboard server stopped (with errors).", "warning");
			}
		},
	});
}
