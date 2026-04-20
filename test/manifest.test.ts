/**
 * Manifest tests — build, publish, discover, debounce, dirty flags.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { makeSandbox, mkdir, writeGlobalConfig, writeProjectMarker, defaultGlobalConfig } from "./helpers.ts";
import { makeMockClient } from "./mock-client.ts";
import { resolveConfig, dirtyFlagPath } from "../src/config.ts";
import {
	buildManifest,
	publishManifest,
	refreshManifest,
	discoverProjects,
	createDebouncer,
	markDirty,
	clearDirty,
	listDirty,
	loadDirty,
	manifestDocKey,
} from "../src/manifest.ts";

function setupProject(sb: { home: string; workspace: string }, features: Record<string, unknown> = {}) {
	writeGlobalConfig(sb.home, defaultGlobalConfig({ features }));
	const cwd = mkdir(join(sb.workspace, "proj"));
	writeProjectMarker(cwd, {
		id: "prj_abcd1234",
		name: "proj",
		aliases: ["p", "project"],
	});
	return { cwd, config: resolveConfig(cwd)! };
}

test("manifest — dirty flag lifecycle", () => {
	const sb = makeSandbox();
	try {
		markDirty("prj_11111111");
		markDirty("prj_22222222");
		assert.deepEqual(listDirty().sort(), ["prj_11111111", "prj_22222222"]);
		clearDirty("prj_11111111");
		assert.deepEqual(listDirty(), ["prj_22222222"]);
		// Persisted
		const loaded = loadDirty();
		assert.ok(loaded.projects["prj_22222222"]);
		// File exists
		assert.equal(existsSync(dirtyFlagPath()), true);
	} finally {
		sb.cleanup();
	}
});

test("manifest — buildManifest uses user-declared overrides", async () => {
	const sb = makeSandbox();
	try {
		writeGlobalConfig(sb.home, defaultGlobalConfig());
		const cwd = mkdir(join(sb.workspace, "proj"));
		writeProjectMarker(cwd, {
			id: "prj_abcd1234",
			name: "proj",
			manifest: {
				description: "Owns payments + stripe webhooks.",
				topics: ["payments", "stripe"],
			},
		});
		const config = resolveConfig(cwd)!;
		const client = makeMockClient();
		const rec = await buildManifest(client, config);
		assert.equal(rec.id, "prj_abcd1234");
		assert.equal(rec.description, "Owns payments + stripe webhooks.");
		assert.ok(rec.topics.includes("payments"));
		assert.ok(rec.topics.includes("stripe"));
	} finally {
		sb.cleanup();
	}
});

test("manifest — buildManifest with no memories yields default description", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb);
		const client = makeMockClient();
		const rec = await buildManifest(client, config);
		assert.match(rec.description, /no memories/i);
		assert.equal(rec.memoryCount, 0);
	} finally {
		sb.cleanup();
	}
});

test("manifest — buildManifest counts memories and does NOT leak bodies", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb);
		const client = makeMockClient();
		await client.remember(config.projectMemoryInstance, "API_KEY=supersecret_leak_me", { scope: "project" });
		await client.remember(config.projectMemoryInstance, "Another memory", { scope: "project" });
		const rec = await buildManifest(client, config);
		assert.equal(rec.memoryCount, 2);
		// Critical: raw content must not appear in derived manifest fields.
		const blob = JSON.stringify(rec);
		assert.doesNotMatch(blob, /supersecret_leak_me/i);
		assert.doesNotMatch(blob, /API_KEY/);
	} finally {
		sb.cleanup();
	}
});

test("manifest — publishManifest uploads to configured instance with stable key", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb, { manifest: { enabled: true } });
		const client = makeMockClient();
		const rec = await buildManifest(client, config);
		await publishManifest(client, config, rec);
		const instance = config.features.manifest.instanceId;
		const list = await client.listMemories(instance);
		assert.equal(list.count, 1);
		assert.equal(list.items[0].key, manifestDocKey("prj_abcd1234"));
	} finally {
		sb.cleanup();
	}
});

test("manifest — republish overwrites prior record (by key deletion)", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb, { manifest: { enabled: true } });
		const client = makeMockClient();
		await publishManifest(client, config, await buildManifest(client, config));
		await publishManifest(client, config, await buildManifest(client, config));
		const list = await client.listMemories(config.features.manifest.instanceId);
		assert.equal(list.count, 1, "republishing should replace prior record");
	} finally {
		sb.cleanup();
	}
});

test("manifest — refreshManifest is a no-op when disabled", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb /* enabled: false by default */);
		const client = makeMockClient();
		const rec = await refreshManifest(client, config);
		assert.equal(rec, null);
		assert.equal(client._calls.find((c) => c.name === "uploadFile"), undefined);
	} finally {
		sb.cleanup();
	}
});

test("manifest — refreshManifest clears dirty flag", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb, { manifest: { enabled: true } });
		markDirty("prj_abcd1234");
		assert.ok(listDirty().includes("prj_abcd1234"));
		const client = makeMockClient();
		await refreshManifest(client, config);
		assert.ok(!listDirty().includes("prj_abcd1234"));
	} finally {
		sb.cleanup();
	}
});

test("manifest — discoverProjects returns nothing when disabled", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb /* disabled */);
		const client = makeMockClient();
		const hits = await discoverProjects(client, config, "anything");
		assert.deepEqual(hits, []);
	} finally {
		sb.cleanup();
	}
});

test("manifest — discoverProjects filters by threshold and topK", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb, {
			manifest: { enabled: true },
			recall: { discoveryThreshold: 0.6, discoveryTopK: 2 },
		});
		const client = makeMockClient();
		// Wire mock recall with synthetic chunks keyed to projects.
		client._mockRecall = () => [
			{ id: "1", type: "chunk", score: 0.9, text: "A", item: { key: "manifest-prj_aaaaaaaa.json" } },
			{ id: "2", type: "chunk", score: 0.7, text: "B", item: { key: "manifest-prj_bbbbbbbb.json" } },
			{ id: "3", type: "chunk", score: 0.5, text: "C", item: { key: "manifest-prj_cccccccc.json" } },
			{ id: "4", type: "chunk", score: 0.4, text: "D", item: { key: "manifest-prj_dddddddd.json" } },
		];
		const hits = await discoverProjects(client, config, "q");
		assert.equal(hits.length, 2);
		assert.deepEqual(
			hits.map((h) => h.projectId),
			["prj_aaaaaaaa", "prj_bbbbbbbb"],
		);
	} finally {
		sb.cleanup();
	}
});

test("manifest — discoverProjects ignores chunks without a manifest doc key", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb, { manifest: { enabled: true } });
		const client = makeMockClient();
		client._mockRecall = () => [
			{ id: "1", type: "chunk", score: 0.9, text: "x", item: { key: "some-random-doc.md" } },
		];
		const hits = await discoverProjects(client, config, "q");
		assert.deepEqual(hits, []);
	} finally {
		sb.cleanup();
	}
});

test("debouncer — schedule then flush publishes manifest", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb, { manifest: { enabled: true } });
		const client = makeMockClient();
		const d = createDebouncer(
			() => client,
			() => config,
		);
		d.schedule("prj_abcd1234");
		assert.ok(listDirty().includes("prj_abcd1234"), "schedule marks dirty immediately");
		await d.flush("prj_abcd1234");
		const uploads = client._calls.filter((c) => c.name === "uploadFile");
		assert.equal(uploads.length, 1);
		// Dirty cleared post-flush
		assert.ok(!listDirty().includes("prj_abcd1234"));
	} finally {
		sb.cleanup();
	}
});

test("debouncer — multiple schedule calls collapse to one flush", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb, { manifest: { enabled: true } });
		const client = makeMockClient();
		const d = createDebouncer(
			() => client,
			() => config,
		);
		for (let i = 0; i < 5; i++) d.schedule("prj_abcd1234");
		await d.flushAll();
		const uploads = client._calls.filter((c) => c.name === "uploadFile");
		assert.equal(uploads.length, 1);
	} finally {
		sb.cleanup();
	}
});

test("debouncer — no-op when disabled (no dirty marking)", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb /* disabled */);
		const client = makeMockClient();
		const d = createDebouncer(
			() => client,
			() => config,
		);
		d.schedule("prj_abcd1234");
		assert.ok(!listDirty().includes("prj_abcd1234"));
		await d.flushAll();
		assert.equal(client._calls.filter((c) => c.name === "uploadFile").length, 0);
	} finally {
		sb.cleanup();
	}
});

test("debouncer — schedule ignored when autoUpdateOnWrite=false", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb, {
			manifest: { enabled: true, autoUpdateOnWrite: false },
		});
		const client = makeMockClient();
		const d = createDebouncer(
			() => client,
			() => config,
		);
		d.schedule("prj_abcd1234");
		assert.ok(!listDirty().includes("prj_abcd1234"));
	} finally {
		sb.cleanup();
	}
});

test("debouncer — project id mismatch → skips flush but preserves dirty flag", async () => {
	const sb = makeSandbox();
	try {
		const { config } = setupProject(sb, { manifest: { enabled: true } });
		const client = makeMockClient();
		const d = createDebouncer(
			() => client,
			() => config,
		);
		// Simulate another project scheduled during this session (shouldn't happen,
		// but config is bound to prj_abcd1234 — a different id must not publish).
		d.schedule("prj_abcd1234"); // marks dirty for our id
		// Then force-flush a different id:
		await d.flush("prj_zzzzzzzz");
		const uploads = client._calls.filter((c) => c.name === "uploadFile");
		assert.equal(uploads.length, 0);
		// Our own project remains dirty, still pending.
		assert.ok(listDirty().includes("prj_abcd1234"));
		d.cancelAll();
	} finally {
		sb.cleanup();
	}
});
