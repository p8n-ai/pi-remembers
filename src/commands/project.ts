/**
 * /memory-project — Show / manage the current project's identity marker.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { ResolvedConfig } from "../config.js";
import {
	ensureProjectMarker,
	loadProjectConfigAt,
	projectConfigPath,
	saveProjectConfigAt,
	FEATURE_DEFAULTS,
} from "../config.js";
import { loadRegistry, listProjects } from "../registry.js";

export function registerProjectCommand(
	pi: ExtensionAPI,
	getConfig: () => ResolvedConfig | null,
	reinit: () => void,
) {
	pi.registerCommand("memory-project", {
		description:
			"Show the current project's identity marker (id, name, root). Use --init to create a marker at cwd, --add-alias <name> to add an alias, --list to list known projects.",
		handler: async (args, ctx) => {
			const cfg = getConfig();
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = parts[0] ?? "show";

			if (cmd === "--list" || cmd === "list") {
				const reg = loadRegistry();
				const all = listProjects(reg);
				if (all.length === 0) {
					ctx.ui.notify("No projects in the local registry yet.", "info");
					return;
				}
				const lines = all.map((p) => {
					const current = cfg && p.id === cfg.projectId ? " (current)" : "";
					const aliases = p.aliases.length > 0 ? ` [${p.aliases.join(", ")}]` : "";
					return `• ${p.name}${aliases} — ${p.id}${current}\n  roots: ${p.roots.join(", ")}`;
				});
				ctx.ui.notify(`Known projects:\n${lines.join("\n")}`, "info");
				return;
			}

			if (cmd === "--init" || cmd === "init") {
				// Force-create a marker at cwd regardless of walk-up result.
				const { config: existed } = ensureProjectMarker(ctx.cwd, FEATURE_DEFAULTS.identity);
				reinit();
				ctx.ui.notify(
					`Project marker ensured at ${projectConfigPath(ctx.cwd)}\nid: ${existed.id}\nname: ${existed.name}`,
					"info",
				);
				return;
			}

			if (cmd === "--add-alias" || cmd === "add-alias") {
				const alias = parts.slice(1).join(" ").trim();
				if (!alias) {
					ctx.ui.notify("Usage: /memory-project --add-alias <name>", "error");
					return;
				}
				if (!cfg) {
					ctx.ui.notify("Not configured. Run /memory-setup first.", "error");
					return;
				}
				const root = cfg.projectRoot;
				const existing = loadProjectConfigAt(root) ?? {};
				const aliases = new Set(existing.aliases ?? []);
				aliases.add(alias);
				existing.aliases = [...aliases];
				saveProjectConfigAt(root, existing);
				reinit();
				ctx.ui.notify(`Added alias "${alias}" to project "${cfg.projectName}"`, "info");
				return;
			}

			// Default: show
			if (!cfg) {
				ctx.ui.notify("Not configured. Run /memory-setup first.", "error");
				return;
			}
			const lines = [
				`Project: ${cfg.projectName}`,
				`  id: ${cfg.projectId ?? "(legacy / no marker)"}`,
				`  root: ${cfg.projectRoot}`,
				`  aliases: ${cfg.projectAliases.join(", ") || "(none)"}`,
				`  memoryInstance: ${cfg.projectMemoryInstance}`,
				`  searchInstance: ${cfg.searchInstance}`,
				`  relatedProjects: ${cfg.relatedProjects.join(", ") || "(none)"}`,
				`  workspace: ${cfg.workspace ?? "(none)"}`,
				`  marker path: ${projectConfigPath(cfg.projectRoot)}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
