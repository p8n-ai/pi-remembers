/**
 * Regression gate — verify that an existing user with no opt-in flags sees
 * byte-identical recall/remember behavior to the pre-Phase-1 implementation.
 *
 * "Existing user" = fresh install, then setup, then a dir used as before.
 * The contract:
 *   • remember(scope=project) → writes to pi-remembers-proj-<basename>.
 *   • recall (scope=both default) → searches project + global only.
 *   • No other instances are touched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeSandbox, mkdir, writeGlobalConfig, defaultGlobalConfig } from "./helpers.ts";
import { makeMockClient } from "./mock-client.ts";
import { makeMockAPI } from "./mock-api.ts";
import { resolveConfig } from "../src/config.ts";
import { registerRecallTool } from "../src/tools/recall.ts";
import { registerRememberTool } from "../src/tools/remember.ts";

test("regression — new user (no marker) remember+recall uses basename instance only", async () => {
	const sb = makeSandbox();
	try {
		writeGlobalConfig(sb.home, defaultGlobalConfig());
		const cwd = mkdir(join(sb.workspace, "my-app"));
		// First resolve auto-creates a marker — but migrateLegacy pinning does NOT
		// apply to fresh markers, so the instance is id-based. That's the Phase 1
		// behavior: sibling folders with same basename don't collide.
		// To simulate a TRUE legacy user (pre-Phase-1), we seed a markerless
		// install: set autoCreateMarker=false so the plugin stays in legacy mode.
		const noAutoGlobal = defaultGlobalConfig({
			features: { identity: { autoCreateMarker: false, walkUp: false } },
		});
		writeGlobalConfig(sb.home, noAutoGlobal);

		const cfg = resolveConfig(cwd)!;
		// Legacy instance naming preserved
		assert.equal(cfg.projectMemoryInstance, "pi-remembers-proj-my-app");
		assert.equal(cfg.projectId, null);

		const client = makeMockClient();
		const api = makeMockAPI();
		registerRememberTool(api, () => client, () => cfg);
		registerRecallTool(api, () => client, () => cfg);

		await api.invoke("memory_remember", { content: "x" });
		await api.invoke("memory_recall", { query: "x" });

		const remembers = client._calls.filter((c) => c.name === "remember");
		const recalls = client._calls.filter((c) => c.name === "recall");
		assert.equal(remembers.length, 1);
		assert.equal(remembers[0].args[0], "pi-remembers-proj-my-app");
		assert.equal(recalls.length, 1);
		const recallInstances = (recalls[0].args[0] as string[]).sort();
		assert.deepEqual(recallInstances, ["pi-remembers-global", "pi-remembers-proj-my-app"]);
	} finally {
		sb.cleanup();
	}
});

test("regression — manifest/discovery disabled by default: no manifest API traffic", async () => {
	const sb = makeSandbox();
	try {
		writeGlobalConfig(sb.home, defaultGlobalConfig());
		const cwd = mkdir(join(sb.workspace, "app"));
		const cfg = resolveConfig(cwd)!;

		const client = makeMockClient();
		const api = makeMockAPI();
		registerRememberTool(api, () => client, () => cfg);
		registerRecallTool(api, () => client, () => cfg);

		await api.invoke("memory_remember", { content: "something" });
		await api.invoke("memory_recall", { query: "something" });

		// Manifest instance must never be ensured/uploaded/recalled.
		const manifestInstance = cfg.features.manifest.instanceId;
		const touched = client._calls.some((c) => {
			if (c.name === "recall") return (c.args[0] as string[]).includes(manifestInstance);
			if (c.name === "uploadFile" || c.name === "ensureInstance") return c.args[0] === manifestInstance;
			return false;
		});
		assert.equal(touched, false, "manifest instance should not be touched with default flags");
	} finally {
		sb.cleanup();
	}
});
