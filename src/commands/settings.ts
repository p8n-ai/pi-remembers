/**
 * /memory-settings — Interactive toggle UI for hook settings.
 *
 * Lets users enable/disable individual hooks at runtime.
 * Changes are saved to the project config (.pi/pi-remembers.json)
 * and take effect immediately without reloading.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ResolvedConfig, HookSettings } from "../config.js";
import { loadProjectConfig, saveProjectConfig, projectConfigPath } from "../config.js";

interface SettingEntry {
	key: keyof HookSettings;
	label: string;
	description: string;
}

const SETTINGS: SettingEntry[] = [
	{
		key: "autoRecall",
		label: "Smart Context Recall",
		description: "Auto-recall memories before each LLM turn (adds ~latency per turn)",
	},
	{
		key: "autoIngest",
		label: "Compaction Ingest",
		description: "Auto-store conversations into memory when Pi compacts context",
	},
	{
		key: "showStatus",
		label: "Footer Status",
		description: "Show 🧠 memory status in the footer bar",
	},
];

export function registerSettingsCommand(
	pi: ExtensionAPI,
	getConfig: () => ResolvedConfig | null,
	reinit: () => void,
) {
	pi.registerCommand("memory-settings", {
		description: "Toggle Pi Remembers hook settings (auto-recall, auto-ingest, footer status)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/memory-settings requires interactive mode", "error");
				return;
			}

			const config = getConfig();
			if (!config) {
				ctx.ui.notify("Not configured. Run /memory-setup first.", "error");
				return;
			}

			// Build toggle options with current state
			const options = SETTINGS.map((s) => {
				const on = config.hooks[s.key];
				const icon = on ? "✓" : "○";
				return `${icon}  ${s.label} — ${s.description}`;
			});
			options.push("──────────────────");
			options.push("Done");

			let changed = false;

			// Loop: let user toggle until they pick "Done"
			while (true) {
				// Rebuild options with current state
				const current = getConfig();
				if (!current) break;

				const opts = SETTINGS.map((s) => {
					const on = current.hooks[s.key];
					const icon = on ? "✓" : "○";
					return `${icon}  ${s.label} — ${s.description}`;
				});
				opts.push("Done");

				const choice = await ctx.ui.select("Pi Remembers Settings:", opts);
				if (!choice || choice === "Done") break;

				// Find which setting was toggled
				const idx = opts.indexOf(choice);
				if (idx < 0 || idx >= SETTINGS.length) break;

				const setting = SETTINGS[idx];
				const newValue = !current.hooks[setting.key];

				// Save to project config
				const projectConfig = loadProjectConfig(ctx.cwd) ?? {};
				if (!projectConfig.hooks) projectConfig.hooks = {};
				projectConfig.hooks[setting.key] = newValue;
				saveProjectConfig(ctx.cwd, projectConfig);

				// Reinitialize so the change takes effect immediately
				reinit();
				changed = true;

				const state = newValue ? "enabled" : "disabled";
				ctx.ui.notify(`${setting.label}: ${state}`, "info");
			}

			if (changed) {
				const final = getConfig();
				if (final) {
					const lines = SETTINGS.map((s) => {
						const on = final.hooks[s.key];
						return `  ${on ? "✓" : "○"} ${s.label}`;
					});
					ctx.ui.notify(`Settings saved to ${projectConfigPath(ctx.cwd)}:\n${lines.join("\n")}`, "info");

					// Update footer status immediately
					if (final.hooks.showStatus) {
						ctx.ui.setStatus("memory", ctx.ui.theme.fg("accent", `🧠 ${final.projectMemoryInstance}`));
					} else {
						ctx.ui.setStatus("memory", undefined);
					}
				}
			}
		},
	});
}
