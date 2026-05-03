/**
 * Synthesizer — pipes raw memory/search results through `pi --print`
 * to produce concise, query-relevant output.
 *
 * Spawns the lightest possible pi invocation:
 *   --print --no-tools --no-session --no-skills --no-extensions
 *   --no-prompt-templates --no-themes
 *
 * Pure LLM text processing — zero tool overhead.
 */

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPiSpawnCommand } from "./pi-spawn.js";

// ── Types ──

export interface SynthesizeOptions {
	/** The user's original query. */
	query: string;
	/** Raw text from Cloudflare AI Search to synthesize. */
	rawText: string;
	/** Model to use (e.g. "anthropic/claude-haiku"). Undefined = pi default. */
	model?: string;
	/** Thinking level. Default: "off" */
	thinking?: string;
	/** Kill the sub-process after this many ms. Default: 30_000 */
	timeoutMs?: number;
	/** Truncate output to this many chars. Default: 4000 */
	maxOutputChars?: number;
	/** Parent abort signal — propagated to the child. */
	signal?: AbortSignal;
}

export interface SynthesizeResult {
	/** Synthesized text (or error message on failure). */
	text: string;
	/** Whether synthesis completed successfully. */
	success: boolean;
	/** Wall-clock duration in ms. */
	durationMs: number;
	// ── Observability fields ──
	/** The system prompt sent to pi --print. */
	systemPrompt: string;
	/** The full task prompt (query + raw data). */
	taskPrompt: string;
	/** Full pi --print argument list. */
	piArgs: string[];
	/** Raw subprocess stdout. */
	rawStdout: string;
	/** Raw subprocess stderr. */
	rawStderr: string;
	/** Process exit code (null if killed). */
	exitCode: number | null;
	/** Whether the process was killed by timeout. */
	timedOut: boolean;
	/** Model used for synthesis (undefined = pi default). */
	model?: string;
	/** Thinking level used. */
	thinking?: string;
}

// ── System prompt ──

export const SYNTHESIS_SYSTEM_PROMPT = `You are a memory retrieval filter. You receive a query and raw memory search results. Return ONLY the information directly relevant to the query.

Rules:
- Extract and return only what answers the query
- Discard irrelevant chunks, boilerplate, README fragments
- Only add examples if necessary, precise and crisp
- Preserve specifics: dates, names, decisions, code patterns, versions
- Be concise — bullet points for multiple items
- If nothing is relevant to the query, say "No relevant information found for this query"
- NEVER FABRICATE — only report what is in the raw data
- Start directly with the answer, no preamble like "Here's what I found"
`;

// ── Implementation ──

/**
 * Spawn `pi --print` to synthesize raw memory results into a concise answer.
 *
 * On any failure (timeout, crash, bad output) the result has `success: false`
 * so callers can fall back to raw output.
 */
export async function synthesize(opts: SynthesizeOptions): Promise<SynthesizeResult> {
	const {
		query,
		rawText,
		model,
		thinking = "off",
		timeoutMs = 30_000,
		maxOutputChars = 4000,
		signal,
	} = opts;

	const start = Date.now();

	// Early abort check
	if (signal?.aborted) {
		return {
			text: "", success: false, durationMs: 0,
			systemPrompt: SYNTHESIS_SYSTEM_PROMPT, taskPrompt: "", piArgs: [],
			rawStdout: "", rawStderr: "", exitCode: null, timedOut: false,
			model, thinking,
		};
	}

	// Write temp files
	let tempDir: string | undefined;
	try {
		tempDir = mkdtempSync(join(tmpdir(), "pi-remembers-synth-"));
		const promptPath = join(tempDir, "prompt.md");
		writeFileSync(promptPath, SYNTHESIS_SYSTEM_PROMPT, { mode: 0o600 });

		// Build the task prompt — query + raw data
		const taskPrompt = `Query: "${query}"\n\nRaw memory results:\n${rawText}`;

		// Build pi args
		const piArgs: string[] = [
			"--print",
			"--no-tools",
			"--no-session",
			"--no-skills",
			"--no-extensions",
			"--no-prompt-templates",
			"--no-themes",
			"--system-prompt",
			promptPath,
		];

		// Model + thinking
		if (model) {
			const modelArg = thinking && thinking !== "off" ? `${model}:${thinking}` : model;
			piArgs.push("--model", modelArg);
		} else if (thinking && thinking !== "off") {
			// No model override but explicit thinking — can't set thinking without model
			// Just skip; the default model's default thinking will be used
		}

		// Task as the final positional argument
		// If too long, write to a file and use @file syntax
		if (taskPrompt.length > 8000) {
			const taskPath = join(tempDir, "task.md");
			writeFileSync(taskPath, taskPrompt, { mode: 0o600 });
			piArgs.push(`@${taskPath}`);
		} else {
			piArgs.push(taskPrompt);
		}

		const result = await spawnPi(piArgs, timeoutMs, signal);

		// Truncate if needed
		let text = result.output;
		if (text.length > maxOutputChars) {
			text = `${text.slice(0, maxOutputChars)}\n…(truncated)`;
		}

		return {
			text,
			success: result.success,
			durationMs: Date.now() - start,
			systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
			taskPrompt,
			piArgs,
			rawStdout: result.rawStdout,
			rawStderr: result.rawStderr,
			exitCode: result.exitCode,
			timedOut: result.timedOut,
			model,
			thinking,
		};
	} catch (err) {
		return {
			text: err instanceof Error ? err.message : String(err),
			success: false,
			durationMs: Date.now() - start,
			systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
			taskPrompt: "",
			piArgs: [],
			rawStdout: "",
			rawStderr: "",
			exitCode: null,
			timedOut: false,
			model,
			thinking,
		};
	} finally {
		// Cleanup temp files
		if (tempDir) {
			try {
				rmSync(tempDir, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	}
}

// ── Child process management ──

interface SpawnResult {
	output: string;
	success: boolean;
	rawStdout: string;
	rawStderr: string;
	exitCode: number | null;
	timedOut: boolean;
}

function spawnPi(
	piArgs: string[],
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<SpawnResult> {
	return new Promise((resolve) => {
		const spawnSpec = getPiSpawnCommand(piArgs);
		const child = spawn(spawnSpec.command, spawnSpec.args, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		});

		let stdout = "";
		let stderr = "";
		let settled = false;
		let timedOut = false;

		// Timeout handler
		const timer = setTimeout(() => {
			if (settled) return;
			timedOut = true;
			try {
				child.kill("SIGTERM");
			} catch {
				/* ignore */
			}
			// Hard kill fallback
			setTimeout(() => {
				try {
					child.kill("SIGKILL");
				} catch {
					/* ignore */
				}
			}, 3000);
		}, timeoutMs);
		timer.unref?.();

		// Parent abort signal
		const onAbort = () => {
			if (settled) return;
			try {
				child.kill("SIGTERM");
			} catch {
				/* ignore */
			}
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});

		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		child.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);

			// Parse output — pi --print in text mode writes assistant text to stdout.
			// It may also emit JSON events; extract the final text.
			const text = extractFinalText(stdout);

			if (timedOut) {
				resolve({ output: text || "(synthesis timed out)", success: false, rawStdout: stdout, rawStderr: stderr, exitCode: exitCode ?? null, timedOut: true });
				return;
			}

			if (exitCode !== 0 && !text) {
				resolve({
					output: stderr.trim() || `(pi exited with code ${exitCode})`,
					success: false,
					rawStdout: stdout, rawStderr: stderr, exitCode: exitCode ?? null, timedOut: false,
				});
				return;
			}

			resolve({ output: text, success: !!text, rawStdout: stdout, rawStderr: stderr, exitCode: exitCode ?? null, timedOut: false });
		});

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ output: err.message, success: false, rawStdout: stdout, rawStderr: stderr, exitCode: null, timedOut: false });
		});
	});
}

/**
 * Extract the final assistant text from pi --print stdout.
 *
 * In text mode, pi --print writes plain text. But it may also emit
 * structured JSONL (message_end events). We handle both.
 */
function extractFinalText(stdout: string): string {
	// First, try to find JSON message_end events (pi may emit these)
	const lines = stdout.split("\n");
	let lastAssistantText = "";

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const event = JSON.parse(line) as {
				type?: string;
				message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
			};
			if (
				(event.type === "message_end" || event.type === "tool_result_end") &&
				event.message?.role === "assistant"
			) {
				for (const part of event.message.content ?? []) {
					if (part.type === "text" && part.text) {
						lastAssistantText = part.text;
					}
				}
			}
		} catch {
			// Not JSON — accumulate as plain text if we haven't found JSON events
		}
	}

	if (lastAssistantText) return lastAssistantText;

	// Fallback: treat entire stdout as plain text, strip any non-text noise
	const plainLines: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			JSON.parse(line);
			// Skip JSON lines
		} catch {
			plainLines.push(line);
		}
	}

	return plainLines.join("\n").trim();
}
