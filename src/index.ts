/**
 * Pi Remembers — The North Remembers.
 *
 * Persistent memory and search for the Pi coding agent,
 * powered by Cloudflare AI Search.
 *
 * Setup:
 *   1. pi install npm:@p8n.ai/pi-remembers
 *   2. /memory-setup
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CloudflareApiClient } from "./cloudflare/api-client.js";
import { resolveConfig, type ResolvedConfig } from "./config.js";

// Tools
import { registerRecallTool } from "./tools/recall.js";
import { registerRememberTool } from "./tools/remember.js";
import { registerSearchTool } from "./tools/search.js";
import { registerListTool } from "./tools/list.js";

// Hooks
import { registerCompactionHook } from "./hooks/compaction.js";
import { registerAgentStartHook } from "./hooks/agent-start.js";
import { updateMemoryStatus } from "./hooks/session.js";

// Commands
import { registerSetupCommand } from "./commands/setup.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerIndexCommand } from "./commands/index-project.js";
import { registerSettingsCommand } from "./commands/settings.js";

export default function piRemembersExtension(pi: ExtensionAPI) {
	let config: ResolvedConfig | null = null;
	let client: CloudflareApiClient | null = null;
	let lastCwd = ".";

	const getConfig = (): ResolvedConfig | null => config;
	const getClient = (): CloudflareApiClient | null => client;

	function initClients(cwd: string) {
		lastCwd = cwd;
		config = resolveConfig(cwd);
		if (!config) { client = null; return; }
		client = new CloudflareApiClient({
			accountId: config.accountId,
			apiToken: config.apiToken,
			namespace: config.namespace,
		});
	}

	// Commands
	registerSetupCommand(pi, () => { initClients(lastCwd); });
	registerStatusCommand(pi, getClient, getConfig);
	registerIndexCommand(pi, getClient, getConfig);
	registerSettingsCommand(pi, getConfig, () => { initClients(lastCwd); });

	// Tools
	registerRecallTool(pi, getClient, getConfig);
	registerRememberTool(pi, getClient, getConfig);
	registerSearchTool(pi, getClient, getConfig);
	registerListTool(pi, getClient, getConfig);

	// Hooks
	registerCompactionHook(pi, getClient, getConfig);
	registerAgentStartHook(pi, getClient, getConfig);

	// Session lifecycle
	pi.on("session_start", async (_event, ctx) => {
		initClients(ctx.cwd);
		updateMemoryStatus(ctx, config);
	});

	pi.on("session_tree", async (_event, ctx) => {
		initClients(ctx.cwd);
		updateMemoryStatus(ctx, config);
	});
}
