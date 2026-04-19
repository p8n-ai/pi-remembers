/**
 * /memory-settings — Interactive toggle UI for hook settings and feature flags.
 *
 * Hook settings (autoRecall / autoIngest / showStatus) live in the project
 * config (`.pi/pi-remembers.json`). Feature flags (identity, recall, manifest)
 * live in the global config (`~/.pi/pi-remembers.json`) under `features`.
 * Changes take effect immediately without reloading.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ResolvedConfig, HookSettings, GlobalConfig, FeatureFlags } from "../config.js";
import {
	loadGlobalConfig,
	loadProjectConfig,
	projectConfigPath,
	globalConfigPath,
	saveGlobalConfig,
	saveProjectConfig,
} from "../config.js";

type BooleanFlagPath =
	| ["hooks", keyof HookSettings]
	| ["features", "identity", "autoCreateMarker" | "walkUp" | "registryEnabled" | "migrateLegacy"]
	| ["features", "recall", "includeRelated" | "includeDiscovered"]
	| [
			"features",
			"manifest",
			| "enabled"
			| "autoUpdateOnWrite"
			| "autoUpdateOnSessionEnd"
			| "autoUpdateOnAgentStartTTL"
			| "autoUpdateOnCompaction",
	  ];

interface ToggleEntry {
	path: BooleanFlagPath;
	label: string;
	description: string;
	/** "project" flags live in .pi/pi-remembers.json; "global" flags in ~/.pi/pi-remembers.json. */
	scope: "project" | "global";
}

const TOGGLES: ToggleEntry[] = [
	// Hooks (project-scoped)
	{
		path: ["hooks", "autoRecall"],
		label: "Smart Context Recall",
		description: "Auto-recall memories before each LLM turn",
		scope: "project",
	},
	{
		path: ["hooks", "autoIngest"],
		label: "Compaction Ingest",
		description: "Auto-store conversations into memory on compaction",
		scope: "project",
	},
	{
		path: ["hooks", "showStatus"],
		label: "Footer Status",
		description: "Show 🧠 memory status in the footer",
		scope: "project",
	},

	// Identity (global)
	{
		path: ["features", "identity", "autoCreateMarker"],
		label: "Auto-create project marker",
		description: "Write .pi/pi-remembers.json when none is found",
		scope: "global",
	},
	{
		path: ["features", "identity", "walkUp"],
		label: "Walk up for marker",
		description: "Git-style: find nearest marker by walking up from cwd",
		scope: "global",
	},
	{
		path: ["features", "identity", "registryEnabled"],
		label: "Project registry",
		description: "Maintain ~/.pi/pi-remembers-projects.json index",
		scope: "global",
	},
	{
		path: ["features", "identity", "migrateLegacy"],
		label: "Legacy instance migration",
		description: "New markers pin to existing basename instances",
		scope: "global",
	},

	// Recall (global)
	{
		path: ["features", "recall", "includeRelated"],
		label: "Include related projects in recall",
		description: "Default recall unions `relatedProjects`",
		scope: "global",
	},
	{
		path: ["features", "recall", "includeDiscovered"],
		label: "Cross-project discovery (manifest)",
		description: "Two-phase recall finds relevant projects automatically",
		scope: "global",
	},

	// Manifest (global)
	{
		path: ["features", "manifest", "enabled"],
		label: "Manifest index",
		description: "Master switch for cross-project discovery index",
		scope: "global",
	},
	{
		path: ["features", "manifest", "autoUpdateOnWrite"],
		label: "Manifest: refresh on write",
		description: "Debounced refresh after memory_remember (T1)",
		scope: "global",
	},
	{
		path: ["features", "manifest", "autoUpdateOnSessionEnd"],
		label: "Manifest: flush on session end",
		description: "Publish pending updates on shutdown (T2)",
		scope: "global",
	},
	{
		path: ["features", "manifest", "autoUpdateOnAgentStartTTL"],
		label: "Manifest: lazy TTL refresh",
		description: "Refresh once per session if stale (T3)",
		scope: "global",
	},
	{
		path: ["features", "manifest", "autoUpdateOnCompaction"],
		label: "Manifest: refresh on compaction",
		description: "Opportunistic refresh during compaction (T4)",
		scope: "global",
	},
];

function readFlag(cfg: ResolvedConfig, path: BooleanFlagPath): boolean {
	if (path[0] === "hooks") {
		return Boolean(cfg.hooks[path[1]]);
	}
	if (path[0] === "features") {
		const section = path[1];
		const key = path[2] as string;
		return Boolean((cfg.features as unknown as Record<string, Record<string, unknown>>)[section][key]);
	}
	return false;
}

function writeFlag(cwd: string, entry: ToggleEntry, value: boolean): void {
	if (entry.scope === "project") {
		const proj = loadProjectConfig(cwd) ?? {};
		if (!proj.hooks) proj.hooks = {};
		(proj.hooks as Record<string, boolean>)[entry.path[1] as string] = value;
		saveProjectConfig(cwd, proj);
		return;
	}
	// Global
	const global = loadGlobalConfig();
	if (!global) return;
	const next: GlobalConfig = { ...global };
	if (!next.features) next.features = {};
	const features = next.features as FeatureFlags;
	const section = entry.path[1] as "identity" | "recall" | "manifest";
	const key = entry.path[2] as string;
	const sec = (features[section] ?? {}) as Record<string, unknown>;
	sec[key] = value;
	(features as Record<string, unknown>)[section] = sec;
	next.features = features;
	saveGlobalConfig(next);
}

export function registerSettingsCommand(
	pi: ExtensionAPI,
	getConfig: () => ResolvedConfig | null,
	reinit: () => void,
) {
	pi.registerCommand("memory-settings", {
		description:
			"Toggle Pi Remembers settings — hooks, identity, cross-project recall, manifest triggers",
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

			let changed = false;

			while (true) {
				const current = getConfig();
				if (!current) break;

				const opts = TOGGLES.map((t) => {
					const on = readFlag(current, t.path);
					const icon = on ? "✓" : "○";
					const scopeTag = t.scope === "global" ? " [global]" : "";
					return `${icon}  ${t.label}${scopeTag} — ${t.description}`;
				});
				opts.push("──────────────────");
				opts.push("Done");

				const choice = await ctx.ui.select("Pi Remembers Settings:", opts);
				if (!choice || choice === "Done" || choice.startsWith("──")) break;

				const idx = opts.indexOf(choice);
				if (idx < 0 || idx >= TOGGLES.length) break;

				const entry = TOGGLES[idx];
				const newValue = !readFlag(current, entry.path);
				writeFlag(ctx.cwd, entry, newValue);

				reinit();
				changed = true;
				const state = newValue ? "enabled" : "disabled";
				ctx.ui.notify(`${entry.label}: ${state}`, "info");
			}

			if (changed) {
				const final = getConfig();
				if (final) {
					ctx.ui.notify(
						`Settings saved.\n  Project: ${projectConfigPath(final.projectRoot)}\n  Global:  ${globalConfigPath()}`,
						"info",
					);
					if (final.hooks.showStatus) {
						const label = final.projectName || final.projectMemoryInstance;
						ctx.ui.setStatus("memory", ctx.ui.theme.fg("accent", `🧠 ${label}`));
					} else {
						ctx.ui.setStatus("memory", undefined);
					}
				}
			}
		},
	});
}
