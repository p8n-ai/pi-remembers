/**
 * Configuration management for Pi Remembers.
 *
 * Config hierarchy:
 *   1. ~/.pi/pi-remembers.json       — global (account ID, API token, namespace, defaults)
 *   2. .pi/pi-remembers.json         — project-level overrides
 *
 * Project overrides global. Absent keys fall back to global defaults.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

// ── Config types ──

export interface HookSettings {
	/** Auto-recall relevant memories before each LLM turn. Default: false */
	autoRecall?: boolean;
	/** Auto-ingest conversations into memory on compaction. Default: false */
	autoIngest?: boolean;
	/** Show 🧠 status in footer bar. Default: true */
	showStatus?: boolean;
}

export interface GlobalConfig {
	accountId: string;
	/** API token value or env var name (e.g. "CLOUDFLARE_API_TOKEN"). Never commit actual secrets. */
	apiToken: string;
	/** AI Search namespace. Default: "default" */
	namespace: string;
	globalMemoryInstance: string;
	defaults?: HookSettings;
}

export interface ProjectConfig {
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
}

// ── Paths ──

const GLOBAL_CONFIG_DIR = join(homedir(), ".pi");
const CONFIG_FILE = "pi-remembers.json";
const PROJECT_CONFIG_DIR = ".pi";

function readJsonSafe<T>(path: string): T | null {
	try {
		if (!existsSync(path)) return null;
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return null;
	}
}

function writeJson(path: string, data: unknown): void {
	const dir = join(path, "..");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

export function globalConfigPath(): string {
	return join(GLOBAL_CONFIG_DIR, CONFIG_FILE);
}

export function projectConfigPath(cwd: string): string {
	return join(cwd, PROJECT_CONFIG_DIR, CONFIG_FILE);
}

export function loadGlobalConfig(): GlobalConfig | null {
	return readJsonSafe<GlobalConfig>(globalConfigPath());
}

export function loadProjectConfig(cwd: string): ProjectConfig | null {
	return readJsonSafe<ProjectConfig>(projectConfigPath(cwd));
}

export function saveGlobalConfig(config: GlobalConfig): void {
	writeJson(globalConfigPath(), config);
}

export function saveProjectConfig(cwd: string, config: ProjectConfig): void {
	writeJson(projectConfigPath(cwd), config);
}

export function deriveProjectName(cwd: string): string {
	return basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, "-");
}

// ── Hook defaults ──

const HOOK_DEFAULTS: Required<HookSettings> = {
	autoRecall: false,
	autoIngest: false,
	showStatus: true,
};

/**
 * Resolve a secret value. If the value matches an env var name pattern,
 * read from process.env. Otherwise treat as a literal.
 */
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

export function resolveConfig(cwd: string): ResolvedConfig | null {
	const global = loadGlobalConfig();
	if (!global) return null;

	const project = loadProjectConfig(cwd);
	const projectName = deriveProjectName(cwd);

	return {
		accountId: global.accountId,
		apiToken: resolveSecret(global.apiToken),
		namespace: global.namespace ?? "default",
		globalMemoryInstance: global.globalMemoryInstance,
		projectMemoryInstance: project?.memoryInstance ?? `pi-remembers-proj-${projectName}`,
		searchInstance: project?.searchInstance ?? `pi-remembers-search-${projectName}`,
		hooks: resolveHooks(global, project),
	};
}

export function isConfigured(): boolean {
	return loadGlobalConfig() !== null;
}
