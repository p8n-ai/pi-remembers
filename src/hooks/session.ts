/**
 * Session hooks — update status display.
 *
 * This module only exports a helper. The actual session_start listener
 * lives in index.ts to ensure initClients() runs first.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { ResolvedConfig } from "../config.js";

/**
 * Update the footer status based on current config and hook settings.
 * Called from index.ts after initClients().
 */
export function updateMemoryStatus(ctx: ExtensionContext, config: ResolvedConfig | null): void {
	if (!config) {
		ctx.ui.setStatus("memory", ctx.ui.theme.fg("dim", "🧠 /memory-setup"));
		return;
	}
	if (!config.hooks.showStatus) {
		ctx.ui.setStatus("memory", undefined);
		return;
	}
	const label = config.projectName || config.projectMemoryInstance;
	ctx.ui.setStatus("memory", ctx.ui.theme.fg("accent", `🧠 ${label}`));
}
