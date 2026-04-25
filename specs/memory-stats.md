# Spec: `/memory-stats` — Full Pipeline Observability Dashboard

## Objective

**Problem:** The remember, recall, and search pipelines in Pi Remembers are opaque. Users cannot see:
- What query the LLM sent to `memory_remember` and how it was stored in Cloudflare
- What query the LLM sent to `memory_recall` / `memory_search`, what Cloudflare returned, how the synthesizer processed it, and what was finally delivered back to the LLM
- The synthesis subprocess: system prompt used, LLM model called, raw LLM output, any errors or fallbacks
- Hook behavior: auto-recall queries, compaction ingestion, manifest refreshes
- Where bottlenecks or failures live in any pipeline step

**Solution:** Add deep instrumentation to **every** pipeline step across all tools and hooks, persist logs to a local SQLite database with 7-day TTL, and expose them via a `/memory-stats` slash command that starts a local web server with a rich interactive dashboard.

**User:** Extension developers and power users who want to evaluate, debug, and tune their memory setup.

**Success looks like:** A user runs `/memory-stats`, a browser opens with a live dashboard showing every operation across the entire extension — every tool call, every hook invocation, every Cloudflare API request, every synthesis subprocess with its system prompt and LLM response, every error and fallback — with full pipeline visibility. They can identify exactly where a recall is returning bad results and shut down the server when done.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  All instrumented code paths:                                       │
│  • Tools: memory_remember, memory_recall, memory_search, memory_list│
│  • Hooks: before_agent_start (auto-recall), compaction (ingest),    │
│           session lifecycle, manifest refresh                       │
│  • Subprocesses: pi --print synthesis (system prompt, LLM call)     │
│  • API calls: every Cloudflare request/response                     │
│                                                                     │
│  ↓ each step instrumented                                           │
│  StatsLogger.log(event)                                             │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  SQLite DB: ~/.pi/pi-remembers-stats.db                             │
│  Tables: operations, pipeline_steps                                 │
│  TTL: 7 days per row (pruned on extension start, not per-call)      │
│  Max payload: 1MB per field                                         │
└───────────────────────────────┬─────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│  /memory-stats command                                              │
│  → Starts HTTP server on random port (127.0.0.1 only)               │
│  → Serves rich single-page HTML dashboard (embedded, no ext deps)   │
│  → REST API: /api/summary, /api/operations, /api/operations/:id     │
│  → Opens browser automatically                                     │
│  → Manual refresh + toggle for 5s live auto-refresh                 │
│  → Shutdown via dashboard button or /memory-stats-stop              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 1. Instrumentation Layer — `StatsLogger`

### New file: `src/stats/logger.ts`

A singleton-style class that writes structured events to SQLite. All writes are **fire-and-forget** — they never throw or block the main tool execution path.

### SQLite Backend: `node:sqlite` (built-in)

**Decision: Use `node:sqlite` (`DatabaseSync`)** over `better-sqlite3`.

| | `node:sqlite` | `better-sqlite3` |
|--|---|---|
| **Zero deps** | ✅ Built into Node 22+ | ❌ Native addon (~2MB, needs compilation) |
| **Stability** | Experimental (warning only, API is stable) | ✅ Mature |
| **Sync API** | ✅ `DatabaseSync` | ✅ Native sync |
| **Install friction** | ✅ None | ❌ node-gyp, prebuild issues |
| **Pi target** | Node 22+ ✅ | Any Node ✅ |

Pi targets Node 22+, and `DatabaseSync` provides all we need (prepared statements, transactions). The experimental warning is cosmetic — we suppress it. Zero install friction wins for a dev tool.

### SQLite Schema

**Location:** `~/.pi/pi-remembers-stats.db`

```sql
CREATE TABLE IF NOT EXISTS operations (
  id            TEXT PRIMARY KEY,                         -- UUID
  type          TEXT NOT NULL,                            -- 'remember' | 'recall' | 'search' | 'list'
                                                         -- | 'auto_recall' | 'compaction_ingest'
                                                         -- | 'manifest_refresh' | 'session_start'
                                                         -- | 'instance_ensure'
  timestamp     TEXT NOT NULL,                            -- ISO 8601
  project_id    TEXT,                                     -- nullable
  project_name  TEXT,
  scope         TEXT,                                     -- 'project' | 'global' | 'both' | etc.
  query         TEXT,                                     -- User/LLM query or content summary
  status        TEXT NOT NULL DEFAULT 'pending',          -- 'pending' | 'success' | 'error' | 'skipped'
  error         TEXT,                                     -- Error message if failed
  duration_ms   INTEGER,                                  -- Total wall-clock time
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pipeline_steps (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id  TEXT NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
  step_order    INTEGER NOT NULL,
  step_name     TEXT NOT NULL,            -- Human-readable step identifier
  input_data    TEXT,                     -- JSON (max 1MB)
  output_data   TEXT,                     -- JSON (max 1MB)
  duration_ms   INTEGER,
  metadata      TEXT,                     -- JSON: scores, counts, flags, etc.
  error         TEXT,                     -- Step-level error (for fallback tracking)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ops_type ON operations(type);
CREATE INDEX IF NOT EXISTS idx_ops_timestamp ON operations(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_ops_created ON operations(created_at);
CREATE INDEX IF NOT EXISTS idx_steps_op ON pipeline_steps(operation_id);
```

### TTL & Pruning

- **TTL:** 7 days per row, based on `created_at`
- **Pruning runs on extension start** (`session_start` hook), not on every tool call
- Pruning query: `DELETE FROM operations WHERE created_at < datetime('now', '-7 days')`
- Cascading delete cleans up `pipeline_steps` via `ON DELETE CASCADE`

### StatsLogger API

```typescript
class StatsLogger {
  constructor(dbPath: string);

  /** Start tracking a new operation. Returns operation ID (UUID). */
  startOperation(type: OperationType, params: {
    query?: string;
    scope?: string;
    projectId?: string | null;
    projectName?: string;
  }): string;

  /** Log a pipeline step within an operation. */
  logStep(operationId: string, step: {
    stepOrder: number;
    stepName: string;
    inputData?: unknown;   // Serialized to JSON, max 1MB
    outputData?: unknown;  // Serialized to JSON, max 1MB
    durationMs?: number;
    metadata?: Record<string, unknown>;
    error?: string;
  }): void;

  /** Mark an operation as complete. */
  completeOperation(operationId: string, result: {
    status: 'success' | 'error' | 'skipped';
    error?: string;
    durationMs: number;
  }): void;

  /** Prune rows older than 7 days. Called on extension start. */
  prune(): { deletedOps: number };

  /** Close the database connection. */
  close(): void;

  // ── Read API (for the dashboard server) ──

  getSummary(): OperationSummary;
  listOperations(opts: { type?: string; status?: string; limit?: number; offset?: number }): OperationRow[];
  getOperation(id: string): OperationDetail | null;
  getOperationCount(opts?: { type?: string; status?: string }): number;
}

type OperationType =
  | 'remember' | 'recall' | 'search' | 'list' | 'list_projects'
  | 'auto_recall' | 'compaction_ingest'
  | 'manifest_refresh' | 'manifest_discover'
  | 'session_start' | 'instance_ensure';
```

### Payload Handling

- All `inputData` / `outputData` values are JSON-serialized before storage
- If serialized payload exceeds **1MB**, truncate with a `"...(truncated, original size: NNN bytes)"` marker
- API tokens / secrets are **never** logged — the logger strips any field named `apiToken`, `token`, `secret`, or `authorization` from logged data

---

## 2. What Gets Logged — Full Pipeline Details

### Remember Pipeline (`memory_remember`)

| Step | step_name | input_data | output_data | metadata |
|------|-----------|------------|-------------|----------|
| 1 | `input_params` | `{ content, scope }` | — | `{ toolCallId }` |
| 2 | `resolve_instance` | `{ scope }` | `{ instance }` | — |
| 3 | `cloudflare_upload` | `{ instance, contentLength, metadata }` | `{ id, key, status }` | `{ durationMs, httpStatus }` |
| 4 | `manifest_schedule` | `{ projectId }` | `{ scheduled, debounceMs }` | — |
| 5 | `final_output` | — | `{ text }` | — |

### Recall Pipeline (`memory_recall`)

| Step | step_name | input_data | output_data | metadata |
|------|-----------|------------|-------------|----------|
| 1 | `input_params` | `{ query, scope, projects }` | — | `{ toolCallId }` |
| 2 | `resolve_instances` | `{ scope, relatedProjects, explicitProjects }` | `{ instances[], scopeTags[] }` | `{ warnings[] }` |
| 3 | `discovery` | `{ query, enabled, topK, threshold }` | `{ discovered[] }` | `{ durationMs, skippedReason? }` |
| 4 | `cloudflare_search` | `{ instances[], query }` | `{ chunkCount }` | `{ durationMs }` |
| 5 | `raw_chunks` | — | `{ chunks[] }` | `{ count, avgScore, minScore, maxScore, scoreDistribution }` |
| 6 | `synthesis_config` | `{ enabled, model, thinking, timeoutMs, maxOutputChars }` | — | — |
| 7 | `synthesis_system_prompt` | `{ systemPrompt }` | — | `{ promptLength }` |
| 8 | `synthesis_llm_call` | `{ taskPrompt, taskPromptLength }` | `{ rawOutput, outputLength }` | `{ durationMs, success, timedOut?, exitCode? }` |
| 9 | `synthesis_result` | — | `{ text, truncated, success }` | `{ durationMs, fallbackToRaw }` |
| 10 | `final_output` | — | `{ text, synthesized }` | `{ totalChunks, warnings[] }` |

If synthesis fails → step 9 logs `error` field and `fallbackToRaw: true`.

### Search Pipeline (`memory_search`)

| Step | step_name | input_data | output_data | metadata |
|------|-----------|------------|-------------|----------|
| 1 | `input_params` | `{ query }` | — | `{ toolCallId }` |
| 2 | `cloudflare_search` | `{ instance, query }` | `{ chunkCount }` | `{ durationMs }` |
| 3 | `raw_chunks` | — | `{ chunks[] }` | `{ count, avgScore, minScore, maxScore }` |
| 4 | `synthesis_config` | `{ enabled, model, thinking, timeoutMs }` | — | — |
| 5 | `synthesis_system_prompt` | `{ systemPrompt }` | — | `{ promptLength }` |
| 6 | `synthesis_llm_call` | `{ taskPrompt, taskPromptLength }` | `{ rawOutput, outputLength }` | `{ durationMs, success, timedOut?, exitCode? }` |
| 7 | `synthesis_result` | — | `{ text, truncated, success }` | `{ durationMs, fallbackToRaw }` |
| 8 | `final_output` | — | `{ text, synthesized }` | — |

### List Pipeline (`memory_list`)

| Step | step_name | input_data | output_data | metadata |
|------|-----------|------------|-------------|----------|
| 1 | `input_params` | `{ scope }` | — | — |
| 2 | `resolve_targets` | `{ scope }` | `{ targets[] }` | — |
| 3 | `cloudflare_list` | `{ instance, label }` | `{ items[], count }` | `{ durationMs }` |
| 4 | `final_output` | — | `{ text, totalCount }` | — |

### Auto-Recall Hook (`before_agent_start`)

| Step | step_name | input_data | output_data | metadata |
|------|-----------|------------|-------------|----------|
| 1 | `hook_config` | `{ autoRecall, enabled }` | — | `{ skippedReason? }` |
| 2 | `extract_query` | `{ userMessageLength }` | `{ queryText }` | `{ truncated? }` |
| 3 | `cache_check` | `{ queryText, cachedQueryText }` | `{ cacheHit }` | `{ cacheAge? }` |
| 4 | `resolve_instances` | — | `{ instances[] }` | — |
| 5 | `cloudflare_search` | `{ instances[], query }` | `{ chunkCount }` | `{ durationMs, timedOut? }` |
| 6 | `build_context` | `{ chunkCount }` | `{ contextLength, chunksUsed }` | — |
| 7 | `final_output` | — | `{ injected, contextLength }` | — |

### Compaction Ingest Hook (`session_before_compact`)

| Step | step_name | input_data | output_data | metadata |
|------|-----------|------------|-------------|----------|
| 1 | `hook_config` | `{ autoIngest, enabled }` | — | `{ skippedReason? }` |
| 2 | `extract_messages` | `{ totalMessages }` | `{ extractedParts, summaryLength }` | — |
| 3 | `cloudflare_upload` | `{ instance, contentLength }` | `{ id, key, status }` | `{ durationMs }` |
| 4 | `manifest_refresh` | `{ enabled, projectId }` | `{ success }` | `{ durationMs, error? }` |

### Manifest Refresh (`refreshManifest`)

| Step | step_name | input_data | output_data | metadata |
|------|-----------|------------|-------------|----------|
| 1 | `build_manifest` | `{ projectId, projectName }` | `{ record }` | `{ memoryCount, sampleSize }` |
| 2 | `ensure_instance` | `{ instanceId }` | `{ success }` | — |
| 3 | `remove_stale` | `{ instanceId, docKey }` | `{ removedCount }` | — |
| 4 | `publish` | `{ instanceId, docKey, bodyLength }` | `{ id, status }` | `{ durationMs }` |
| 5 | `clear_dirty` | `{ projectId }` | — | — |

### Manifest Discovery (`discoverProjects`)

| Step | step_name | input_data | output_data | metadata |
|------|-----------|------------|-------------|----------|
| 1 | `discovery_config` | `{ enabled, topK, threshold, timeoutMs }` | — | — |
| 2 | `cloudflare_search` | `{ instanceId, query }` | `{ chunkCount }` | `{ durationMs }` |
| 3 | `rank_projects` | `{ candidates[] }` | `{ discovered[] }` | `{ filteredOut[] }` |

### Session Start / Instance Ensure

| Step | step_name | input_data | output_data | metadata |
|------|-----------|------------|-------------|----------|
| 1 | `init_config` | `{ cwd }` | `{ projectId, projectName, projectRoot }` | — |
| 2 | `registry_touch` | `{ projectId }` | `{ success }` | — |
| 3 | `ensure_instances` | `{ instances[] }` | `{ results[] }` | `{ durationMs }` |

### Synthesis Subprocess (detailed sub-steps within recall/search)

The synthesis steps (`synthesis_config`, `synthesis_system_prompt`, `synthesis_llm_call`, `synthesis_result`) capture:

- **System prompt**: The full `SYNTHESIS_SYSTEM_PROMPT` text sent to `pi --print`
- **LLM model**: The model string (e.g., `anthropic/claude-haiku`)
- **Thinking mode**: The thinking level
- **Task prompt**: The full `Query: "..." + Raw memory results: ...` input
- **pi --print args**: Full argument list used to spawn the subprocess
- **Raw stdout**: The raw subprocess output before parsing
- **Parsed output**: The extracted final text after `extractFinalText()`
- **Exit code**: Process exit code
- **Timeout/kill**: Whether the process was killed, timed out, or completed
- **Fallback**: Whether we fell through to raw output and why
- **Any stderr**: Captured for error diagnosis

---

## 3. `/memory-stats` and `/memory-stats-stop` Commands

### New file: `src/commands/stats.ts`

#### `/memory-stats`

1. Reads the SQLite DB path from config (`~/.pi/pi-remembers-stats.db`)
2. Starts an HTTP server on a **random available port**, bound to `127.0.0.1`
3. Serves a self-contained HTML dashboard at `/` (no external dependencies)
4. Serves JSON API endpoints for data
5. Opens the browser via `open` (macOS) / `xdg-open` (Linux)
6. Shows notification: `"📊 Memory Stats dashboard at http://localhost:PORT — /memory-stats-stop to close"`
7. Stores server reference so it can be shut down
8. If already running, just re-opens the browser to the existing server

#### `/memory-stats-stop`

1. Shuts down the running dashboard server
2. Notifies user: `"📊 Dashboard server stopped."`

### API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | HTML dashboard (single page, all assets inline) |
| `/api/summary` | GET | Overall stats: total ops by type, by status, avg durations, time range |
| `/api/operations` | GET | Paginated list: `?type=&status=&limit=50&offset=0` |
| `/api/operations/:id` | GET | Single operation with all pipeline steps |
| `/api/memories` | GET | Live memory store listing from Cloudflare (project + global items) |
| `/api/config` | GET | Current resolved config (sanitized — no secrets) |
| `/api/shutdown` | POST | Gracefully shut down the server |

---

## 4. Dashboard UI — Rich & Interactive

### New file: `src/stats/dashboard.html.ts`

Exported function `getDashboardHtml(port: number): string` returns a complete, self-contained HTML page with all CSS and JavaScript inline. **No CDN links, no external dependencies.**

### Layout (Single Page App — Tab-Based)

```
┌─────────────────────────────────────────────────────────────────┐
│  🧠 Pi Remembers — Pipeline Observatory                        │
│  [Status: ● Connected]     [↻ Refresh] [◉ Live: OFF] [⏻ Stop] │
├─────────────────────────────────────────────────────────────────┤
│  [Overview]  [Operations]  [Memory Store]  [Config]             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  (tab content here)                                             │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### Tab 1: Overview

**Summary Cards** (top row, 4–6 cards):
- Total operations (7-day window)
- Breakdown by type (remember / recall / search / hooks)
- Success rate (%) with color coding
- Average duration per type (ms)
- Errors in last 24h
- Last operation timestamp

**Timeline Chart** (simple CSS-based bar chart):
- Operations per hour over the last 24h
- Color-coded by type
- Hover shows counts

**Recent Errors** (bottom section):
- Last 10 error operations with type, timestamp, error message, and link to detail

### Tab 2: Operations (Main Debug View)

**Filters Bar:**
- Type dropdown (All / Remember / Recall / Search / Auto-Recall / Compaction / Manifest / Session)
- Status dropdown (All / Success / Error / Skipped)
- Date range (last 1h / 6h / 24h / 7d / custom)
- Search box (filters on query text)

**Operations Table:**

| Timestamp | Type | Scope | Query | Status | Duration | Steps |
|-----------|------|-------|-------|--------|----------|-------|
| 2026-04-24 14:32 | 🔵 Recall | both | "auth patterns" | ✅ | 1.2s | 10 |

- Type badges: color-coded (🟢 Remember, 🔵 Recall, 🟣 Search, 🟡 Auto-Recall, 🟠 Compaction, ⚪ Manifest)
- Status badges: ✅ Success, ❌ Error, ⏭ Skipped
- Query column: truncated with tooltip for full text
- Pagination: 50 per page with prev/next

**Pipeline Detail Panel** (click a row → expands below or slides in from right):

```
┌─────────────────────────────────────────────────────────────┐
│  Operation: 🔵 Recall — "auth patterns"                     │
│  Time: 2026-04-24 14:32:15 — Duration: 1,243ms — Status: ✅│
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────┐    ┌───────────────┐    ┌──────────────────┐  │
│  │ 1. Input │───▸│ 2. Resolve    │───▸│ 3. Discovery     │  │
│  │  Params  │    │  Instances    │    │   (skipped)      │  │
│  │  0ms     │    │  2ms          │    │   ━━             │  │
│  └──────────┘    └───────────────┘    └──────────────────┘  │
│       │                                      │              │
│       ▼                                      ▼              │
│  ┌──────────────────┐    ┌───────────────────────────────┐  │
│  │ 4. Cloudflare    │───▸│ 5. Raw Chunks                 │  │
│  │  Search          │    │  8 chunks, avg score: 0.72    │  │
│  │  ⚠ 890ms SLOWEST│    │  12ms                         │  │
│  └──────────────────┘    └───────────────────────────────┘  │
│       │                                                     │
│       ▼                                                     │
│  ┌───────────────────┐   ┌──────────────────────────────┐   │
│  │ 6. Synthesis      │──▸│ 7. System Prompt             │   │
│  │  Config           │   │  "You are a memory retrieval  │   │
│  │  model: haiku     │   │   filter..." (420 chars)      │   │
│  └───────────────────┘   └──────────────────────────────┘   │
│       │                                                     │
│       ▼                                                     │
│  ┌───────────────────┐   ┌──────────────────────────────┐   │
│  │ 8. LLM Call       │──▸│ 9. Synthesis Result          │   │
│  │  pi --print       │   │  ✅ 340ms                    │   │
│  │  340ms            │   │  "The auth patterns used..." │   │
│  └───────────────────┘   └──────────────────────────────┘   │
│       │                                                     │
│       ▼                                                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 10. Final Output                                     │   │
│  │  Synthesized: true  |  Total chunks: 8              │   │
│  │  Output: "The auth patterns used in this project..." │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

Each step box is **clickable** to expand and show:
- **Input Data**: Collapsible, syntax-highlighted JSON viewer
- **Output Data**: Same
- **Metadata**: Key-value pairs
- **Error**: Red box with error message if present
- **Duration bar**: Visual proportional bar showing this step's time vs total

**Bottleneck Highlighting:**
- Slowest step gets an orange `⚠ SLOWEST` badge
- Steps taking >50% of total duration get a warning indicator
- Error steps get a red border and ❌ icon

**Synthesis Detail Sub-View** (within the pipeline, for steps 6–9):
- Full system prompt (collapsible, monospace)
- Full task prompt sent to `pi --print` (collapsible, monospace)
- Raw subprocess stdout (collapsible)
- Parsed LLM output
- Exit code, timeout status, kill status
- If fallback occurred: shows "⚠ Synthesis failed, fell back to raw output" with error

### Tab 3: Memory Store

- Two sections: **Project Memories** and **Global Memories**
- Each shows a table: Key | Status | Timestamp
- Item count per instance
- Fetched live from Cloudflare API via `/api/memories`
- Loading spinner while fetching
- Error display if API call fails

### Tab 4: Config

- Shows current `ResolvedConfig` (sanitized: `apiToken` → `"***"`)
- Feature flags with enabled/disabled badges
- Hook settings
- Instance names
- Project identity (id, name, aliases, root, related)

### Refresh Behavior

- **Manual refresh**: "↻ Refresh" button re-fetches current tab data
- **Live toggle**: "◉ Live" button toggles 5-second auto-refresh polling
  - When ON: green indicator, polls `/api/operations` and `/api/summary` every 5s
  - When OFF: no polling (default state)
  - Persisted in `localStorage` across page reloads

### Styling

- **Dark theme** (matches terminal aesthetic)
  - Background: `#0d1117` (GitHub dark)
  - Cards: `#161b22`
  - Text: `#e6edf3`
  - Accent: `#58a6ff` (blue links/highlights)
  - Success: `#3fb950`, Error: `#f85149`, Warning: `#d29922`
- CSS variables for all colors (easy to adjust)
- **Monospace** (`ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace`) for JSON/data
- **Sans-serif** (`-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui`) for UI chrome
- Responsive — works down to 768px width
- Smooth transitions on expand/collapse (150ms ease)
- No scrolljank — virtual scrolling not needed (50 items per page max)

---

## 5. Integration Points

### `src/index.ts` changes

```typescript
import { StatsLogger } from "./stats/logger.js";

// In piRemembersExtension():
let logger: StatsLogger | null = null;

function initClients(cwd: string) {
  // ... existing config resolution ...
  
  // Initialize stats logger (once)
  if (!logger && config?.features.stats.enabled) {
    logger = new StatsLogger(statsDbPath());
  }
}

// Pass logger to all registrations:
registerRecallTool(pi, getClient, getConfig, logger);
registerRememberTool(pi, getClient, getConfig, debouncer, logger);
registerSearchTool(pi, getClient, getConfig, logger);
registerListTool(pi, getClient, getConfig, logger);
registerListProjectsTool(pi, getConfig, logger);
registerCompactionHook(pi, getClient, getConfig, logger);
registerAgentStartHook(pi, getClient, getConfig, logger);
registerStatsCommand(pi, getConfig, logger);
registerStatsStopCommand(pi);

// session_start: prune old stats
pi.on("session_start", async (_event, ctx) => {
  initClients(ctx.cwd);
  if (logger) logger.prune(); // 7-day TTL cleanup
  // ... rest of existing code ...
});

// session_shutdown: close logger
pi.on("session_shutdown", async () => {
  logger?.close();
  // ... existing shutdown code ...
});
```

### Tool files (`remember.ts`, `recall.ts`, `search.ts`, `list.ts`)

Each tool's `registerXxxTool` function accepts an optional `StatsLogger | null` parameter. The `execute()` method wraps its body:

```typescript
// Pattern for all tools:
export function registerRecallTool(
  pi: ExtensionAPI,
  getClient: () => CloudflareApiClient | null,
  getConfig: () => ResolvedConfig | null,
  logger?: StatsLogger | null,    // ← new
) {
  // ...
  async execute(_toolCallId, params, signal) {
    const opId = logger?.startOperation('recall', { ... });
    const t0 = Date.now();
    try {
      // Step 1: input_params
      logger?.logStep(opId, { stepOrder: 1, stepName: 'input_params', inputData: { ... } });
      
      // ... each existing code block gets a logStep() call ...
      
      logger?.completeOperation(opId, { status: 'success', durationMs: Date.now() - t0 });
      return result;
    } catch (err) {
      logger?.completeOperation(opId, {
        status: 'error',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - t0,
      });
      throw err;
    }
  }
}
```

### Hook files (`agent-start.ts`, `compaction.ts`)

Same pattern — accept optional logger, wrap hook body with operation tracking.

### Synthesizer (`subagent/synthesizer.ts`)

The `synthesize()` function itself doesn't call the logger directly. Instead, the **caller** (recall.ts, search.ts) logs the synthesis sub-steps by passing data into/out of `synthesize()`. This keeps synthesizer.ts clean and the caller in control of step ordering.

However, we add additional return fields to `SynthesizeResult`:

```typescript
export interface SynthesizeResult {
  text: string;
  success: boolean;
  durationMs: number;
  // New fields for observability:
  systemPrompt: string;           // The SYNTHESIS_SYSTEM_PROMPT used
  taskPrompt: string;             // The "Query: ... Raw memory results: ..." sent
  piArgs: string[];               // Full pi --print args
  rawStdout: string;              // Raw subprocess stdout
  rawStderr: string;              // Raw subprocess stderr
  exitCode: number | null;        // Process exit code
  timedOut: boolean;              // Whether timeout was hit
  model?: string;                 // Model used
  thinking?: string;              // Thinking level
}
```

### Config changes (`config.ts`)

Add to `FeatureFlags`:

```typescript
stats?: {
  /** Enable pipeline instrumentation. Default: true */
  enabled?: boolean;
};
```

Add to `ResolvedFeatures`:

```typescript
stats: {
  enabled: boolean;
};
```

Default: `enabled: true`.

Add helper:

```typescript
export function statsDbPath(): string {
  return join(globalConfigDir(), "pi-remembers-stats.db");
}
```

---

## 6. Project Structure (new/changed files)

```
src/
  stats/
    logger.ts              → StatsLogger class (SQLite read/write, prune)
    server.ts              → HTTP server, API routes, browser open
    dashboard.html.ts      → getDashboardHtml() — full HTML/CSS/JS string
  commands/
    stats.ts               → /memory-stats and /memory-stats-stop registration
  config.ts                → + stats feature flag, statsDbPath()
  tools/
    remember.ts            → + logger instrumentation
    recall.ts              → + logger instrumentation
    search.ts              → + logger instrumentation
    list.ts                → + logger instrumentation
    list-projects.ts       → + logger instrumentation
  hooks/
    agent-start.ts         → + logger instrumentation
    compaction.ts          → + logger instrumentation
  subagent/
    synthesizer.ts         → + return extended SynthesizeResult
  index.ts                 → + logger init, prune, pass to tools/hooks/commands
```

---

## Commands

```
Build:    npm run build
Test:     npm test
Lint:     (follow existing project setup)
```

---

## Code Style

Follow existing codebase conventions:
- Functional registration pattern (`registerXxxCommand`)
- `getClient()` / `getConfig()` lazy accessor closures
- JSDoc on all exported functions
- Error handling: best-effort, never crash the host session — especially in logger calls
- TypeBox for tool parameter schemas
- Imports: `type` imports for type-only references

Logger calls are always **guarded**:
```typescript
logger?.logStep(opId!, { ... });  // null-safe, fire-and-forget
```

---

## Testing Strategy

- **Framework:** Whatever the project currently uses (vitest based on existing test files)
- **Test location:** `test/stats/`

| Test file | What it covers |
|-----------|---------------|
| `test/stats/logger.test.ts` | StatsLogger: create, write ops/steps, read back, prune by TTL, payload truncation, secret stripping |
| `test/stats/server.test.ts` | API route handlers: /api/summary, /api/operations, /api/operations/:id responses with mock DB |
| `test/stats/integration.test.ts` | Full cycle: instrument a mock remember → recall, verify DB entries match expected pipeline |

No browser E2E tests for the dashboard — it's an internal dev tool. Manual visual verification is sufficient.

---

## Boundaries

### Always
- Guard every logger call with `?.` — never let instrumentation throw
- Strip secrets from logged data (apiToken, authorization headers)
- Bind HTTP server to `127.0.0.1` only
- Truncate payloads at 1MB per field
- Prune on extension start only (not per-call)
- Use transactions for atomic operation + steps writes
- Close the DB connection on session shutdown

### Ask First
- Adding WebSocket real-time push to the dashboard (currently polling)
- Adding export/download of stats data
- Adding comparison view between operations
- Changing SQLite schema after initial release

### Never
- Store API tokens or secrets in the stats DB
- Make the dashboard server accessible from non-localhost
- Block or slow down tool execution due to stats logging failure
- Add external CDN/npm dependencies to the dashboard HTML
- Log raw user conversation content (only log queries and memory content that already goes to Cloudflare)

---

## Success Criteria

1. **Full remember pipeline visibility**: Dashboard shows input params → instance resolution → Cloudflare upload (with request/response) → manifest scheduling → final output, with timing per step
2. **Full recall pipeline visibility**: Dashboard shows input → instance resolution → discovery → Cloudflare search (with all chunks and scores) → synthesis config → system prompt → LLM call (with full task prompt, raw stdout, parsed output) → final output
3. **Full search pipeline visibility**: Same depth as recall
4. **Hook visibility**: Auto-recall and compaction hooks are logged with the same step detail as tools
5. **Manifest operations visible**: Manifest refresh, discovery, and publish operations tracked
6. **Session lifecycle visible**: Extension startup, instance creation logged
7. **Synthesis subprocess fully exposed**: System prompt text, LLM model, task prompt, raw subprocess output, exit code, timeout status, fallback behavior — all visible in the dashboard
8. **Error and fallback tracking**: Every error is captured at the step level; fallback paths (synthesis fail → raw output) are explicitly shown
9. **Bottleneck identification**: Slowest step in each operation visually highlighted
10. **Server lifecycle works**: `/memory-stats` starts server + opens browser, `/memory-stats-stop` or dashboard button stops it, no zombie processes
11. **Zero interference**: Stats logging never slows down or breaks main tool execution
12. **7-day TTL**: Old data auto-pruned on extension start
13. **Live refresh toggle**: Dashboard supports manual refresh + toggleable 5s auto-refresh

---

## Open Questions

_None — all resolved._
