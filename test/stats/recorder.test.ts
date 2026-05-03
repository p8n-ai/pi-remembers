/**
 * PipelineRecorder tests — verifies the abstraction over StatsLogger.
 */

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsLogger } from "../../src/stats/logger.ts";
import { createRecorder } from "../../src/stats/recorder.ts";

let tempDir: string;
let dbPath: string;
let logger: StatsLogger;

function setup() {
	tempDir = mkdtempSync(join(tmpdir(), "pi-recorder-test-"));
	dbPath = join(tempDir, "test-stats.db");
	logger = new StatsLogger(dbPath);
}

function teardown() {
	try { logger.close(); } catch { /* */ }
	try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
}

test("recorder auto-numbers steps sequentially", () => {
	setup();
	try {
		const rec = createRecorder(logger, "recall", { query: "test" });
		rec.step("input_params", { input: { query: "test" } });
		rec.step("cloudflare_search", { output: { chunkCount: 3 }, durationMs: 100 });
		rec.step("final_output", { output: { synthesized: false } });
		rec.success();

		// Grab the operation — there should be exactly 1 operation with 3 steps
		const ops = logger.listOperations({});
		assert.equal(ops.length, 1);

		const detail = logger.getOperation(ops[0].id);
		assert.ok(detail);
		assert.equal(detail!.steps.length, 3);
		assert.equal(detail!.steps[0].step_order, 1);
		assert.equal(detail!.steps[0].step_name, "input_params");
		assert.equal(detail!.steps[1].step_order, 2);
		assert.equal(detail!.steps[1].step_name, "cloudflare_search");
		assert.equal(detail!.steps[1].duration_ms, 100);
		assert.equal(detail!.steps[2].step_order, 3);
		assert.equal(detail!.steps[2].step_name, "final_output");
		assert.equal(detail!.status, "success");
	} finally { teardown(); }
});

test("recorder.error() marks operation as error", () => {
	setup();
	try {
		const rec = createRecorder(logger, "remember", { query: "store" });
		rec.step("input_params");
		rec.error("API 500");

		const ops = logger.listOperations({});
		assert.equal(ops[0].status, "error");
		assert.equal(ops[0].error, "API 500");
	} finally { teardown(); }
});

test("recorder.skip() marks operation as skipped", () => {
	setup();
	try {
		const rec = createRecorder(logger, "compaction_ingest", { projectId: "prj123" });
		rec.step("hook_config", { metadata: { skippedReason: "no_messages" } });
		rec.skip();

		const ops = logger.listOperations({});
		assert.equal(ops[0].status, "skipped");
	} finally { teardown(); }
});

test("noop recorder when logger is null — no errors", () => {
	const rec = createRecorder(null, "recall", { query: "noop test" });
	// All calls should be silent no-ops
	rec.step("input_params", { input: { query: "noop test" } });
	rec.step("cloudflare_search", { output: { chunkCount: 0 }, durationMs: 50 });
	rec.success();
	assert.equal(rec.elapsed(), 0, "noop elapsed is always 0");
});

test("noop recorder when logger is undefined — no errors", () => {
	const rec = createRecorder(undefined, "search", { query: "noop" });
	rec.step("a");
	rec.error("boom");
	// Should not throw
});

test("recorder step data round-trips through JSON correctly", () => {
	setup();
	try {
		const rec = createRecorder(logger, "recall", { query: "json test" });
		rec.step("test_step", {
			input: { nested: { array: [1, 2, 3] } },
			output: { result: true },
			metadata: { extra: "info" },
			durationMs: 42,
		});
		rec.success();

		const ops = logger.listOperations({});
		const detail = logger.getOperation(ops[0].id);
		const step = detail!.steps[0];

		assert.deepEqual(JSON.parse(step.input_data!), { nested: { array: [1, 2, 3] } });
		assert.deepEqual(JSON.parse(step.output_data!), { result: true });
		assert.deepEqual(JSON.parse(step.metadata!), { extra: "info" });
		assert.equal(step.duration_ms, 42);
	} finally { teardown(); }
});

test("recorder inherits operation params (projectId, query, scope)", () => {
	setup();
	try {
		const rec = createRecorder(logger, "search", {
			query: "find auth",
			projectId: "prj_abc",
			projectName: "my-project",
			scope: "project",
		});
		rec.success();

		const ops = logger.listOperations({});
		assert.equal(ops[0].type, "search");
		assert.equal(ops[0].query, "find auth");
		assert.equal(ops[0].project_id, "prj_abc");
		assert.equal(ops[0].project_name, "my-project");
		assert.equal(ops[0].scope, "project");
	} finally { teardown(); }
});
