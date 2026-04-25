/**
 * StatsLogger — Pipeline observability backed by SQLite.
 *
 * Uses `node:sqlite` (built-in DatabaseSync) for zero-dependency persistence.
 * All write operations are fire-and-forget: errors are caught and swallowed
 * so stats never interfere with tool execution.
 *
 * Location: ~/.pi/pi-remembers-stats.db
 * TTL: 7 days per row, pruned on extension start.
 */

import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

// ── Types ──

export type OperationType =
	| "remember"
	| "recall"
	| "search"
	| "list"
	| "list_projects"
	| "auto_recall"
	| "compaction_ingest"
	| "manifest_refresh"
	| "manifest_discover"
	| "session_start"
	| "instance_ensure";

export interface OperationParams {
	query?: string;
	scope?: string;
	projectId?: string | null;
	projectName?: string;
}

export interface StepParams {
	stepOrder: number;
	stepName: string;
	inputData?: unknown;
	outputData?: unknown;
	durationMs?: number;
	metadata?: Record<string, unknown>;
	error?: string;
}

export interface CompletionParams {
	status: "success" | "error" | "skipped";
	error?: string;
	durationMs: number;
}

export interface OperationRow {
	id: string;
	type: string;
	timestamp: string;
	project_id: string | null;
	project_name: string | null;
	scope: string | null;
	query: string | null;
	status: string;
	error: string | null;
	duration_ms: number | null;
	created_at: string;
}

export interface StepRow {
	id: number;
	operation_id: string;
	step_order: number;
	step_name: string;
	input_data: string | null;
	output_data: string | null;
	duration_ms: number | null;
	metadata: string | null;
	error: string | null;
	created_at: string;
}

export interface OperationDetail extends OperationRow {
	steps: StepRow[];
}

export interface OperationSummary {
	totalOps: number;
	byType: Record<string, number>;
	byStatus: Record<string, number>;
	avgDurationByType: Record<string, number>;
	errorsLast24h: number;
	timeRange: { earliest: string | null; latest: string | null };
}

// ── Secret field names to redact ──

const SECRET_FIELDS = new Set(["apitoken", "token", "secret", "authorization", "apisecret"]);
const MAX_PAYLOAD_BYTES = 1_000_000; // 1MB

// ── Schema ──

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS operations (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  timestamp     TEXT NOT NULL,
  project_id    TEXT,
  project_name  TEXT,
  scope         TEXT,
  query         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  error         TEXT,
  duration_ms   INTEGER,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pipeline_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id  TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  step_order    INTEGER NOT NULL,
  step_name     TEXT NOT NULL,
  input_data    TEXT,
  output_data   TEXT,
  duration_ms   INTEGER,
  metadata      TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ops_type ON operations(type);
CREATE INDEX IF NOT EXISTS idx_ops_timestamp ON operations(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ops_created ON operations(created_at);
CREATE INDEX IF NOT EXISTS idx_steps_op ON pipeline_steps(operation_id);
`;

// ── Helpers ──

/** Deep-redact secret fields from an object before serialization. */
function redactSecrets(obj: unknown): unknown {
	if (obj === null || obj === undefined) return obj;
	if (typeof obj !== "object") return obj;
	if (Array.isArray(obj)) return obj.map(redactSecrets);

	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
		if (SECRET_FIELDS.has(key.toLowerCase())) {
			result[key] = "[REDACTED]";
		} else if (typeof value === "object" && value !== null) {
			result[key] = redactSecrets(value);
		} else {
			result[key] = value;
		}
	}
	return result;
}

/** Serialize a value to JSON, redacting secrets and truncating at 1MB. */
function safeSerialize(value: unknown): string | null {
	if (value === undefined || value === null) return null;
	try {
		const redacted = redactSecrets(value);
		const json = JSON.stringify(redacted);
		if (json.length > MAX_PAYLOAD_BYTES) {
			return json.slice(0, MAX_PAYLOAD_BYTES) + `...(truncated, original size: ${json.length} bytes)`;
		}
		return json;
	} catch {
		return JSON.stringify({ _serializationError: true, type: typeof value });
	}
}

// ── StatsLogger ──

export class StatsLogger {
	/** @internal — exposed for testing only. */
	readonly db: DatabaseSync;

	constructor(dbPath: string) {
		// Ensure parent directory exists
		mkdirSync(dirname(dbPath), { recursive: true });

		this.db = new DatabaseSync(dbPath);
		// Enable WAL mode for better concurrent access
		this.db.exec("PRAGMA journal_mode=WAL");
		// Enable foreign keys for CASCADE deletes
		this.db.exec("PRAGMA foreign_keys=ON");
		// Create schema
		this.db.exec(SCHEMA_SQL);
	}

	// ── Write API ──

	/** Start tracking a new operation. Returns operation ID (UUID). */
	startOperation(type: OperationType, params: OperationParams): string {
		const id = randomUUID();
		try {
			this.db
				.prepare(
					`INSERT INTO operations (id, type, timestamp, project_id, project_name, scope, query, status)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'pending')`,
				)
				.run(
					id,
					type,
					new Date().toISOString(),
					params.projectId ?? null,
					params.projectName ?? null,
					params.scope ?? null,
					params.query ?? null,
				);
		} catch {
			// Fire-and-forget: never throw
		}
		return id;
	}

	/** Log a pipeline step within an operation. */
	logStep(operationId: string, step: StepParams): void {
		try {
			this.db
				.prepare(
					`INSERT INTO pipeline_steps (operation_id, step_order, step_name, input_data, output_data, duration_ms, metadata, error)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					operationId,
					step.stepOrder,
					step.stepName,
					safeSerialize(step.inputData),
					safeSerialize(step.outputData),
					step.durationMs ?? null,
					safeSerialize(step.metadata),
					step.error ?? null,
				);
		} catch {
			// Fire-and-forget
		}
	}

	/** Mark an operation as complete. */
	completeOperation(operationId: string, result: CompletionParams): void {
		try {
			this.db
				.prepare("UPDATE operations SET status = ?, error = ?, duration_ms = ? WHERE id = ?")
				.run(result.status, result.error ?? null, result.durationMs, operationId);
		} catch {
			// Fire-and-forget
		}
	}


	// ── Helpers ──

	/** Build a WHERE clause for optional project filtering. */
	private projectFilter(projectId?: string | null): { where: string; params: (string | number)[] } {
		if (projectId === undefined || projectId === null) return { where: "", params: [] };
		if (projectId === "__global__") return { where: "WHERE project_id IS NULL", params: [] };
		return { where: "WHERE project_id = ?", params: [projectId] };
	}

	/** Add project condition to an existing conditions array. */
	private addProjectCondition(conditions: string[], params: (string | number)[], projectId?: string | null): void {
		if (projectId === undefined || projectId === null) return;
		if (projectId === "__global__") {
			conditions.push("project_id IS NULL");
		} else {
			conditions.push("project_id = ?");
			params.push(projectId);
		}
	}

	// ── Read API ──

	/** Get aggregate statistics, optionally filtered by project. */
	getSummary(projectId?: string | null): OperationSummary {
		const pFilter = this.projectFilter(projectId);
		const totalRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM operations ${pFilter.where}`).get(...pFilter.params) as unknown as { cnt: number };
		const totalOps = totalRow.cnt;

		const typeRows = this.db
			.prepare(`SELECT type, COUNT(*) as cnt FROM operations ${pFilter.where} GROUP BY type`)
			.all(...pFilter.params) as unknown as Array<{ type: string; cnt: number }>;
		const byType: Record<string, number> = {};
		for (const r of typeRows) byType[r.type] = r.cnt;

		const statusRows = this.db
			.prepare(`SELECT status, COUNT(*) as cnt FROM operations ${pFilter.where} GROUP BY status`)
			.all(...pFilter.params) as unknown as Array<{ status: string; cnt: number }>;
		const byStatus: Record<string, number> = {};
		for (const r of statusRows) byStatus[r.status] = r.cnt;

		const avgRows = this.db
			.prepare(
				`SELECT type, AVG(duration_ms) as avg_ms FROM operations ${pFilter.where ? pFilter.where + ' AND' : 'WHERE'} duration_ms IS NOT NULL GROUP BY type`,
			)
			.all(...pFilter.params) as unknown as Array<{ type: string; avg_ms: number }>;
		const avgDurationByType: Record<string, number> = {};
		for (const r of avgRows) avgDurationByType[r.type] = Math.round(r.avg_ms);

		const errRow = this.db
			.prepare(
				`SELECT COUNT(*) as cnt FROM operations ${pFilter.where ? pFilter.where + ' AND' : 'WHERE'} status = 'error' AND created_at > datetime('now', '-1 day')`,
			)
			.get(...pFilter.params) as unknown as { cnt: number };

		const rangeRow = this.db
			.prepare(`SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest FROM operations ${pFilter.where}`)
			.get(...pFilter.params) as unknown as { earliest: string | null; latest: string | null };

		return {
			totalOps,
			byType,
			byStatus,
			avgDurationByType,
			errorsLast24h: errRow.cnt,
			timeRange: { earliest: rangeRow.earliest, latest: rangeRow.latest },
		};
	}

	/** List operations with optional filtering and pagination. */
	listOperations(opts: {
		type?: string;
		status?: string;
		projectId?: string | null;
		limit?: number;
		offset?: number;
	}): OperationRow[] {
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		this.addProjectCondition(conditions, params, opts.projectId);
		if (opts.type) {
			conditions.push("type = ?");
			params.push(opts.type);
		}
		if (opts.status) {
			conditions.push("status = ?");
			params.push(opts.status);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const limit = opts.limit ?? 50;
		const offset = opts.offset ?? 0;

		return this.db
			.prepare(`SELECT * FROM operations ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`)
			.all(...params, limit, offset) as unknown as OperationRow[];
	}

	/** Get a single operation with all pipeline steps. */
	getOperation(id: string): OperationDetail | null {
		const op = this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id) as unknown as OperationRow | undefined;
		if (!op) return null;

		const steps = this.db
			.prepare("SELECT * FROM pipeline_steps WHERE operation_id = ? ORDER BY step_order ASC")
			.all(id) as unknown as StepRow[];

		return { ...op, steps };
	}

	/** Get count of operations matching filters. */
	getOperationCount(opts?: { type?: string; status?: string; projectId?: string | null }): number {
		const conditions: string[] = [];
		const params: (string | number)[] = [];

		this.addProjectCondition(conditions, params, opts?.projectId);
		if (opts?.type) {
			conditions.push("type = ?");
			params.push(opts.type);
		}
		if (opts?.status) {
			conditions.push("status = ?");
			params.push(opts.status);
		}

		const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
		const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM operations ${where}`).get(...params) as unknown as {
			cnt: number;
		};
		return row.cnt;
	}

	/** Get distinct projects that have operations logged. */
	getDistinctProjects(): Array<{ project_id: string; project_name: string; op_count: number }> {
		return this.db
			.prepare(
				"SELECT project_id, project_name, COUNT(*) as op_count FROM operations WHERE project_id IS NOT NULL GROUP BY project_id ORDER BY MAX(timestamp) DESC",
			)
			.all() as unknown as Array<{ project_id: string; project_name: string; op_count: number }>;
	}

	// ── Maintenance ──

	/** Prune rows older than 7 days. Returns count of deleted operations. */
	prune(): { deletedOps: number } {
		const result = this.db.prepare("DELETE FROM operations WHERE created_at < datetime('now', '-7 days')").run();
		return { deletedOps: Number(result.changes) };
	}

	/** Close the database connection. */
	close(): void {
		try {
			this.db.close();
		} catch {
			// best-effort
		}
	}
}
