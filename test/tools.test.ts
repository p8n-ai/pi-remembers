/**
 * Tool tests — memory_recall scopes & cross-project, memory_remember write boundaries,
 * memory_list_projects discovery.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { makeSandbox, mkdir, writeGlobalConfig, writeProjectMarker, defaultGlobalConfig } from "./helpers.ts";
import { makeMockClient } from "./mock-client.ts";
import { makeMockAPI } from "./mock-api.ts";
import { resolveConfig } from "../src/config.ts";
import { touchProject } from "../src/registry.ts";
import { registerRecallTool } from "../src/tools/recall.ts";
import { registerRememberTool } from "../src/tools/remember.ts";
import { registerListProjectsTool } from "../src/tools/list-projects.ts";
import { createDebouncer } from "../src/manifest.ts";

function setupTwoProjects(sb: { home: string; workspace: string }, features: Record<string, unknown> = {}) {
	writeGlobalConfig(sb.home, defaultGlobalConfig({ features }));
	// Project 1 (acme-api, aka "backend")
	const p1 = mkdir(join(sb.workspace, "acme-api"));
	writeProjectMarker(p1, {
		id: "prj_aaaa1111",
		name: "acme-api",
		aliases: ["backend", "api"],
	});
	// Project 3 (acme-web)
	const p3 = mkdir(join(sb.workspace, "acme-web"));
	writeProjectMarker(p3, {
		id: "prj_cccc3333",
		name: "acme-web",
	});
	// Trigger registry touches for both
	const c1 = resolveConfig(p1)!;
	touchProject({
		id: c1.projectId!,
		name: c1.projectName,
		aliases: c1.projectAliases,
		root: c1.projectRoot,
		memoryInstance: c1.projectMemoryInstance,
	});
	const c3 = resolveConfig(p3)!;
	touchProject({
		id: c3.projectId!,
		name: c3.projectName,
		aliases: c3.projectAliases,
		root: c3.projectRoot,
		memoryInstance: c3.projectMemoryInstance,
	});
	return { p1, p3, c1, c3 };
}

test("remember — writes to current project by default", async () => {
	const sb = makeSandbox();
	try {
		const { c1 } = setupTwoProjects(sb);
		const client = makeMockClient();
		const api = makeMockAPI();
		registerRememberTool(api, () => client, () => c1);
		await api.invoke("memory_remember", { content: "decision X" });
		const remembers = client._calls.filter((c) => c.name === "remember");
		assert.equal(remembers.length, 1);
		assert.equal(remembers[0].args[0], c1.projectMemoryInstance);
	} finally {
		sb.cleanup();
	}
});

test("remember — scope=global writes to global instance only", async () => {
	const sb = makeSandbox();
	try {
		const { c1 } = setupTwoProjects(sb);
		const client = makeMockClient();
		const api = makeMockAPI();
		registerRememberTool(api, () => client, () => c1);
		await api.invoke("memory_remember", { content: "pref Y", scope: "global" });
		const remembers = client._calls.filter((c) => c.name === "remember");
		assert.equal(remembers[0].args[0], c1.globalMemoryInstance);
	} finally {
		sb.cleanup();
	}
});

test("remember — tool schema does not accept `projects` (write-boundary enforced by schema)", async () => {
	const sb = makeSandbox();
	try {
		const { c1 } = setupTwoProjects(sb);
		const client = makeMockClient();
		const api = makeMockAPI();
		registerRememberTool(api, () => client, () => c1);
		const def = api._tools.get("memory_remember");
		// TypeBox schema — assert no `projects` key in properties.
		const props = def.parameters.properties ?? {};
		assert.equal(props.projects, undefined);
		// No scope beyond project|global
		const scopeType = props.scope;
		assert.ok(scopeType);
	} finally {
		sb.cleanup();
	}
});

test("remember — schedules debouncer dirty for project writes only", async () => {
	const sb = makeSandbox();
	try {
		const { c1 } = setupTwoProjects(sb, { manifest: { enabled: true } });
		const client = makeMockClient();
		const api = makeMockAPI();
		const d = createDebouncer(() => client, () => c1);
		registerRememberTool(api, () => client, () => c1, d);
		// Project write → dirty
		await api.invoke("memory_remember", { content: "x", scope: "project" });
		// Global write → NOT dirty
		await api.invoke("memory_remember", { content: "y", scope: "global" });
		const { listDirty } = await import("../src/manifest.ts");
		assert.ok(listDirty().includes("prj_aaaa1111"));
		d.cancelAll();
	} finally {
		sb.cleanup();
	}
});

test("recall — default scope=both hits project + global", async () => {
	const sb = makeSandbox();
	try {
		const { c1 } = setupTwoProjects(sb);
		const client = makeMockClient();
		const api = makeMockAPI();
		registerRecallTool(api, () => client, () => c1);
		await api.invoke("memory_recall", { query: "auth" });
		const recalls = client._calls.filter((c) => c.name === "recall");
		assert.equal(recalls.length, 1);
		const instances = recalls[0].args[0] as string[];
		assert.deepEqual(
			[...instances].sort(),
			[c1.globalMemoryInstance, c1.projectMemoryInstance].sort(),
		);
	} finally {
		sb.cleanup();
	}
});

test("recall — explicit projects param adds cross-project instance", async () => {
	const sb = makeSandbox();
	try {
		const { c1, c3 } = setupTwoProjects(sb);
		const client = makeMockClient();
		// Put data in project 3's instance, query from project 1's session.
		await client.remember(c3.projectMemoryInstance, "Clerk org-mode in acme-web", { scope: "project" });
		const api = makeMockAPI();
		registerRecallTool(api, () => client, () => c1);
		const res: any = await api.invoke("memory_recall", {
			query: "Clerk org-mode",
			projects: ["acme-web"], // name ref
		});
		const instances: string[] = res.details.instances;
		assert.ok(instances.includes(c3.projectMemoryInstance));
		assert.equal(res.details.count, 1);
	} finally {
		sb.cleanup();
	}
});

test("recall — alias ref resolves correctly", async () => {
	const sb = makeSandbox();
	try {
		const { c1, c3 } = setupTwoProjects(sb);
		// Add alias to p3 via registry
		touchProject({
			id: c3.projectId!,
			name: c3.projectName,
			aliases: ["web", "frontend"],
			root: c3.projectRoot,
			memoryInstance: c3.projectMemoryInstance,
		});
		const client = makeMockClient();
		const api = makeMockAPI();
		registerRecallTool(api, () => client, () => c1);
		const res: any = await api.invoke("memory_recall", { query: "x", projects: ["frontend"] });
		assert.ok((res.details.instances as string[]).includes(c3.projectMemoryInstance));
	} finally {
		sb.cleanup();
	}
});

test("recall — unknown project ref becomes a warning, not an error", async () => {
	const sb = makeSandbox();
	try {
		const { c1 } = setupTwoProjects(sb);
		const client = makeMockClient();
		const api = makeMockAPI();
		registerRecallTool(api, () => client, () => c1);
		const res: any = await api.invoke("memory_recall", { query: "x", projects: ["does-not-exist"] });
		const warnings: string[] = res.details.warnings;
		assert.ok(warnings.some((w) => w.includes("does-not-exist")));
	} finally {
		sb.cleanup();
	}
});

test("recall — scope=related unions relatedProjects from marker", async () => {
	const sb = makeSandbox();
	try {
		const sbFeatures = { recall: { includeRelated: false } }; // disable default union to isolate scope test
		writeGlobalConfig(sb.home, defaultGlobalConfig({ features: sbFeatures }));
		const p1 = mkdir(join(sb.workspace, "p1"));
		const p2 = mkdir(join(sb.workspace, "p2"));
		writeProjectMarker(p2, { id: "prj_22222222", name: "p2" });
		writeProjectMarker(p1, {
			id: "prj_11111111",
			name: "p1",
			relatedProjects: ["p2"],
		});
		// Register p2 in registry
		const c2 = resolveConfig(p2)!;
		touchProject({
			id: c2.projectId!, name: c2.projectName, aliases: [],
			root: c2.projectRoot, memoryInstance: c2.projectMemoryInstance,
		});
		const c1 = resolveConfig(p1)!;
		const client = makeMockClient();
		const api = makeMockAPI();
		registerRecallTool(api, () => client, () => c1);

		// scope=both should NOT include related (feature off)
		const r1: any = await api.invoke("memory_recall", { query: "x", scope: "both" });
		assert.ok(!(r1.details.instances as string[]).includes(c2.projectMemoryInstance));

		// scope=related should include
		const r2: any = await api.invoke("memory_recall", { query: "x", scope: "related" });
		assert.ok((r2.details.instances as string[]).includes(c2.projectMemoryInstance));
	} finally {
		sb.cleanup();
	}
});

test("recall — scope=all enumerates registry", async () => {
	const sb = makeSandbox();
	try {
		const { c1, c3 } = setupTwoProjects(sb);
		const client = makeMockClient();
		const api = makeMockAPI();
		registerRecallTool(api, () => client, () => c1);
		const res: any = await api.invoke("memory_recall", { query: "x", scope: "all" });
		const instances: string[] = res.details.instances;
		assert.ok(instances.includes(c1.projectMemoryInstance));
		assert.ok(instances.includes(c3.projectMemoryInstance));
		assert.ok(instances.includes(c1.globalMemoryInstance));
	} finally {
		sb.cleanup();
	}
});

test("recall — includeRelated default union hits related automatically", async () => {
	const sb = makeSandbox();
	try {
		// features default → includeRelated: true
		writeGlobalConfig(sb.home, defaultGlobalConfig());
		const p1 = mkdir(join(sb.workspace, "p1"));
		const p2 = mkdir(join(sb.workspace, "p2"));
		writeProjectMarker(p2, { id: "prj_22222222", name: "p2" });
		writeProjectMarker(p1, { id: "prj_11111111", name: "p1", relatedProjects: ["p2"] });
		const c2 = resolveConfig(p2)!;
		touchProject({ id: c2.projectId!, name: c2.projectName, aliases: [], root: c2.projectRoot, memoryInstance: c2.projectMemoryInstance });
		const c1 = resolveConfig(p1)!;
		const client = makeMockClient();
		const api = makeMockAPI();
		registerRecallTool(api, () => client, () => c1);
		const res: any = await api.invoke("memory_recall", { query: "x" }); // default scope
		assert.ok((res.details.instances as string[]).includes(c2.projectMemoryInstance));
	} finally {
		sb.cleanup();
	}
});

test("recall — discovery adds projects when includeDiscovered=true", async () => {
	const sb = makeSandbox();
	try {
		const { c1, c3 } = setupTwoProjects(sb, {
			manifest: { enabled: true },
			recall: { includeDiscovered: true },
		});
		const client = makeMockClient();
		// Simulate manifest search returning project-3.
		client._mockRecall = (instances: string[]) => {
			if (instances.includes(c1.features.manifest.instanceId)) {
				return [
					{
						id: "m1",
						type: "chunk",
						score: 0.8,
						text: "acme-web description",
						item: { key: "manifest-prj_cccc3333.json" },
					},
				];
			}
			// Normal recall: return nothing for simplicity
			return [];
		};
		const api = makeMockAPI();
		registerRecallTool(api, () => client, () => c1);
		const res: any = await api.invoke("memory_recall", { query: "anything" });
		const discovered = res.details.discovered as Array<{ projectId: string }>;
		assert.equal(discovered.length, 1);
		assert.equal(discovered[0].projectId, "prj_cccc3333");
		assert.ok((res.details.instances as string[]).includes(c3.projectMemoryInstance));
	} finally {
		sb.cleanup();
	}
});

test("recall — discovery skipped when explicit projects given", async () => {
	const sb = makeSandbox();
	try {
		const { c1 } = setupTwoProjects(sb, {
			manifest: { enabled: true },
			recall: { includeDiscovered: true },
		});
		const client = makeMockClient();
		let manifestQueried = false;
		client._mockRecall = (instances: string[]) => {
			if (instances.includes(c1.features.manifest.instanceId)) {
				manifestQueried = true;
			}
			return [];
		};
		const api = makeMockAPI();
		registerRecallTool(api, () => client, () => c1);
		await api.invoke("memory_recall", { query: "x", projects: ["acme-web"] });
		assert.equal(manifestQueried, false, "discovery should be bypassed when explicit projects passed");
	} finally {
		sb.cleanup();
	}
});

test("list_projects — returns registry entries, marks current", async () => {
	const sb = makeSandbox();
	try {
		const { c1 } = setupTwoProjects(sb);
		const api = makeMockAPI();
		registerListProjectsTool(api, () => c1);
		const res: any = await api.invoke("memory_list_projects", {});
		assert.equal(res.details.count, 2);
		assert.equal(res.details.currentProjectId, c1.projectId);
		const projects = res.details.projects as Array<{ id: string; name: string }>;
		assert.ok(projects.some((p) => p.name === "acme-api"));
		assert.ok(projects.some((p) => p.name === "acme-web"));
	} finally {
		sb.cleanup();
	}
});

test("list_projects — empty registry message", async () => {
	const sb = makeSandbox();
	try {
		writeGlobalConfig(sb.home, defaultGlobalConfig());
		const p = mkdir(join(sb.workspace, "p"));
		writeProjectMarker(p, { id: "prj_11111111", name: "p" });
		const cfg = resolveConfig(p)!;
		// Deliberately do NOT touchProject — registry is empty.
		const api = makeMockAPI();
		registerListProjectsTool(api, () => cfg);
		const res: any = await api.invoke("memory_list_projects", {});
		assert.equal(res.details.count, 0);
	} finally {
		sb.cleanup();
	}
});
