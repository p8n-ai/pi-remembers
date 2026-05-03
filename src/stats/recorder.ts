/**
 * PipelineRecorder — thin wrapper over StatsLogger that keeps logging
 * out of business logic.
 *
 * Usage:
 *   const rec = createRecorder(logger, "recall", { query, scope, ... });
 *   rec.step("input_params", { input: { query } });
 *   rec.step("cloudflare_search", { input: { ... }, output: { ... }, durationMs: 42 });
 *   rec.success();          // or rec.error("boom") / rec.skip()
 *
 * If logger is null the recorder is a silent no-op — no conditionals needed
 * at the call site.
 */

import type { StatsLogger, OperationType, OperationParams } from "./logger.js";

export interface StepData {
	input?: unknown;
	output?: unknown;
	durationMs?: number;
	metadata?: Record<string, unknown>;
	error?: string;
}

export interface PipelineRecorder {
	/** Record a named pipeline step. Steps are auto-numbered in call order. */
	step(name: string, data?: StepData): void;
	/** Mark the operation as successful. */
	success(): void;
	/** Mark the operation as failed. */
	error(msg: string): void;
	/** Mark the operation as skipped. */
	skip(): void;
	/** Elapsed wall-clock ms since recorder creation. */
	elapsed(): number;
}

const NOOP_RECORDER: PipelineRecorder = {
	step() {},
	success() {},
	error() {},
	skip() {},
	elapsed: () => 0,
};

/**
 * Create a pipeline recorder. Returns a no-op recorder when logger is null,
 * so callers never need `if (opId) logger?.logStep(...)` guards.
 */
export function createRecorder(
	logger: StatsLogger | null | undefined,
	type: OperationType,
	params: OperationParams,
): PipelineRecorder {
	if (!logger) return NOOP_RECORDER;

	const opId = logger.startOperation(type, params);
	const t0 = Date.now();
	let stepCounter = 0;

	function elapsed() {
		return Date.now() - t0;
	}

	return {
		step(name: string, data?: StepData) {
			stepCounter++;
			logger.logStep(opId, {
				stepOrder: stepCounter,
				stepName: name,
				inputData: data?.input,
				outputData: data?.output,
				durationMs: data?.durationMs,
				metadata: data?.metadata,
				error: data?.error,
			});
		},

		success() {
			logger.completeOperation(opId, { status: "success", durationMs: elapsed() });
		},

		error(msg: string) {
			logger.completeOperation(opId, { status: "error", error: msg, durationMs: elapsed() });
		},

		skip() {
			logger.completeOperation(opId, { status: "skipped", durationMs: elapsed() });
		},

		elapsed,
	};
}
