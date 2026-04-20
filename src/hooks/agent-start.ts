/**
 * Agent start hook — Recall relevant memories before each LLM turn.
 *
 * Also:
 *   • Performs T3 lazy manifest refresh (once per session) if stale.
 *   • On first turn, flushes any dirty manifest state from a prior crashed session.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import { refreshManifest, listDirty, loadDirty } from "../manifest.js";
import { loadRegistry, resolveRef, type RegistryEntry } from "../registry.js";

function instanceFor(entry: RegistryEntry): string {
	return entry.memoryInstance ?? `pi-remembers-proj-${entry.id}`;
}

export function registerAgentStartHook(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
) {
	let lastRecallQuery: string | null = null;
	let cachedRecall: string | null = null;
	let lastRecallTime = 0;
	const RECALL_CACHE_TTL = 60_000;
	let ttlRefreshAttempted = false;
	let crashRecoveryAttempted = false;

	pi.on("before_agent_start", async (_event, ctx) => {
		const client = getClient();
		const config = getConfig();
		if (!client || !config) return;

		// Crash recovery (runs once per session) — flush any dirty projects from prior runs.
		if (!crashRecoveryAttempted) {
			crashRecoveryAttempted = true;
			if (config.features.manifest.enabled && config.features.manifest.autoUpdateOnSessionEnd) {
				const dirty = listDirty();
				// Only flush the CURRENT project automatically — other projects' configs
				// aren't resolved here; they'll flush on their next session.
				if (config.projectId && dirty.includes(config.projectId)) {
					refreshManifest(client, config).catch(() => {});
				}
			}
		}

		// T3 lazy refresh: once per session, if manifest record is older than TTL, refresh.
		if (
			!ttlRefreshAttempted &&
			config.features.manifest.enabled &&
			config.features.manifest.autoUpdateOnAgentStartTTL &&
			config.projectId
		) {
			ttlRefreshAttempted = true;
			// We infer staleness from dirty file timestamp (if present) or just refresh opportunistically.
			const dirtyAt = loadDirty().projects[config.projectId];
			const ttlMs = config.features.manifest.ttlDays * 24 * 60 * 60 * 1000;
			const isStale = !dirtyAt || Date.now() - new Date(dirtyAt).getTime() > ttlMs;
			if (isStale) {
				refreshManifest(client, config).catch(() => {});
			}
		}

		if (!config.hooks.autoRecall) return;

		// Extract latest user message as recall query
		const entries = ctx.sessionManager.getBranch();
		const lastUser = [...entries].reverse().find((e) => e.type === "message" && e.message.role === "user");

		if (!lastUser || lastUser.type !== "message") return;
		const msg = lastUser.message;
		if (msg.role !== "user" || !("content" in msg)) return;

		const userContent = msg.content;
		let queryText: string;
		if (typeof userContent === "string") {
			queryText = userContent;
		} else if (Array.isArray(userContent)) {
			queryText = userContent
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join(" ");
		} else {
			return;
		}

		if (queryText.length < 10) return;

		const now = Date.now();
		if (queryText === lastRecallQuery && cachedRecall && now - lastRecallTime < RECALL_CACHE_TTL) {
			return {
				message: { customType: "memory-context", content: cachedRecall, display: false },
			};
		}

		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);

			// Assemble instances using the same policy as memory_recall (scope=both + related).
			const instances = new Set<string>();
			instances.add(config.projectMemoryInstance);
			instances.add(config.globalMemoryInstance);
			if (config.features.recall.includeRelated && config.relatedProjects.length > 0) {
				const reg = loadRegistry();
				for (const ref of config.relatedProjects) {
					const entry = resolveRef(reg, ref);
					if (entry) instances.add(instanceFor(entry));
				}
			}

			const result = await client.recall([...instances], queryText, controller.signal);
			clearTimeout(timeout);

			if (result.count === 0) return;

			const parts: string[] = ["[Recalled from persistent memory]"];
			for (const chunk of result.chunks.slice(0, 5)) {
				parts.push(`• ${chunk.text.slice(0, 300)}`);
			}

			const recallContent = parts.join("\n");
			lastRecallQuery = queryText;
			cachedRecall = recallContent;
			lastRecallTime = now;

			return {
				message: { customType: "memory-context", content: recallContent, display: false },
			};
		} catch {
			return;
		}
	});
}
