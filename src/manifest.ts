/**
 * Manifest — global project discovery index.
 *
 * A single Cloudflare AI Search instance (`pi-remembers-manifest` by default)
 * holds one small document per known project. Documents contain identity
 * metadata + a short description and topics — no raw memory bodies — so they
 * can be safely searched across projects.
 *
 * Triggers (all flag-gated):
 *   T1 write-through (debounced)  — after memory_remember
 *   T2 session-end                — flush dirty projects on shutdown
 *   T3 TTL                        — lazy refresh on agent-start if stale
 *   T4 compaction                 — opportunistic
 *   T5 manual                     — /memory-manifest-refresh
 */

import { existsSync, readFileSync } from "node:fs";
import type { CloudflareApiClient, SearchChunk } from "./cloudflare/api-client.js";
import type { ResolvedConfig } from "./config.js";
import { dirtyFlagPath, writeJsonAtomic } from "./config.js";

export interface ManifestRecord {
	id: string;
	name: string;
	aliases: string[];
	description: string;
	topics: string[];
	memoryCount: number;
	updatedAt: string;
	workspace?: string;
}

/** Dirty tracker persisted to disk so crashes don't lose pending flushes. */
interface DirtyFile {
	version: 1;
	/** projectId → last-dirtied ISO timestamp. */
	projects: Record<string, string>;
}

const EMPTY_DIRTY: DirtyFile = { version: 1, projects: {} };

export function loadDirty(): DirtyFile {
	const p = dirtyFlagPath();
	if (!existsSync(p)) return { ...EMPTY_DIRTY, projects: {} };
	try {
		const raw = JSON.parse(readFileSync(p, "utf-8")) as DirtyFile;
		if (!raw || raw.version !== 1) return { ...EMPTY_DIRTY, projects: {} };
		return raw;
	} catch {
		return { ...EMPTY_DIRTY, projects: {} };
	}
}

export function saveDirty(d: DirtyFile): void {
	writeJsonAtomic(dirtyFlagPath(), d);
}

export function markDirty(projectId: string): void {
	const d = loadDirty();
	d.projects[projectId] = new Date().toISOString();
	saveDirty(d);
}

export function clearDirty(projectId: string): void {
	const d = loadDirty();
	if (projectId in d.projects) {
		delete d.projects[projectId];
		saveDirty(d);
	}
}

export function listDirty(): string[] {
	return Object.keys(loadDirty().projects);
}

// ── Build / publish ──

const MANIFEST_DOC_KIND = "manifest";

/** Stable document key for a project's manifest record (used for overwrite). */
export function manifestDocKey(projectId: string): string {
	return `manifest-${projectId}.json`;
}

/**
 * Build a manifest record for a project from recent memories + user overrides.
 * Derives description/topics ONLY from titles/metadata and user-declared
 * overrides — never from raw memory bodies — to avoid leaking secrets.
 */
export async function buildManifest(
	client: CloudflareApiClient,
	config: ResolvedConfig,
	signal?: AbortSignal,
): Promise<ManifestRecord> {
	if (!config.projectId) {
		throw new Error("buildManifest requires a project with a stable id");
	}

	let memoryCount = 0;
	let sampledKeys: string[] = [];
	try {
		const list = await client.listMemories(config.projectMemoryInstance, signal);
		memoryCount = list.count;
		sampledKeys = list.items.slice(0, config.features.manifest.sampleSize).map((i) => i.key);
	} catch {
		// Instance may not exist yet — that's fine, we still publish identity.
	}

	const override = config.manifestOverride ?? {};
	const description =
		override.description?.trim() ||
		defaultDescription(config.projectName, memoryCount, sampledKeys);
	const topics = dedupe([...(override.topics ?? []), ...topicsFromKeys(sampledKeys)]);

	return {
		id: config.projectId,
		name: config.projectName,
		aliases: config.projectAliases,
		description,
		topics,
		memoryCount,
		updatedAt: new Date().toISOString(),
		workspace: config.workspace ?? undefined,
	};
}

function defaultDescription(name: string, count: number, keys: string[]): string {
	if (count === 0) return `Project "${name}" (no memories yet).`;
	const kinds = new Set<string>();
	for (const k of keys) {
		const m = k.match(/memory-\d+-[a-z0-9]+\.md/) ? "memory" : k.split("-")[0] ?? "memory";
		kinds.add(m);
	}
	return `Project "${name}" — ${count} memor${count === 1 ? "y" : "ies"} stored.`;
}

function topicsFromKeys(keys: string[]): string[] {
	// Placeholder topic derivation: use filename prefixes as a cheap signal.
	const topics = new Set<string>();
	for (const k of keys) {
		const head = k.split(/[-_.]/)[0];
		if (head && head !== "memory" && head.length > 2) topics.add(head.toLowerCase());
	}
	return [...topics].slice(0, 10);
}

function dedupe<T>(arr: T[]): T[] {
	return [...new Set(arr)];
}

/** Serialize + publish a manifest record. Overwrites prior record for this project. */
export async function publishManifest(
	client: CloudflareApiClient,
	config: ResolvedConfig,
	record: ManifestRecord,
	signal?: AbortSignal,
): Promise<void> {
	const instance = config.features.manifest.instanceId;
	// Ensure instance exists (idempotent).
	try {
		await client.ensureInstance(instance, signal);
	} catch {
		// best-effort
	}

	// Remove prior doc for this project (best-effort — APIs may not support by-key deletion).
	try {
		const existing = await client.listMemories(instance, signal);
		const stale = existing.items.filter((i) => i.key === manifestDocKey(record.id));
		await Promise.all(stale.map((s) => client.forget(instance, s.id, signal).catch(() => {})));
	} catch {
		// ignore
	}

	// Body is searchable plaintext; metadata carries structure.
	const body = [
		`# ${record.name}`,
		`Aliases: ${record.aliases.join(", ") || "(none)"}`,
		`Topics: ${record.topics.join(", ") || "(none)"}`,
		"",
		record.description,
	].join("\n");

	await client.uploadFile(instance, manifestDocKey(record.id), body, {
		kind: MANIFEST_DOC_KIND,
		projectId: record.id,
		projectName: record.name,
		updatedAt: record.updatedAt,
		memoryCount: String(record.memoryCount),
	}, signal);
}

/** Full build + publish + clear dirty flag. */
export async function refreshManifest(
	client: CloudflareApiClient,
	config: ResolvedConfig,
	signal?: AbortSignal,
): Promise<ManifestRecord | null> {
	if (!config.features.manifest.enabled) return null;
	if (!config.projectId) return null;
	const record = await buildManifest(client, config, signal);
	await publishManifest(client, config, record, signal);
	clearDirty(config.projectId);
	return record;
}

// ── Discovery (two-phase recall) ──

export interface DiscoveredProject {
	projectId: string;
	score: number;
}

/**
 * Phase 1 of two-phase recall: query the manifest instance and return the
 * top-K candidate project ids above `threshold`.
 */
export async function discoverProjects(
	client: CloudflareApiClient,
	config: ResolvedConfig,
	query: string,
	signal?: AbortSignal,
): Promise<DiscoveredProject[]> {
	if (!config.features.manifest.enabled) return [];
	const { discoveryTopK, discoveryThreshold } = config.features.recall;
	try {
		const res = await client.recall([config.features.manifest.instanceId], query, signal);
		const byProject = new Map<string, number>();
		for (const chunk of res.chunks) {
			const pid = extractProjectId(chunk);
			if (!pid) continue;
			const prev = byProject.get(pid) ?? 0;
			if (chunk.score > prev) byProject.set(pid, chunk.score);
		}
		return [...byProject.entries()]
			.filter(([, s]) => s >= discoveryThreshold)
			.sort((a, b) => b[1] - a[1])
			.slice(0, discoveryTopK)
			.map(([projectId, score]) => ({ projectId, score }));
	} catch {
		return [];
	}
}

function extractProjectId(chunk: SearchChunk): string | null {
	// Try metadata first; fall back to parsing doc key `manifest-<id>.json`.
	const key = chunk.item?.key ?? "";
	const m = key.match(/^manifest-(prj_[a-z0-9]+)\.json$/i);
	return m ? m[1] : null;
}

// ── Debouncer (write-through) ──

export interface Debouncer {
	/** Schedule a flush for the given project. */
	schedule(projectId: string): void;
	/** Fire any pending flush immediately for this project. */
	flush(projectId: string): Promise<void>;
	/** Fire all pending flushes and cancel timers (for shutdown). */
	flushAll(): Promise<void>;
	/** Cancel all pending flushes without firing (for tests). */
	cancelAll(): void;
}

export function createDebouncer(
	getClient: () => CloudflareApiClient | null,
	getConfig: () => ResolvedConfig | null,
	onError?: (err: unknown) => void,
): Debouncer {
	const timers = new Map<string, NodeJS.Timeout>();

	async function run(projectId: string) {
		timers.delete(projectId);
		const client = getClient();
		const config = getConfig();
		if (!client || !config) return;
		if (!config.features.manifest.enabled) return;
		// Only flush if the active project matches the scheduled one — otherwise
		// we'd need to rebuild resolved config for that project. Leave it on
		// disk (dirty flag persists) so the next session for that project flushes.
		if (config.projectId !== projectId) return;
		try {
			await refreshManifest(client, config);
		} catch (err) {
			onError?.(err);
		}
	}

	return {
		schedule(projectId) {
			const config = getConfig();
			if (!config?.features.manifest.enabled) return;
			if (!config.features.manifest.autoUpdateOnWrite) return;
			markDirty(projectId);
			const existing = timers.get(projectId);
			if (existing) clearTimeout(existing);
			timers.set(projectId, setTimeout(() => void run(projectId), config.features.manifest.debounceMs));
		},
		async flush(projectId) {
			const t = timers.get(projectId);
			if (t) {
				clearTimeout(t);
				timers.delete(projectId);
			}
			await run(projectId);
		},
		async flushAll() {
			const ids = [...timers.keys()];
			for (const id of ids) clearTimeout(timers.get(id)!);
			timers.clear();
			for (const id of ids) await run(id);
		},
		cancelAll() {
			for (const t of timers.values()) clearTimeout(t);
			timers.clear();
		},
	};
}
