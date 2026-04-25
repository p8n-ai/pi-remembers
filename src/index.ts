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
import { resolveConfig, statsDbPath, type ResolvedConfig } from "./config.js";
import { touchProject } from "./registry.js";
import { createDebouncer, type Debouncer } from "./manifest.js";
import { StatsLogger } from "./stats/logger.js";
// Tools
import { registerRecallTool } from "./tools/recall.js";
import { registerRememberTool } from "./tools/remember.js";
import { registerSearchTool } from "./tools/search.js";
import { registerListTool } from "./tools/list.js";
import { registerListProjectsTool } from "./tools/list-projects.js";

// Hooks
import { registerCompactionHook } from "./hooks/compaction.js";
import { registerAgentStartHook } from "./hooks/agent-start.js";
import { updateMemoryStatus } from "./hooks/session.js";

// Commands
import { registerSetupCommand } from "./commands/setup.js";
import { registerStatusCommand } from "./commands/status.js";
import { registerIndexCommand } from "./commands/index-project.js";
import { registerSettingsCommand } from "./commands/settings.js";
import { registerProjectCommand } from "./commands/project.js";
import { registerManifestRefreshCommand } from "./commands/manifest-refresh.js";
import { registerStatsCommand } from "./commands/stats.js";

export default function piRemembersExtension(pi: ExtensionAPI) {
	let config: ResolvedConfig | null = null;
	let client: CloudflareApiClient | null = null;
	let logger: StatsLogger | null = null;
	let lastCwd = ".";

	const getConfig = (): ResolvedConfig | null => config;
	const getClient = (): CloudflareApiClient | null => client;

	// Debouncer (Phase 3) — shared across tools; reads config lazily via getters.
	const debouncer: Debouncer = createDebouncer(getClient, getConfig);

	function initClients(cwd: string) {
		lastCwd = cwd;
		config = resolveConfig(cwd);
		if (!config) {
			client = null;
			return;
		}
		client = new CloudflareApiClient({
			accountId: config.accountId,
			apiToken: config.apiToken,
			namespace: config.namespace,
		});

		// Maintain registry (Phase 1)
		if (config.features.identity.registryEnabled && config.projectId) {
			try {
				touchProject({
					id: config.projectId,
					name: config.projectName,
					aliases: config.projectAliases,
					root: config.projectRoot,
					memoryInstance: config.projectMemoryInstance,
					workspace: config.workspace ?? undefined,
				});
			} catch {
				// best-effort
			}
		}
		// Initialize stats logger (once)
		if (!logger && config.features.stats.enabled) {
			try {
				logger = new StatsLogger(statsDbPath());
			} catch {
				// best-effort — stats are optional
			}
		}
	}

	// Commands
	registerSetupCommand(pi, () => {
		initClients(lastCwd);
	});
	registerStatusCommand(pi, getClient, getConfig);
	registerIndexCommand(pi, getClient, getConfig);
	registerSettingsCommand(pi, getConfig, () => {
		initClients(lastCwd);
	});
	registerProjectCommand(pi, getConfig, () => {
		initClients(lastCwd);
	});
	registerManifestRefreshCommand(pi, getClient, getConfig);

	// Logger getter — logger is initialized lazily in initClients()
	const getLogger = (): StatsLogger | null => logger;
	registerStatsCommand(pi, getClient, getConfig, getLogger);

	// Tools
	registerRecallTool(pi, getClient, getConfig, getLogger);
	registerRememberTool(pi, getClient, getConfig, debouncer, getLogger);
	registerSearchTool(pi, getClient, getConfig, getLogger);
	registerListTool(pi, getClient, getConfig, getLogger);
	registerListProjectsTool(pi, getConfig, getLogger);

	// Hooks
	registerCompactionHook(pi, getClient, getConfig, getLogger);
	registerAgentStartHook(pi, getClient, getConfig, getLogger);

	/**
	 * Ensure project-specific AI Search instances exist.
	 * Runs in the background — doesn't block session start.
	 */
	async function ensureProjectInstances() {
		if (!client || !config) return;
		try {
			const tasks: Promise<unknown>[] = [
				client.ensureInstance(config.projectMemoryInstance),
				client.ensureInstance(config.searchInstance),
			];
			if (config.features.manifest.enabled) {
				tasks.push(client.ensureInstance(config.features.manifest.instanceId));
			}
			await Promise.all(tasks);
		} catch {
			// Best-effort — instances may already exist or API may be unreachable
		}
	}

	// Session lifecycle
	pi.on("session_start", async (_event, ctx) => {
		initClients(ctx.cwd);
		updateMemoryStatus(ctx, config);
		// Prune old stats (7-day TTL)
		if (logger) {
			try { logger.prune(); } catch { /* best-effort */ }
		}
		ensureProjectInstances();
	});

	pi.on("session_tree", async (_event, ctx) => {
		initClients(ctx.cwd);
		updateMemoryStatus(ctx, config);
	});

	// T2: session-end flush — write-through any pending manifest updates.
	pi.on("session_shutdown", async () => {
		// Close stats logger
		if (logger) {
			try { logger.close(); } catch { /* best-effort */ }
			logger = null;
		}
		if (!config || !client) return;
		if (!config.features.manifest.enabled) return;
		if (!config.features.manifest.autoUpdateOnSessionEnd) return;
		try {
			await debouncer.flushAll();
		} catch {
			// best-effort; shutdown must not throw
		}
	});
}
