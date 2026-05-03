/**
 * Integration test — full pipeline roundtrip through StatsLogger.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StatsLogger } from "../../src/stats/logger.ts";

test("integration: remember + recall pipeline roundtrip", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-stats-integ-"));
	const dbPath = join(tempDir, "test.db");
	const logger = new StatsLogger(dbPath);

	try {
		// Simulate a remember operation (5 steps)
		const remId = logger.startOperation("remember", {
			query: "TypeScript uses strict null checks",
			scope: "project",
			projectId: "prj_test123",
			projectName: "my-project",
		});

		logger.logStep(remId, { stepOrder: 1, stepName: "input_params", inputData: { content: "TypeScript uses strict null checks", scope: "project" } });
		logger.logStep(remId, { stepOrder: 2, stepName: "resolve_instance", inputData: { scope: "project" }, outputData: { instance: "pi-remembers-proj-prj_test123" } });
		logger.logStep(remId, { stepOrder: 3, stepName: "cloudflare_upload", inputData: { instance: "pi-remembers-proj-prj_test123", contentLength: 34 }, outputData: { id: "doc-1", key: "memory-123.md", status: "processing" }, durationMs: 450 });
		logger.logStep(remId, { stepOrder: 4, stepName: "manifest_schedule", outputData: { scheduled: true }, metadata: { projectId: "prj_test123" } });
		logger.logStep(remId, { stepOrder: 5, stepName: "final_output", outputData: { text: "✓ Remembered" } });
		logger.completeOperation(remId, { status: "success", durationMs: 480 });

		// Simulate a recall operation (10 steps including synthesis)
		const recId = logger.startOperation("recall", {
			query: "what language features do we use?",
			scope: "both",
			projectId: "prj_test123",
			projectName: "my-project",
		});

		logger.logStep(recId, { stepOrder: 1, stepName: "input_params", inputData: { query: "what language features do we use?", scope: "both" } });
		logger.logStep(recId, { stepOrder: 2, stepName: "resolve_instances", inputData: { scope: "both" }, outputData: { instances: ["proj-inst", "global-inst"], scopeTags: ["project", "global"] } });
		logger.logStep(recId, { stepOrder: 3, stepName: "discovery", inputData: { enabled: false }, metadata: { skippedReason: "feature_disabled" } });
		logger.logStep(recId, { stepOrder: 4, stepName: "cloudflare_search", inputData: { instances: ["proj-inst", "global-inst"], query: "what language features" }, outputData: { chunkCount: 3 }, durationMs: 890 });
		logger.logStep(recId, { stepOrder: 5, stepName: "raw_chunks", outputData: { chunks: [{ score: 0.85, textLength: 100 }, { score: 0.72, textLength: 80 }] }, metadata: { count: 2, avgScore: 0.785, minScore: 0.72, maxScore: 0.85 } });
		logger.logStep(recId, { stepOrder: 6, stepName: "synthesis_config", inputData: { enabled: true, model: "anthropic/claude-haiku", thinking: "off", timeoutMs: 30000 } });
		logger.logStep(recId, { stepOrder: 7, stepName: "synthesis_system_prompt", inputData: { systemPrompt: "You are a memory retrieval filter..." }, metadata: { promptLength: 420 } });
		logger.logStep(recId, { stepOrder: 8, stepName: "synthesis_llm_call", inputData: { taskPrompt: 'Query: "what language features"\n\nRaw memory results:\n...', piArgs: ["--print", "--no-tools"] }, outputData: { rawOutput: "TypeScript strict null checks are used", outputLength: 38 }, durationMs: 340, metadata: { success: true, timedOut: false, exitCode: 0 } });
		logger.logStep(recId, { stepOrder: 9, stepName: "synthesis_result", outputData: { text: "TypeScript strict null checks are used", success: true }, durationMs: 340, metadata: { fallbackToRaw: false } });
		logger.logStep(recId, { stepOrder: 10, stepName: "final_output", outputData: { text: "TypeScript strict null checks are used", synthesized: true } });
		logger.completeOperation(recId, { status: "success", durationMs: 1250 });

		// Verify operations
		const summary = logger.getSummary();
		assert.equal(summary.totalOps, 2);
		assert.equal(summary.byType.remember, 1);
		assert.equal(summary.byType.recall, 1);
		assert.equal(summary.byStatus.success, 2);

		// Verify remember operation
		const remOp = logger.getOperation(remId);
		assert.ok(remOp);
		assert.equal(remOp!.type, "remember");
		assert.equal(remOp!.status, "success");
		assert.equal(remOp!.duration_ms, 480);
		assert.equal(remOp!.steps.length, 5);
		assert.equal(remOp!.steps[0].step_name, "input_params");
		assert.equal(remOp!.steps[2].step_name, "cloudflare_upload");
		assert.equal(remOp!.steps[2].duration_ms, 450);

		// Verify recall operation
		const recOp = logger.getOperation(recId);
		assert.ok(recOp);
		assert.equal(recOp!.type, "recall");
		assert.equal(recOp!.status, "success");
		assert.equal(recOp!.duration_ms, 1250);
		assert.equal(recOp!.steps.length, 10);

		// Verify synthesis steps contain expected data
		const synthPromptStep = recOp!.steps.find((s) => s.step_name === "synthesis_system_prompt");
		assert.ok(synthPromptStep);
		const promptInput = JSON.parse(synthPromptStep!.input_data!);
		assert.ok(promptInput.systemPrompt.includes("memory retrieval filter"));

		const synthLlmStep = recOp!.steps.find((s) => s.step_name === "synthesis_llm_call");
		assert.ok(synthLlmStep);
		assert.equal(synthLlmStep!.duration_ms, 340);
		const llmOutput = JSON.parse(synthLlmStep!.output_data!);
		assert.equal(llmOutput.rawOutput, "TypeScript strict null checks are used");
		const llmMeta = JSON.parse(synthLlmStep!.metadata!);
		assert.equal(llmMeta.success, true);
		assert.equal(llmMeta.timedOut, false);

		// Verify final output is synthesized
		const finalStep = recOp!.steps.find((s) => s.step_name === "final_output");
		assert.ok(finalStep);
		const finalOutput = JSON.parse(finalStep!.output_data!);
		assert.equal(finalOutput.synthesized, true);

		// Verify listing
		const allOps = logger.listOperations({});
		assert.equal(allOps.length, 2);

		const recallOps = logger.listOperations({ type: "recall" });
		assert.equal(recallOps.length, 1);
	} finally {
		logger.close();
		try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
	}
});

test("integration: error operation with step-level error", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-stats-integ-err-"));
	const dbPath = join(tempDir, "test.db");
	const logger = new StatsLogger(dbPath);

	try {
		const opId = logger.startOperation("recall", { query: "broken query" });
		logger.logStep(opId, { stepOrder: 1, stepName: "input_params", inputData: { query: "broken query" } });
		logger.logStep(opId, { stepOrder: 2, stepName: "cloudflare_search", durationMs: 100, error: "API returned 500" });
		logger.completeOperation(opId, { status: "error", error: "Recall failed: API returned 500", durationMs: 105 });

		const op = logger.getOperation(opId);
		assert.equal(op!.status, "error");
		assert.equal(op!.error, "Recall failed: API returned 500");
		assert.equal(op!.steps[1].error, "API returned 500");

		// Summary should show error
		const summary = logger.getSummary();
		assert.equal(summary.byStatus.error, 1);
	} finally {
		logger.close();
		try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
	}
});

test("integration: server API endpoints", async () => {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-stats-server-"));
	const dbPath = join(tempDir, "test.db");
	const logger = new StatsLogger(dbPath);

	// Seed some data
	const opId = logger.startOperation("remember", { query: "test fact", scope: "project" });
	logger.logStep(opId, { stepOrder: 1, stepName: "input_params", inputData: { content: "test fact" } });
	logger.completeOperation(opId, { status: "success", durationMs: 50 });

	const { startStatsServer } = await import("../../src/stats/server.ts");
	const srv = await startStatsServer(logger, () => null, () => null);

	try {
		// Test /api/summary
		const summaryRes = await fetch(`${srv.url}/api/summary`);
		assert.equal(summaryRes.status, 200);
		const summary = await summaryRes.json();
		assert.equal(summary.totalOps, 1);

		// Test /api/operations
		const opsRes = await fetch(`${srv.url}/api/operations`);
		const opsData = await opsRes.json();
		assert.equal(opsData.operations.length, 1);
		assert.equal(opsData.total, 1);

		// Test /api/operations/:id
		const detailRes = await fetch(`${srv.url}/api/operations/${opId}`);
		const detail = await detailRes.json();
		assert.equal(detail.id, opId);
		assert.equal(detail.steps.length, 1);

		// Test /api/operations/nonexistent → 404
		const notFoundRes = await fetch(`${srv.url}/api/operations/nonexistent`);
		assert.equal(notFoundRes.status, 404);

		// Test /api/config (no config → error)
		const configRes = await fetch(`${srv.url}/api/config`);
		const configData = await configRes.json();
		assert.ok(configData.error); // "Not configured"

		// Test /api/memories (no client → error)
		const memRes = await fetch(`${srv.url}/api/memories`);
		const memData = await memRes.json();
		assert.ok(memData.error); // "Not configured"

		// Test / (dashboard HTML)
		const htmlRes = await fetch(srv.url);
		assert.equal(htmlRes.status, 200);
		const html = await htmlRes.text();
		assert.ok(html.includes("Pipeline Observatory"));

		// Test 404
		const notFoundPage = await fetch(`${srv.url}/nonexistent`);
		assert.equal(notFoundPage.status, 404);
	} finally {
		await srv.close();
		logger.close();
		try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* */ }
	}
});
