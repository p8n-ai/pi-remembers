/**
 * memory_recall tool — Search memories for context about a topic.
 *
 * Scope semantics:
 *   • "project" — current project only
 *   • "global"  — global memory only
 *   • "both"    — project + global (legacy default)
 *   • "related" — project + global + relatedProjects
 *   • "all"     — every project in the registry (read-only)
 *
 * Explicit `projects: string[]` param (ids, names, aliases) takes precedence
 * over scope and is ALWAYS read-only — writes are never routed by this param.
 *
 * When features.recall.includeDiscovered is on and no explicit projects are
 * given, a two-phase discovery pass against the manifest index augments the
 * search instances with semantically-relevant projects.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import { loadRegistry, resolveRef, type RegistryEntry } from "../registry.js";
import { discoverProjects } from "../manifest.js";

interface ResolvedProjectRef {
	entry: RegistryEntry;
	instance: string;
}

function instanceFor(entry: RegistryEntry): string {
	return entry.memoryInstance ?? `pi-remembers-proj-${entry.id}`;
}

/** Resolve a list of project refs. Unknown refs are reported, not thrown. */
function resolveRefs(refs: string[]): { resolved: ResolvedProjectRef[]; unknown: string[] } {
	const reg = loadRegistry();
	const resolved: ResolvedProjectRef[] = [];
	const unknown: string[] = [];
	for (const ref of refs) {
		const entry = resolveRef(reg, ref);
		if (entry) resolved.push({ entry, instance: instanceFor(entry) });
		else unknown.push(ref);
	}
	return { resolved, unknown };
}

export function registerRecallTool(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
) {
	pi.registerTool({
		name: "memory_recall",
		label: "Memory Recall",
		description:
			"Search persistent memories for context about a topic. Returns relevant chunks from past sessions. " +
			"Use when you need to remember past decisions, preferences, or project context. " +
			"Can also search other known projects' memories via the `projects` parameter (read-only).",
		promptSnippet: "Search persistent memories (past sessions, decisions, preferences) for context",
		promptGuidelines: [
			"Use memory_recall proactively when starting work to check for relevant past context.",
			"Use memory_recall when the user references past decisions or asks 'do you remember...'",
			"To search another project's memories, pass its id/name/alias in the `projects` array. " +
				"Use memory_list_projects to enumerate known projects.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "What to search for in memories (natural language)" }),
			scope: Type.Optional(
				Type.Union(
					[
						Type.Literal("project"),
						Type.Literal("global"),
						Type.Literal("both"),
						Type.Literal("related"),
						Type.Literal("all"),
					],
					{
						description:
							"Search scope: 'project', 'global', 'both' (default), 'related' (project+global+related), or 'all' (every known project, read-only).",
					},
				),
			),
			projects: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Explicit project ids/names/aliases to include (read-only). Unknown refs are skipped with a warning.",
				}),
			),
		}),

		async execute(_toolCallId, params, signal) {
			const client = getClient();
			const config = getConfig();
			if (!client || !config) throw new Error("Not configured. Run /memory-setup first.");

			const scope = params.scope ?? "both";
			const instances = new Set<string>();
			const scopeTags: string[] = [];

			// Base scope
			if (scope === "project" || scope === "both" || scope === "related") {
				instances.add(config.projectMemoryInstance);
				scopeTags.push("project");
			}
			if (scope === "global" || scope === "both" || scope === "related") {
				instances.add(config.globalMemoryInstance);
				scopeTags.push("global");
			}

			// Related
			const warnings: string[] = [];
			if ((scope === "related" || config.features.recall.includeRelated) && config.relatedProjects.length > 0) {
				const { resolved, unknown } = resolveRefs(config.relatedProjects);
				for (const r of resolved) instances.add(r.instance);
				if (resolved.length > 0) scopeTags.push(`related(${resolved.length})`);
				for (const u of unknown) warnings.push(`Unknown relatedProject ref: ${u}`);
			}

			// All
			if (scope === "all") {
				const reg = loadRegistry();
				for (const p of Object.values(reg.projects)) {
					instances.add(instanceFor(p));
				}
				instances.add(config.globalMemoryInstance);
				scopeTags.push(`all(${Object.keys(reg.projects).length})`);
			}

			// Explicit projects param (always read-only augmentation)
			if (params.projects && params.projects.length > 0) {
				const { resolved, unknown } = resolveRefs(params.projects);
				for (const r of resolved) instances.add(r.instance);
				if (resolved.length > 0) scopeTags.push(`explicit(${resolved.length})`);
				for (const u of unknown) warnings.push(`Unknown project ref: ${u}`);
			}

			// Two-phase discovery (only when no explicit projects and feature on)
			const discovered: { projectId: string; score: number; instance: string }[] = [];
			if (
				config.features.recall.includeDiscovered &&
				(!params.projects || params.projects.length === 0) &&
				scope !== "all"
			) {
				const timeoutMs = config.features.recall.discoveryTimeoutMs;
				const ctrl = new AbortController();
				const t = setTimeout(() => ctrl.abort(), timeoutMs);
				// Merge caller signal
				signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
				try {
					const hits = await discoverProjects(client, config, params.query, ctrl.signal);
					const reg = loadRegistry();
					for (const h of hits) {
						const entry = reg.projects[h.projectId];
						if (!entry) continue;
						// Skip the current project — already included above.
						if (entry.id === config.projectId) continue;
						const inst = instanceFor(entry);
						if (!instances.has(inst)) {
							instances.add(inst);
							discovered.push({ projectId: h.projectId, score: h.score, instance: inst });
						}
					}
					if (discovered.length > 0) scopeTags.push(`discovered(${discovered.length})`);
				} catch {
					// Fall through — discovery is best-effort.
				} finally {
					clearTimeout(t);
				}
			}

			const instanceList = [...instances];
			const result = await client.recall(instanceList, params.query, signal);

			if (result.count === 0) {
				const lines: string[] = ["No relevant memories found."];
				for (const w of warnings) lines.push(`⚠ ${w}`);
				return {
					content: [{ type: "text", text: lines.join("\n") }],
					details: {
						query: params.query,
						scope,
						scopeTags,
						instances: instanceList,
						discovered,
						warnings,
						count: 0,
					},
				};
			}

			const lines: string[] = [`Found ${result.count} relevant memory chunk(s):\n`];
			for (const chunk of result.chunks) {
				const src = chunk.instance_id ?? "memory";
				lines.push(`[${src}] (score: ${chunk.score.toFixed(2)}) ${chunk.text}`);
				lines.push("");
			}
			for (const w of warnings) lines.push(`⚠ ${w}`);

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					query: params.query,
					scope,
					scopeTags,
					instances: instanceList,
					discovered,
					warnings,
					count: result.count,
				} as Record<string, unknown>,
			};
		},
	});
}
