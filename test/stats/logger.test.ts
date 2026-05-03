/**
 * StatsLogger tests — write API, read API, prune, payload handling.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsLogger } from "../../src/stats/logger.ts";

let tempDir: string;
let dbPath: string;
let logger: StatsLogger;

function setup() {
	tempDir = mkdtempSync(join(tmpdir(), "pi-stats-test-"));
	dbPath = join(tempDir, "test-stats.db");
	logger = new StatsLogger(dbPath);
}

function teardown() {
	try { logger.close(); } catch { /* */ }
	try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
}

// ── Write API ──

test("startOperation creates an operation row and returns a UUID", () => {
	setup();
	try {
		const id = logger.startOperation("remember", {
			query: "test query",
			scope: "project",
			projectId: "prj_abc123",
			projectName: "my-project",
		});

		assert.ok(id, "should return an id");
		assert.match(id, /^[0-9a-f-]{36}$/, "should be a UUID");

		const op = logger.getOperation(id);
		assert.ok(op, "operation should exist in DB");
		assert.equal(op!.type, "remember");
		assert.equal(op!.query, "test query");
		assert.equal(op!.scope, "project");
		assert.equal(op!.project_id, "prj_abc123");
		assert.equal(op!.project_name, "my-project");
		assert.equal(op!.status, "pending");
	} finally { teardown(); }
});

test("logStep inserts a pipeline step linked to the operation", () => {
	setup();
	try {
		const opId = logger.startOperation("recall", { query: "find auth" });

		logger.logStep(opId, {
			stepOrder: 1,
			stepName: "input_params",
			inputData: { query: "find auth", scope: "both" },
			durationMs: 0,
		});

		logger.logStep(opId, {
			stepOrder: 2,
			stepName: "cloudflare_search",
			inputData: { instances: ["inst-1"], query: "find auth" },
			outputData: { chunkCount: 5 },
			durationMs: 120,
			metadata: { avgScore: 0.75 },
		});

		const op = logger.getOperation(opId);
		assert.ok(op, "operation should exist");
		assert.equal(op!.steps.length, 2, "should have 2 steps");
		assert.equal(op!.steps[0].step_name, "input_params");
		assert.equal(op!.steps[0].step_order, 1);
		assert.equal(op!.steps[1].step_name, "cloudflare_search");
		assert.equal(op!.steps[1].duration_ms, 120);

		// Verify JSON round-trip
		const step2Meta = JSON.parse(op!.steps[1].metadata!);
		assert.equal(step2Meta.avgScore, 0.75);
	} finally { teardown(); }
});

test("completeOperation updates status, error, and duration", () => {
	setup();
	try {
		const opId = logger.startOperation("search", { query: "find files" });

		logger.completeOperation(opId, {
			status: "success",
			durationMs: 500,
		});

		const op = logger.getOperation(opId);
		assert.equal(op!.status, "success");
		assert.equal(op!.duration_ms, 500);
		assert.equal(op!.error, null);
	} finally { teardown(); }
});

test("completeOperation records errors", () => {
	setup();
	try {
		const opId = logger.startOperation("remember", { query: "store thing" });

		logger.completeOperation(opId, {
			status: "error",
			error: "Cloudflare API returned 500",
			durationMs: 200,
		});

		const op = logger.getOperation(opId);
		assert.equal(op!.status, "error");
		assert.equal(op!.error, "Cloudflare API returned 500");
	} finally { teardown(); }
});

// ── Payload handling ──

test("payloads exceeding 1MB are truncated", () => {
	setup();
	try {
		const opId = logger.startOperation("recall", { query: "big data" });
		const bigPayload = { data: "x".repeat(1_100_000) };

		logger.logStep(opId, {
			stepOrder: 1,
			stepName: "big_step",
			inputData: bigPayload,
		});

		const op = logger.getOperation(opId);
		const inputStr = op!.steps[0].input_data!;
		assert.ok(inputStr.length <= 1_050_000, "should be truncated near 1MB");
		assert.ok(inputStr.includes("...(truncated"), "should have truncation marker");
	} finally { teardown(); }
});

test("secret fields are stripped from logged data", () => {
	setup();
	try {
		const opId = logger.startOperation("recall", { query: "secrets test" });

		logger.logStep(opId, {
			stepOrder: 1,
			stepName: "config_step",
			inputData: {
				apiToken: "super-secret-token",
				token: "another-secret",
				secret: "hidden",
				authorization: "Bearer xyz",
				safeField: "visible",
				nested: {
					apiToken: "nested-secret",
					data: "safe-nested",
				},
			},
		});

		const op = logger.getOperation(opId);
		const input = JSON.parse(op!.steps[0].input_data!);
		assert.equal(input.apiToken, "[REDACTED]");
		assert.equal(input.token, "[REDACTED]");
		assert.equal(input.secret, "[REDACTED]");
		assert.equal(input.authorization, "[REDACTED]");
		assert.equal(input.safeField, "visible");
		assert.equal(input.nested.apiToken, "[REDACTED]");
		assert.equal(input.nested.data, "safe-nested");
	} finally { teardown(); }
});

// ── Write methods never throw ──

test("logStep with invalid operation id does not throw", () => {
	setup();
	try {
		assert.doesNotThrow(() => {
			logger.logStep("nonexistent-id", {
				stepOrder: 1,
				stepName: "test",
				inputData: { a: 1 },
			});
		});
	} finally { teardown(); }
});

test("completeOperation with invalid id does not throw", () => {
	setup();
	try {
		assert.doesNotThrow(() => {
			logger.completeOperation("nonexistent", { status: "error", durationMs: 0 });
		});
	} finally { teardown(); }
});

// ── Read API ──

test("getSummary returns correct aggregate stats", () => {
	setup();
	try {
		// Create a few operations
		const op1 = logger.startOperation("remember", { query: "fact 1" });
		logger.completeOperation(op1, { status: "success", durationMs: 100 });

		const op2 = logger.startOperation("recall", { query: "query 1" });
		logger.completeOperation(op2, { status: "success", durationMs: 200 });

		const op3 = logger.startOperation("recall", { query: "query 2" });
		logger.completeOperation(op3, { status: "error", error: "failed", durationMs: 50 });

		const summary = logger.getSummary();
		assert.equal(summary.totalOps, 3);
		assert.equal(summary.byType.remember, 1);
		assert.equal(summary.byType.recall, 2);
		assert.equal(summary.byStatus.success, 2);
		assert.equal(summary.byStatus.error, 1);
		assert.ok(summary.avgDurationByType.remember === 100);
		assert.ok(summary.avgDurationByType.recall === 125); // (200+50)/2
	} finally { teardown(); }
});

test("listOperations supports filtering and pagination", () => {
	setup();
	try {
		for (let i = 0; i < 10; i++) {
			const type = i % 2 === 0 ? "remember" : "recall";
			const id = logger.startOperation(type as any, { query: `q${i}` });
			logger.completeOperation(id, { status: "success", durationMs: i * 10 });
		}

		// No filter
		const all = logger.listOperations({});
		assert.equal(all.length, 10);

		// Filter by type
		const recalls = logger.listOperations({ type: "recall" });
		assert.equal(recalls.length, 5);

		// Pagination
		const page1 = logger.listOperations({ limit: 3, offset: 0 });
		assert.equal(page1.length, 3);

		const page2 = logger.listOperations({ limit: 3, offset: 3 });
		assert.equal(page2.length, 3);

		// Count
		const count = logger.getOperationCount({ type: "remember" });
		assert.equal(count, 5);
	} finally { teardown(); }
});

test("getOperation returns null for nonexistent id", () => {
	setup();
	try {
		const op = logger.getOperation("nonexistent");
		assert.equal(op, null);
	} finally { teardown(); }
});

// ── Prune ──

test("prune removes rows older than 7 days", () => {
	setup();
	try {
		// Insert an operation manually with old timestamp
		const db = (logger as any).db;
		const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
		db.prepare(
			"INSERT INTO operations (id, type, timestamp, query, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
		).run("old-op", "remember", oldDate, "old query", "success", oldDate);

		// Insert a recent operation normally
		const recentId = logger.startOperation("recall", { query: "recent" });
		logger.completeOperation(recentId, { status: "success", durationMs: 10 });

		const result = logger.prune();
		assert.ok(result.deletedOps >= 1, "should delete at least the old operation");

		// Old should be gone
		assert.equal(logger.getOperation("old-op"), null);
		// Recent should remain
		assert.ok(logger.getOperation(recentId));
	} finally { teardown(); }
});

// ── Step-level errors ──

test("logStep can record step-level errors", () => {
	setup();
	try {
		const opId = logger.startOperation("recall", { query: "err test" });
		logger.logStep(opId, {
			stepOrder: 1,
			stepName: "synthesis_llm_call",
			durationMs: 5000,
			error: "Process timed out after 5000ms",
		});

		const op = logger.getOperation(opId);
		assert.equal(op!.steps[0].error, "Process timed out after 5000ms");
	} finally { teardown(); }
});
