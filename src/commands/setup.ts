/**
 * /memory-setup — Guided setup for Cloudflare AI Search integration.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CloudflareApiClient } from "../cloudflare/api-client.js";
import {
	loadGlobalConfig,
	loadProjectConfig,
	saveGlobalConfig,
	saveProjectConfig,
	deriveProjectName,
	globalConfigPath,
	projectConfigPath,
} from "../config.js";
import type { GlobalConfig, ProjectConfig } from "../config.js";

export function registerSetupCommand(pi: ExtensionAPI, onConfigured: () => void) {
	pi.registerCommand("memory-setup", {
		description: "Set up Cloudflare AI Search integration (Account ID, API Token, namespace)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/memory-setup requires interactive mode", "error");
				return;
			}

			const existing = loadGlobalConfig();

			// Step 1: Account ID
			const accountId = await ctx.ui.input(
				"Cloudflare Account ID:",
				existing?.accountId ?? "",
			);
			if (!accountId?.trim()) { ctx.ui.notify("Setup cancelled.", "warning"); return; }

			// Step 2: API Token
			ctx.ui.notify(
				"You need a Cloudflare API Token with these permissions:\n" +
				"  • Account > AI Search:Edit\n" +
				"  • Account > AI Search:Run\n\n" +
				"Create one at: https://dash.cloudflare.com/profile/api-tokens\n\n" +
				"You can enter the token directly, or an env var name (e.g. CLOUDFLARE_API_TOKEN).",
				"info",
			);

			const apiToken = await ctx.ui.input(
				"API Token (or env var name like CLOUDFLARE_API_TOKEN):",
				existing?.apiToken ?? "CLOUDFLARE_API_TOKEN",
			);
			if (!apiToken?.trim()) { ctx.ui.notify("Setup cancelled.", "warning"); return; }

			// Resolve token for validation
			const resolvedToken = /^[A-Z][A-Z0-9_]+$/.test(apiToken.trim()) && process.env[apiToken.trim()]
				? process.env[apiToken.trim()]!
				: apiToken.trim();

			// Step 3: Validate
			ctx.ui.notify("Validating credentials...", "info");
			const testClient = new CloudflareApiClient({
				accountId: accountId.trim(),
				apiToken: resolvedToken,
				namespace: "default",
			});
			const validation = await testClient.validate();
			if (!validation.valid) {
				ctx.ui.notify(`Invalid credentials: ${validation.error}\nCheck your Account ID and API Token.`, "error");
				return;
			}
			ctx.ui.notify("✓ Credentials valid!", "info");

			// Step 4: Namespace
			const nsChoice = await ctx.ui.select("AI Search namespace:", [
				"default — use the built-in default namespace (simplest, no extra setup)",
				"pi-remembers — dedicated namespace (cleaner separation, recommended for teams)",
			]);
			if (!nsChoice) { ctx.ui.notify("Setup cancelled.", "warning"); return; }
			const namespace = nsChoice.startsWith("default") ? "default" : "pi-remembers";

			// Step 5: Create instances
			const client = new CloudflareApiClient({
				accountId: accountId.trim(),
				apiToken: resolvedToken,
				namespace,
			});

			const globalInstance = existing?.globalMemoryInstance ?? "pi-remembers-global";
			ctx.ui.notify(`Ensuring global memory instance "${globalInstance}"...`, "info");
			await client.ensureInstance(globalInstance);

			const globalConfig: GlobalConfig = {
				accountId: accountId.trim(),
				apiToken: apiToken.trim(),
				namespace,
				globalMemoryInstance: globalInstance,
				defaults: existing?.defaults ?? { autoRecall: false, autoIngest: false, showStatus: true },
			};
			saveGlobalConfig(globalConfig);
			ctx.ui.notify(`✓ Global config saved to ${globalConfigPath()}`, "info");

			// Step 6: Project instances
			const projectName = deriveProjectName(ctx.cwd);
			const existingProject = loadProjectConfig(ctx.cwd);

			const memInstance = existingProject?.memoryInstance ?? `pi-remembers-proj-${projectName}`;
			const searchInstance = existingProject?.searchInstance ?? `pi-remembers-search-${projectName}`;

			ctx.ui.notify(`Ensuring project instances: "${memInstance}", "${searchInstance}"...`, "info");
			await client.ensureInstance(memInstance);
			await client.ensureInstance(searchInstance);

			const projectConfig: ProjectConfig = {
				memoryInstance: memInstance,
				searchInstance,
				hooks: existingProject?.hooks ?? { autoRecall: false, autoIngest: false, showStatus: true },
			};
			saveProjectConfig(ctx.cwd, projectConfig);
			ctx.ui.notify(`✓ Project config saved to ${projectConfigPath(ctx.cwd)}`, "info");

			ctx.ui.notify(
				"🧠 Pi Remembers setup complete!\n\n" +
				"Hooks are OFF by default. Use /memory-settings to enable:\n" +
				"  • Auto Recall — inject memories before each turn\n" +
				"  • Auto Ingest — store conversations on compaction\n\n" +
				"You can always use memory tools manually (memory_recall, memory_remember).",
				"info",
			);
			onConfigured();
		},
	});
}
