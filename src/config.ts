/**
 * Configuration management for Pi Remembers.
 *
 * Config hierarchy:
 *   1. ~/.pi/pi-remembers.json       — global (account ID, API token, namespace, defaults, features)
 *   2. .pi/pi-remembers.json         — project marker + overrides
 *
 * Project resolution uses walk-up detection (git-style): starting from `cwd`,
 * walk up looking for the nearest `.pi/pi-remembers.json` marker. This makes
 * project identity stable regardless of which subfolder a session is opened in.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join, basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

// ── Config types ──

export interface HookSettings {
	/** Auto-recall relevant memories before each LLM turn. Default: false */
	autoRecall?: boolean;
	/** Auto-ingest conversations into memory on compaction. Default: false */
	autoIngest?: boolean;
	/** Show 🧠 status in footer bar. Default: true */
	showStatus?: boolean;
}

/**
 * Feature flags controlling Phase 1+ behavior. All gated with conservative
 * defaults so existing installs see zero behavior change until opted in.
 */
export interface FeatureFlags {
	identity?: {
		/** Auto-create `.pi/pi-remembers.json` marker when none is found. Default: true */
		autoCreateMarker?: boolean;
		/** Walk up from `cwd` to find the nearest marker (git-style). Default: true */
		walkUp?: boolean;
		/** Maintain `~/.pi/pi-remembers-projects.json` registry. Default: true */
		registryEnabled?: boolean;
		/** Migrate legacy basename-derived instances to marker-based IDs. Default: true */
		migrateLegacy?: boolean;
	};
	recall?: {
		/** Include `relatedProjects` in default recall scope. Default: true */
		includeRelated?: boolean;
		/** Two-phase manifest discovery (Phase 3). Default: false */
		includeDiscovered?: boolean;
		/** Minimum score to include a discovered project. Default: 0.55 */
		discoveryThreshold?: number;
		/** Max projects pulled from manifest discovery. Default: 3 */
		discoveryTopK?: number;
		/** Timeout (ms) for the discovery phase before falling back. Default: 1500 */
		discoveryTimeoutMs?: number;
	};
	manifest?: {
		/** Master switch for manifest indexing (Phase 3). Default: false */
		enabled?: boolean;
		/** Global manifest instance id. Default: "pi-remembers-manifest" */
		instanceId?: string;
		/** Trigger: publish after `memory_remember` (debounced). Default: true */
		autoUpdateOnWrite?: boolean;
		/** Trigger: flush dirty projects on session shutdown. Default: true */
		autoUpdateOnSessionEnd?: boolean;
		/** Trigger: lazy refresh on agent-start if stale. Default: true */
		autoUpdateOnAgentStartTTL?: boolean;
		/** Trigger: refresh on compaction (opportunistic). Default: true */
		autoUpdateOnCompaction?: boolean;
		/** Write-through debounce window (ms). Minimum 60s. Default: 60000 */
		debounceMs?: number;
		/** TTL for lazy refresh (days). Default: 7 */
		ttlDays?: number;
		/** Max memories sampled when building a manifest record. Default: 20 */
		sampleSize?: number;
	};
}

export interface GlobalConfig {
	accountId: string;
	/** API token value or env var name (e.g. "CLOUDFLARE_API_TOKEN"). Never commit actual secrets. */
	apiToken: string;
	/** AI Search namespace. Default: "default" */
	namespace: string;
	globalMemoryInstance: string;
	defaults?: HookSettings;
	features?: FeatureFlags;
}

/**
 * Optional, user-maintained manifest block stored inside the project marker.
 * When present, these fields OVERRIDE anything auto-derived from memories.
 */
export interface ProjectManifestOverride {
	description?: string;
	topics?: string[];
}

export interface ProjectConfig {
	// Identity (Phase 1+)
	/** Stable project id, e.g. "prj_9f2e1c". Generated on first use if missing. */
	id?: string;
	/** Human-friendly project name (slug). */
	name?: string;
	/** Alternate names the LLM might use to refer to this project. */
	aliases?: string[];
	/** Related project refs (id / name / alias). Phase 2. */
	relatedProjects?: string[];
	/** Optional workspace/group membership. Phase 4 hook. */
	workspace?: string;
	/** User-declared manifest override. */
	manifest?: ProjectManifestOverride;

	// Overrides (pre-existing)
	memoryInstance?: string;
	searchInstance?: string;
	hooks?: HookSettings;
}

export interface ResolvedConfig {
	accountId: string;
	apiToken: string;
	namespace: string;
	globalMemoryInstance: string;
	projectMemoryInstance: string;
	searchInstance: string;
	hooks: Required<HookSettings>;
	features: ResolvedFeatures;

	// Identity (Phase 1+)
	projectId: string | null;
	projectName: string;
	projectRoot: string;
	projectAliases: string[];
	relatedProjects: string[];
	workspace: string | null;
	manifestOverride: ProjectManifestOverride;
}

export interface ResolvedFeatures {
	identity: {
		autoCreateMarker: boolean;
		walkUp: boolean;
		registryEnabled: boolean;
		migrateLegacy: boolean;
	};
	recall: {
		includeRelated: boolean;
		includeDiscovered: boolean;
		discoveryThreshold: number;
		discoveryTopK: number;
		discoveryTimeoutMs: number;
	};
	manifest: {
		enabled: boolean;
		instanceId: string;
		autoUpdateOnWrite: boolean;
		autoUpdateOnSessionEnd: boolean;
		autoUpdateOnAgentStartTTL: boolean;
		autoUpdateOnCompaction: boolean;
		debounceMs: number;
		ttlDays: number;
		sampleSize: number;
	};
}

// ── Paths ──

const CONFIG_FILE = "pi-remembers.json";
const PROJECT_CONFIG_DIR = ".pi";

function globalConfigDir(): string {
	return join(homedir(), ".pi");
}

export function globalConfigPath(): string {
	return join(globalConfigDir(), CONFIG_FILE);
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, PROJECT_CONFIG_DIR, CONFIG_FILE);
}

export function globalRegistryPath(): string {
	return join(globalConfigDir(), "pi-remembers-projects.json");
}

export function dirtyFlagPath(): string {
	return join(globalConfigDir(), "pi-remembers-dirty.json");
}

// ── File IO helpers ──

function readJsonSafe<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

/** Atomic JSON write (tmp file + rename) — survives concurrent writers. */
export function writeJsonAtomic(path: string, data: unknown): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
	renameSync(tmp, path);
}

export function loadGlobalConfig(): GlobalConfig | null {
	return readJsonSafe<GlobalConfig>(globalConfigPath());
}

export function loadProjectConfig(cwd: string): ProjectConfig | null {
	return readJsonSafe<ProjectConfig>(projectConfigPath(cwd));
}

export function loadProjectConfigAt(root: string): ProjectConfig | null {
	return readJsonSafe<ProjectConfig>(projectConfigPath(root));
}

export function saveGlobalConfig(config: GlobalConfig): void {
	writeJsonAtomic(globalConfigPath(), config);
}

export function saveProjectConfig(cwd: string, config: ProjectConfig): void {
	writeJsonAtomic(projectConfigPath(cwd), config);
}

export function saveProjectConfigAt(root: string, config: ProjectConfig): void {
	writeJsonAtomic(projectConfigPath(root), config);
}

// ── Identity helpers ──

/** Slugify a project name (derived from folder basename). */
export function deriveProjectName(cwd: string): string {
	return basename(resolve(cwd)).toLowerCase().replace(/[^a-z0-9-]/g, "-") || "project";
}

/** Generate a stable, opaque project id. */
export function generateProjectId(): string {
	return `prj_${randomBytes(4).toString("hex")}`;
}

/**
 * Walk up from `cwd` looking for the nearest `.pi/pi-remembers.json` marker.
 * Stops at filesystem root or `$HOME` (we never adopt `$HOME` as a project root).
 * Returns the directory containing `.pi/pi-remembers.json`, or null.
 */
export function findProjectRoot(cwd: string): string | null {
	const home = homedir();
	let cur = resolve(cwd);
	// Avoid walking into $HOME or above it
	while (true) {
		if (cur === home) return null;
		const marker = join(cur, PROJECT_CONFIG_DIR, CONFIG_FILE);
		if (existsSync(marker)) return cur;
		const parent = dirname(cur);
		if (parent === cur) return null; // hit filesystem root
		cur = parent;
	}
}

/**
 * Ensure a project marker exists for the current session.
 *
 * Behavior (flag-gated):
 *   • If walkUp=true and a marker is found → adopt it.
 *   • Else if autoCreateMarker=true → create a marker at `cwd` with generated id/name.
 *   • Else → return synthetic identity (legacy-style, no file written).
 *
 * When creating, if a legacy basename instance is referenced elsewhere and
 * `migrateLegacy=true`, we pin `memoryInstance` to the legacy name so existing
 * data remains reachable.
 */
export function ensureProjectMarker(
	cwd: string,
	features: ResolvedFeatures["identity"],
): { root: string; config: ProjectConfig; created: boolean } {
	const root = features.walkUp ? (findProjectRoot(cwd) ?? cwd) : cwd;
	const existing = loadProjectConfigAt(root);
	if (existing) {
		// Lazy-fill missing identity on existing configs.
		if (!existing.id && features.autoCreateMarker) {
			const legacyName = existing.name ?? deriveProjectName(root);
			const filled: ProjectConfig = {
				...existing,
				id: generateProjectId(),
				name: legacyName,
			};
			// Genuine migration: an existing marker (or legacy basename-derived
			// install) may already have a `pi-remembers-proj-<name>` instance on
			// Cloudflare. Pin to it so prior data remains reachable.
			if (features.migrateLegacy && !existing.memoryInstance) {
				filled.memoryInstance = `pi-remembers-proj-${legacyName}`;
			}
			if (features.migrateLegacy && !existing.searchInstance) {
				filled.searchInstance = `pi-remembers-search-${legacyName}`;
			}
			saveProjectConfigAt(root, filled);
			return { root, config: filled, created: false };
		}
		return { root, config: existing, created: false };
	}

	if (!features.autoCreateMarker) {
		// Legacy mode: synthesize identity without writing a file.
		return {
			root: cwd,
			config: { name: deriveProjectName(cwd) },
			created: false,
		};
	}

	const name = deriveProjectName(cwd);
	const config: ProjectConfig = {
		id: generateProjectId(),
		name,
	};
	// Note: fresh markers do NOT pin to legacy basename-derived instance names —
	// two sibling folders with the same basename would collide. Let resolveConfig
	// use the id-based default instead. Migration only applies when upgrading a
	// pre-existing marker that predates the id field (see the `existing` branch).
	saveProjectConfigAt(cwd, config);
	return { root: cwd, config, created: true };
}

// ── Defaults & resolution ──

const HOOK_DEFAULTS: Required<HookSettings> = {
	autoRecall: false,
	autoIngest: false,
	showStatus: true,
};

export const FEATURE_DEFAULTS: ResolvedFeatures = {
	identity: {
		autoCreateMarker: true,
		walkUp: true,
		registryEnabled: true,
		migrateLegacy: true,
	},
	recall: {
		includeRelated: true,
		includeDiscovered: false,
		discoveryThreshold: 0.55,
		discoveryTopK: 3,
		discoveryTimeoutMs: 1500,
	},
	manifest: {
		enabled: false,
		instanceId: "pi-remembers-manifest",
		autoUpdateOnWrite: true,
		autoUpdateOnSessionEnd: true,
		autoUpdateOnAgentStartTTL: true,
		autoUpdateOnCompaction: true,
		debounceMs: 60_000,
		ttlDays: 7,
		sampleSize: 20,
	},
};

function resolveSecret(value: string): string {
	if (/^[A-Z][A-Z0-9_]+$/.test(value) && process.env[value]) {
		return process.env[value]!;
	}
	return value;
}

function resolveHooks(global: GlobalConfig, project: ProjectConfig | null): Required<HookSettings> {
	return {
		autoRecall: project?.hooks?.autoRecall ?? global.defaults?.autoRecall ?? HOOK_DEFAULTS.autoRecall,
		autoIngest: project?.hooks?.autoIngest ?? global.defaults?.autoIngest ?? HOOK_DEFAULTS.autoIngest,
		showStatus: project?.hooks?.showStatus ?? global.defaults?.showStatus ?? HOOK_DEFAULTS.showStatus,
	};
}

function resolveFeatures(global: GlobalConfig): ResolvedFeatures {
	const f = global.features ?? {};
	const debounceMsRaw = f.manifest?.debounceMs ?? FEATURE_DEFAULTS.manifest.debounceMs;
	// Enforce minimum 60s debounce.
	const debounceMs = Math.max(60_000, debounceMsRaw);
	return {
		identity: {
			autoCreateMarker: f.identity?.autoCreateMarker ?? FEATURE_DEFAULTS.identity.autoCreateMarker,
			walkUp: f.identity?.walkUp ?? FEATURE_DEFAULTS.identity.walkUp,
			registryEnabled: f.identity?.registryEnabled ?? FEATURE_DEFAULTS.identity.registryEnabled,
			migrateLegacy: f.identity?.migrateLegacy ?? FEATURE_DEFAULTS.identity.migrateLegacy,
		},
		recall: {
			includeRelated: f.recall?.includeRelated ?? FEATURE_DEFAULTS.recall.includeRelated,
			includeDiscovered: f.recall?.includeDiscovered ?? FEATURE_DEFAULTS.recall.includeDiscovered,
			discoveryThreshold: f.recall?.discoveryThreshold ?? FEATURE_DEFAULTS.recall.discoveryThreshold,
			discoveryTopK: f.recall?.discoveryTopK ?? FEATURE_DEFAULTS.recall.discoveryTopK,
			discoveryTimeoutMs: f.recall?.discoveryTimeoutMs ?? FEATURE_DEFAULTS.recall.discoveryTimeoutMs,
		},
		manifest: {
			enabled: f.manifest?.enabled ?? FEATURE_DEFAULTS.manifest.enabled,
			instanceId: f.manifest?.instanceId ?? FEATURE_DEFAULTS.manifest.instanceId,
			autoUpdateOnWrite: f.manifest?.autoUpdateOnWrite ?? FEATURE_DEFAULTS.manifest.autoUpdateOnWrite,
			autoUpdateOnSessionEnd: f.manifest?.autoUpdateOnSessionEnd ?? FEATURE_DEFAULTS.manifest.autoUpdateOnSessionEnd,
			autoUpdateOnAgentStartTTL:
				f.manifest?.autoUpdateOnAgentStartTTL ?? FEATURE_DEFAULTS.manifest.autoUpdateOnAgentStartTTL,
			autoUpdateOnCompaction: f.manifest?.autoUpdateOnCompaction ?? FEATURE_DEFAULTS.manifest.autoUpdateOnCompaction,
			debounceMs,
			ttlDays: f.manifest?.ttlDays ?? FEATURE_DEFAULTS.manifest.ttlDays,
			sampleSize: f.manifest?.sampleSize ?? FEATURE_DEFAULTS.manifest.sampleSize,
		},
	};
}

export function resolveConfig(cwd: string): ResolvedConfig | null {
	const global = loadGlobalConfig();
	if (!global) return null;

	const features = resolveFeatures(global);
	const { root, config: project } = ensureProjectMarker(cwd, features.identity);

	const projectName = project.name ?? deriveProjectName(root);
	// Prefer explicit override → id-based → name-based instance name.
	const memInstanceDefault = project.id
		? `pi-remembers-proj-${project.id}`
		: `pi-remembers-proj-${projectName}`;
	const searchInstanceDefault = project.id
		? `pi-remembers-search-${project.id}`
		: `pi-remembers-search-${projectName}`;

	return {
		accountId: global.accountId,
		apiToken: resolveSecret(global.apiToken),
		namespace: global.namespace ?? "default",
		globalMemoryInstance: global.globalMemoryInstance,
		projectMemoryInstance: project.memoryInstance ?? memInstanceDefault,
		searchInstance: project.searchInstance ?? searchInstanceDefault,
		hooks: resolveHooks(global, project),
		features,

		projectId: project.id ?? null,
		projectName,
		projectRoot: root,
		projectAliases: project.aliases ?? [],
		relatedProjects: project.relatedProjects ?? [],
		workspace: project.workspace ?? null,
		manifestOverride: project.manifest ?? {},
	};
}

export function isConfigured(): boolean {
	return loadGlobalConfig() !== null;
}
