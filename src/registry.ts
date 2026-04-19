/**
 * Local project registry — `~/.pi/pi-remembers-projects.json`.
 *
 * Rebuildable cache mapping known project ids to their identity + last-seen
 * roots. Used for:
 *   • Enumerating known projects (memory_list_projects tool).
 *   • Resolving cross-project refs by name/alias in memory_recall.
 *
 * Contains NO memory content — only identity metadata. Losing it is harmless;
 * it will repopulate as sessions touch their projects.
 */

import { existsSync, readFileSync } from "node:fs";
import { globalRegistryPath, writeJsonAtomic } from "./config.js";

export interface RegistryEntry {
	id: string;
	name: string;
	aliases: string[];
	/** Distinct filesystem roots seen for this project (machine-local). */
	roots: string[];
	/** ISO timestamp of last touch. */
	lastSeen: string;
	/** Memory instance this project writes to (cached for cross-project recall). */
	memoryInstance?: string;
	/** Workspace group (optional). */
	workspace?: string;
}

export interface RegistryFile {
	version: 1;
	projects: Record<string, RegistryEntry>;
}

const EMPTY: RegistryFile = { version: 1, projects: {} };

export function loadRegistry(): RegistryFile {
	const path = globalRegistryPath();
	if (!existsSync(path)) return { ...EMPTY, projects: {} };
	try {
		const raw = JSON.parse(readFileSync(path, "utf-8")) as RegistryFile;
		if (!raw || raw.version !== 1 || typeof raw.projects !== "object") {
			return { ...EMPTY, projects: {} };
		}
		return raw;
	} catch {
		// Corrupt registry — back up and start fresh.
		try {
			const backup = `${path}.bak-${Date.now()}`;
			writeJsonAtomic(backup, { note: "corrupt registry, original preserved below", raw: readFileSync(path, "utf-8") });
		} catch {
			// best-effort
		}
		return { ...EMPTY, projects: {} };
	}
}

export function saveRegistry(reg: RegistryFile): void {
	writeJsonAtomic(globalRegistryPath(), reg);
}

/** Upsert identity for a project. Returns the updated registry (not saved). */
export function upsertProject(
	reg: RegistryFile,
	entry: Omit<RegistryEntry, "lastSeen" | "roots"> & { root: string; lastSeen?: string },
): RegistryFile {
	const prev = reg.projects[entry.id];
	const roots = new Set(prev?.roots ?? []);
	roots.add(entry.root);
	const merged: RegistryEntry = {
		id: entry.id,
		name: entry.name,
		aliases: entry.aliases && entry.aliases.length > 0 ? entry.aliases : prev?.aliases ?? [],
		roots: [...roots],
		lastSeen: entry.lastSeen ?? new Date().toISOString(),
		memoryInstance: entry.memoryInstance ?? prev?.memoryInstance,
		workspace: entry.workspace ?? prev?.workspace,
	};
	return { ...reg, projects: { ...reg.projects, [entry.id]: merged } };
}

/** Persist a single touch atomically (load+merge+save). */
export function touchProject(
	entry: Omit<RegistryEntry, "lastSeen" | "roots"> & { root: string },
): void {
	const reg = loadRegistry();
	saveRegistry(upsertProject(reg, entry));
}

/** Resolve a ref (id, name, or alias) to an entry. Case-insensitive. */
export function resolveRef(reg: RegistryFile, ref: string): RegistryEntry | null {
	const needle = ref.trim().toLowerCase();
	if (!needle) return null;
	const direct = reg.projects[ref];
	if (direct) return direct;
	for (const p of Object.values(reg.projects)) {
		if (p.id.toLowerCase() === needle) return p;
		if (p.name.toLowerCase() === needle) return p;
		if (p.aliases.some((a) => a.toLowerCase() === needle)) return p;
	}
	return null;
}

/** List all projects, sorted by lastSeen desc. */
export function listProjects(reg: RegistryFile): RegistryEntry[] {
	return Object.values(reg.projects).sort((a, b) =>
		(b.lastSeen ?? "").localeCompare(a.lastSeen ?? ""),
	);
}

/** Remove a project from the registry. */
export function removeProject(reg: RegistryFile, id: string): RegistryFile {
	if (!reg.projects[id]) return reg;
	const next = { ...reg.projects };
	delete next[id];
	return { ...reg, projects: next };
}
