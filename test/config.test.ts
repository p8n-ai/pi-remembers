/**
 * Config & identity tests — findProjectRoot, ensureProjectMarker, resolveConfig.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { makeSandbox, mkdir, writeGlobalConfig, writeProjectMarker, defaultGlobalConfig } from "./helpers.ts";
import {
	findProjectRoot,
	ensureProjectMarker,
	resolveConfig,
	deriveProjectName,
	generateProjectId,
	FEATURE_DEFAULTS,
	projectConfigPath,
} from "../src/config.ts";

test("deriveProjectName slugifies", () => {
	assert.equal(deriveProjectName("/tmp/My Project_v2"), "my-project-v2");
	assert.equal(deriveProjectName("/tmp/"), "tmp");
});

test("generateProjectId produces prj_<8hex>", () => {
	for (let i = 0; i < 20; i++) {
		const id = generateProjectId();
		assert.match(id, /^prj_[a-f0-9]{8}$/);
	}
});

test("findProjectRoot — returns nearest marker walking up", () => {
	const sb = makeSandbox();
	try {
		const root = mkdir(join(sb.workspace, "repo"));
		const sub = mkdir(join(root, "packages", "api"));
		writeProjectMarker(root, { id: "prj_aaaaaaaa", name: "repo" });
		assert.equal(findProjectRoot(sub), root);
		assert.equal(findProjectRoot(root), root);
	} finally {
		sb.cleanup();
	}
});

test("findProjectRoot — stops at $HOME", () => {
	const sb = makeSandbox();
	try {
		// No marker anywhere; walking up from inside HOME should return null
		const sub = mkdir(join(sb.home, "some", "dir"));
		assert.equal(findProjectRoot(sub), null);
	} finally {
		sb.cleanup();
	}
});

test("findProjectRoot — nested markers: inner wins", () => {
	const sb = makeSandbox();
	try {
		const outer = mkdir(join(sb.workspace, "outer"));
		const inner = mkdir(join(outer, "inner"));
		const deep = mkdir(join(inner, "deep"));
		writeProjectMarker(outer, { id: "prj_outerxx", name: "outer" });
		writeProjectMarker(inner, { id: "prj_innerxx", name: "inner" });
		assert.equal(findProjectRoot(deep), inner);
		assert.equal(findProjectRoot(outer), outer);
	} finally {
		sb.cleanup();
	}
});

test("ensureProjectMarker — autoCreateMarker=false does not write a file", () => {
	const sb = makeSandbox();
	try {
		const cwd = mkdir(join(sb.workspace, "fresh"));
		const res = ensureProjectMarker(cwd, { ...FEATURE_DEFAULTS.identity, autoCreateMarker: false });
		assert.equal(res.created, false);
		assert.equal(res.config.id, undefined);
		assert.equal(existsSync(projectConfigPath(cwd)), false);
	} finally {
		sb.cleanup();
	}
});

test("ensureProjectMarker — creates marker at cwd when missing", () => {
	const sb = makeSandbox();
	try {
		const cwd = mkdir(join(sb.workspace, "brand-new"));
		const res = ensureProjectMarker(cwd, FEATURE_DEFAULTS.identity);
		assert.equal(res.created, true);
		assert.match(res.config.id!, /^prj_/);
		assert.equal(res.config.name, "brand-new");
		// File exists
		assert.equal(existsSync(projectConfigPath(cwd)), true);
		// Fresh markers use id-based instance naming to avoid basename collisions
		// across sibling projects. Migration pinning only applies to upgrades.
		assert.equal(res.config.memoryInstance, undefined);
	} finally {
		sb.cleanup();
	}
});

test("ensureProjectMarker — lazy-fills id for existing marker without id", () => {
	const sb = makeSandbox();
	try {
		const cwd = mkdir(join(sb.workspace, "legacy"));
		writeProjectMarker(cwd, { hooks: { autoRecall: true } });
		const res = ensureProjectMarker(cwd, FEATURE_DEFAULTS.identity);
		assert.match(res.config.id!, /^prj_/);
		assert.equal(res.config.name, "legacy");
		// Preserves prior hooks
		assert.equal(res.config.hooks?.autoRecall, true);
		// Written back
		const onDisk = JSON.parse(readFileSync(projectConfigPath(cwd), "utf-8"));
		assert.equal(onDisk.id, res.config.id);
		// Migration pinning applied because the existing marker had no instance override.
		assert.equal(res.config.memoryInstance, "pi-remembers-proj-legacy");
	} finally {
		sb.cleanup();
	}
});

test("resolveConfig — subfolder resolves to marker-rooted identity", () => {
	const sb = makeSandbox();
	try {
		writeGlobalConfig(sb.home, defaultGlobalConfig());
		const root = mkdir(join(sb.workspace, "repo"));
		const sub = mkdir(join(root, "packages", "api"));
		writeProjectMarker(root, { id: "prj_abcdef01", name: "repo" });
		const cfgRoot = resolveConfig(root);
		const cfgSub = resolveConfig(sub);
		assert.ok(cfgRoot && cfgSub);
		assert.equal(cfgRoot.projectId, "prj_abcdef01");
		assert.equal(cfgSub.projectId, "prj_abcdef01");
		assert.equal(cfgRoot.projectMemoryInstance, cfgSub.projectMemoryInstance);
		assert.equal(cfgSub.projectRoot, root);
	} finally {
		sb.cleanup();
	}
});

test("resolveConfig — legacy override pins instance name", () => {
	const sb = makeSandbox();
	try {
		writeGlobalConfig(sb.home, defaultGlobalConfig());
		const cwd = mkdir(join(sb.workspace, "legacy-repo"));
		writeProjectMarker(cwd, {
			id: "prj_11111111",
			name: "legacy-repo",
			memoryInstance: "pi-remembers-proj-legacy-repo", // legacy name
		});
		const cfg = resolveConfig(cwd);
		assert.ok(cfg);
		assert.equal(cfg.projectMemoryInstance, "pi-remembers-proj-legacy-repo");
	} finally {
		sb.cleanup();
	}
});

test("resolveConfig — uses id-based instance when no override", () => {
	const sb = makeSandbox();
	try {
		writeGlobalConfig(sb.home, defaultGlobalConfig());
		const cwd = mkdir(join(sb.workspace, "fresh"));
		writeProjectMarker(cwd, { id: "prj_99999999", name: "fresh" });
		const cfg = resolveConfig(cwd);
		assert.ok(cfg);
		assert.equal(cfg.projectMemoryInstance, "pi-remembers-proj-prj_99999999");
	} finally {
		sb.cleanup();
	}
});

test("resolveConfig — feature defaults applied when global has no features block", () => {
	const sb = makeSandbox();
	try {
		writeGlobalConfig(sb.home, defaultGlobalConfig());
		const cwd = mkdir(join(sb.workspace, "p"));
		const cfg = resolveConfig(cwd);
		assert.ok(cfg);
		assert.equal(cfg.features.identity.walkUp, true);
		assert.equal(cfg.features.recall.includeRelated, true);
		assert.equal(cfg.features.recall.includeDiscovered, false);
		assert.equal(cfg.features.manifest.enabled, false);
	} finally {
		sb.cleanup();
	}
});

test("resolveConfig — debounceMs enforces 60s minimum", () => {
	const sb = makeSandbox();
	try {
		writeGlobalConfig(
			sb.home,
			defaultGlobalConfig({
				features: { manifest: { debounceMs: 5_000 } },
			}),
		);
		const cwd = mkdir(join(sb.workspace, "p"));
		const cfg = resolveConfig(cwd);
		assert.ok(cfg);
		assert.equal(cfg.features.manifest.debounceMs, 60_000);
	} finally {
		sb.cleanup();
	}
});

test("resolveConfig — no global config → null", () => {
	const sb = makeSandbox();
	try {
		assert.equal(resolveConfig(sb.workspace), null);
	} finally {
		sb.cleanup();
	}
});

test("resolveConfig — two sibling folders with same basename → distinct ids", () => {
	const sb = makeSandbox();
	try {
		writeGlobalConfig(sb.home, defaultGlobalConfig());
		const a = mkdir(join(sb.workspace, "alpha", "api"));
		const b = mkdir(join(sb.workspace, "beta", "api"));
		// Auto-create markers
		const ca = resolveConfig(a);
		const cb = resolveConfig(b);
		assert.ok(ca && cb);
		assert.notEqual(ca.projectId, cb.projectId);
		assert.notEqual(ca.projectMemoryInstance, cb.projectMemoryInstance);
	} finally {
		sb.cleanup();
	}
});

test("resolveConfig — autoCreateMarker=false keeps legacy basename behavior", () => {
	const sb = makeSandbox();
	try {
		writeGlobalConfig(
			sb.home,
			defaultGlobalConfig({ features: { identity: { autoCreateMarker: false, walkUp: false } } }),
		);
		const cwd = mkdir(join(sb.workspace, "legacy-dir"));
		const cfg = resolveConfig(cwd);
		assert.ok(cfg);
		assert.equal(cfg.projectId, null);
		assert.equal(cfg.projectName, "legacy-dir");
		assert.equal(cfg.projectMemoryInstance, "pi-remembers-proj-legacy-dir");
		// No file was written
		assert.equal(existsSync(projectConfigPath(cwd)), false);
	} finally {
		sb.cleanup();
	}
});
