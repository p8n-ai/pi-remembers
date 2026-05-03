/**
 * before_agent_start hook — auto-recall memories and opportunistic maintenance.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { CloudflareApiClient } from "../cloudflare/api-client.js";
import type { ResolvedConfig } from "../config.js";
import { refreshManifest, listDirty, loadDirty } from "../manifest.js";
import { loadRegistry, resolveRef, type RegistryEntry } from "../registry.js";
import type { StatsLogger } from "../stats/logger.js";
import { createRecorder } from "../stats/recorder.js";

function instanceFor(entry: RegistryEntry): string {
	return entry.memoryInstance ?? `pi-remembers-proj-${entry.id}`;
}

export function registerAgentStartHook(
	pi: ExtensionAPI,
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
	getLogger: (() => StatsLogger | null) | null,
) {
	let lastRecallQuery: string | null = null;
	let cachedRecall: string | null = null;
	let lastRecallTime = 0;
	const RECALL_CACHE_TTL = 10_000;
	let crashRecoveryAttempted = false;
	let ttlRefreshAttempted = false;

	pi.on("before_agent_start", async (_event, ctx) => {
		const client = getClient();
		const config = getConfig();
		if (!client || !config) return;

		// Crash-recovery: flush dirty manifests
		if (!crashRecoveryAttempted) {
			crashRecoveryAttempted = true;
			if (config.features.manifest.enabled && config.features.manifest.autoUpdateOnSessionEnd) {
				const dirty = listDirty();
				if (config.projectId && dirty.includes(config.projectId)) {
					refreshManifest(client, config).catch(() => {});
				}
			}
		}

		// TTL-based manifest refresh
		if (
			!ttlRefreshAttempted &&
			config.features.manifest.enabled &&
			config.features.manifest.autoUpdateOnAgentStartTTL &&
			config.projectId
		) {
			ttlRefreshAttempted = true;
			const dirtyAt = loadDirty().projects[config.projectId];
			const ttlMs = config.features.manifest.ttlDays * 24 * 60 * 60 * 1000;
			const isStale = !dirtyAt || Date.now() - new Date(dirtyAt).getTime() > ttlMs;
			if (isStale) {
				refreshManifest(client, config).catch(() => {});
			}
		}

		if (!config.hooks.autoRecall) return;

		// Extract latest user message as recall query — bail silently if none
		const entries = ctx.sessionManager.getBranch();
		const lastUser = [...entries].reverse().find((e) => e.type === "message" && e.message.role === "user");
		if (!lastUser || lastUser.type !== "message") return;

		const msg = lastUser.message;
		if (msg.role !== "user" || !("content" in msg)) return;

		const queryText =
			typeof msg.content === "string"
				? msg.content
				: Array.isArray(msg.content)
					? msg.content
							.filter((c): c is { type: "text"; text: string } => c.type === "text")
							.map((c) => c.text)
							.join(" ")
					: "";

		if (queryText.length < 10) return;

		const rec = createRecorder(getLogger?.() ?? null, "auto_recall", {
			query: queryText.slice(0, 500),
			projectId: config.projectId,
			projectName: config.projectName,
		});

		try {
			rec.step("extract_query", { input: { userMessageLength: queryText.length }, output: { queryText: queryText.slice(0, 500) } });

			// Cache check
			const now = Date.now();
			const cacheHit = queryText === lastRecallQuery && cachedRecall && now - lastRecallTime < RECALL_CACHE_TTL;
			rec.step("cache_check", {
				output: { cacheHit: !!cacheHit },
				metadata: cacheHit ? { cacheAge: now - lastRecallTime } : undefined,
			});

			if (cacheHit) {
				rec.step("final_output", { output: { injected: true, contextLength: cachedRecall!.length, fromCache: true } });
				rec.success();
				return {
					message: { customType: "memory-context", content: cachedRecall!, display: false },
				};
			}

			// Resolve instances (same policy as memory_recall scope=both + related)
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
			rec.step("resolve_instances", { output: { instances: [...instances] } });

			// Cloudflare search
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 5000);
			const tSearch = Date.now();
			const result = await client.recall([...instances], queryText, controller.signal);
			clearTimeout(timeout);

			rec.step("cloudflare_search", {
				input: { instances: [...instances], query: queryText.slice(0, 500) },
				output: { chunkCount: result.count },
				durationMs: Date.now() - tSearch,
			});

			if (result.count === 0) {
				rec.step("final_output", { output: { injected: false }, metadata: { reason: "no_results" } });
				rec.success();
				return;
			}

			// Build context
			const parts: string[] = ["[Recalled from persistent memory]"];
			for (const chunk of result.chunks.slice(0, 5)) {
				parts.push(`• ${chunk.text.slice(0, 300)}`);
			}
			const recallContent = parts.join("\n");
			lastRecallQuery = queryText;
			cachedRecall = recallContent;
			lastRecallTime = now;

			rec.step("build_context", {
				input: { chunkCount: result.count },
				output: { contextLength: recallContent.length, chunksUsed: Math.min(result.count, 5) },
			});
			rec.step("final_output", { output: { injected: true, contextLength: recallContent.length } });
			rec.success();

			return {
				message: { customType: "memory-context", content: recallContent, display: false },
			};
		} catch {
			rec.error("auto-recall failed");
			return;
		}
	});
}
