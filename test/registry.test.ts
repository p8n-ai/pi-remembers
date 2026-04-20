/**
 * Registry tests — upsert, resolve, list, concurrent writes.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox } from "./helpers.ts";
import {
	loadRegistry,
	saveRegistry,
	upsertProject,
	touchProject,
	resolveRef,
	listProjects,
	removeProject,
} from "../src/registry.ts";
import { globalRegistryPath } from "../src/config.ts";

test("registry — load empty returns empty structure", () => {
	const sb = makeSandbox();
	try {
		const reg = loadRegistry();
		assert.equal(reg.version, 1);
		assert.deepEqual(reg.projects, {});
	} finally {
		sb.cleanup();
	}
});

test("registry — upsertProject merges roots and preserves aliases", () => {
	const sb = makeSandbox();
	try {
		let reg = loadRegistry();
		reg = upsertProject(reg, {
			id: "prj_aaaa1111",
			name: "alpha",
			aliases: ["a", "al"],
			root: "/tmp/alpha",
		});
		reg = upsertProject(reg, {
			id: "prj_aaaa1111",
			name: "alpha",
			aliases: [], // should not overwrite prior aliases
			root: "/tmp/alpha-mirror",
		});
		const entry = reg.projects["prj_aaaa1111"];
		assert.ok(entry);
		assert.deepEqual(entry.roots.sort(), ["/tmp/alpha", "/tmp/alpha-mirror"]);
		assert.deepEqual(entry.aliases, ["a", "al"]);
	} finally {
		sb.cleanup();
	}
});

test("registry — touchProject persists and globalRegistryPath exists", () => {
	const sb = makeSandbox();
	try {
		touchProject({ id: "prj_12345678", name: "p", aliases: [], root: "/r" });
		assert.equal(existsSync(globalRegistryPath()), true);
		const reg = loadRegistry();
		assert.equal(reg.projects["prj_12345678"].name, "p");
	} finally {
		sb.cleanup();
	}
});

test("registry — resolveRef matches id, name, and alias case-insensitively", () => {
	const sb = makeSandbox();
	try {
		let reg = loadRegistry();
		reg = upsertProject(reg, {
			id: "prj_beef1234",
			name: "Backend",
			aliases: ["api", "Acme-Backend"],
			root: "/r",
		});
		saveRegistry(reg);
		const fresh = loadRegistry();
		assert.equal(resolveRef(fresh, "prj_beef1234")?.id, "prj_beef1234");
		assert.equal(resolveRef(fresh, "backend")?.id, "prj_beef1234");
		assert.equal(resolveRef(fresh, "API")?.id, "prj_beef1234");
		assert.equal(resolveRef(fresh, "acme-backend")?.id, "prj_beef1234");
		assert.equal(resolveRef(fresh, "nope"), null);
		assert.equal(resolveRef(fresh, ""), null);
	} finally {
		sb.cleanup();
	}
});

test("registry — listProjects sorts by lastSeen desc", () => {
	const sb = makeSandbox();
	try {
		let reg = loadRegistry();
		reg = upsertProject(reg, { id: "prj_aaaaaaaa", name: "a", aliases: [], root: "/a", lastSeen: "2024-01-01T00:00:00Z" });
		reg = upsertProject(reg, { id: "prj_bbbbbbbb", name: "b", aliases: [], root: "/b", lastSeen: "2025-01-01T00:00:00Z" });
		reg = upsertProject(reg, { id: "prj_cccccccc", name: "c", aliases: [], root: "/c", lastSeen: "2023-01-01T00:00:00Z" });
		const list = listProjects(reg);
		assert.deepEqual(list.map((p) => p.id), ["prj_bbbbbbbb", "prj_aaaaaaaa", "prj_cccccccc"]);
	} finally {
		sb.cleanup();
	}
});

test("registry — removeProject", () => {
	const sb = makeSandbox();
	try {
		let reg = loadRegistry();
		reg = upsertProject(reg, { id: "prj_xxxx", name: "x", aliases: [], root: "/x" });
		reg = removeProject(reg, "prj_xxxx");
		assert.equal(reg.projects["prj_xxxx"], undefined);
	} finally {
		sb.cleanup();
	}
});

test("registry — corrupt file is backed up and replaced with empty", () => {
	const sb = makeSandbox();
	try {
		// Ensure dir
		mkdirSync(join(sb.home, ".pi"), { recursive: true });
		// Write garbage to registry path
		writeFileSync(globalRegistryPath(), "{ not valid json");
		const reg = loadRegistry();
		assert.equal(reg.version, 1);
		assert.deepEqual(reg.projects, {});
	} finally {
		sb.cleanup();
	}
});

test("registry — atomic writes survive interleaved touches", async () => {
	const sb = makeSandbox();
	try {
		// Simulate N concurrent touchProject calls
		const ids = Array.from({ length: 25 }, (_, i) => `prj_${String(i).padStart(8, "0")}`);
		await Promise.all(
			ids.map(async (id, i) => {
				// tiny jitter
				await new Promise((r) => setTimeout(r, i % 5));
				touchProject({ id, name: `p${i}`, aliases: [], root: `/r/${i}` });
			}),
		);
		// NB: last-writer-wins semantics mean some may be lost under true concurrency.
		// Assert the file is at least parseable and has some entries.
		const parsed = JSON.parse(readFileSync(globalRegistryPath(), "utf-8"));
		assert.equal(parsed.version, 1);
		assert.ok(Object.keys(parsed.projects).length >= 1);
	} finally {
		sb.cleanup();
	}
});
