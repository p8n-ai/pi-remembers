# Implementation Plan: `/memory-stats` — Full Pipeline Observability

## Overview

Add deep instrumentation across all Pi Remembers tools, hooks, and subprocesses, persist logs to a local SQLite DB (`~/.pi/pi-remembers-stats.db`) with 7-day TTL, and expose them via a `/memory-stats` slash command that serves a rich interactive HTML dashboard on localhost.

## Architecture Decisions

- **`node:sqlite` (built-in `DatabaseSync`)** over `better-sqlite3` — zero install friction, Node 22+ target satisfied, sync API sufficient for our use case
- **Embedded HTML dashboard** — single `getDashboardHtml()` function returning a complete page with inline CSS/JS, no CDN or external deps
- **Logger passed explicitly** — each tool/hook registration accepts an optional `StatsLogger | null` parameter rather than using a global singleton, matching the existing `getClient`/`getConfig` accessor pattern
- **Fire-and-forget instrumentation** — all logger calls are `?.`-guarded and wrapped in try/catch so stats never interfere with tool execution
- **`SynthesizeResult` extended** — return system prompt, task prompt, pi args, raw stdout/stderr, exit code, timeout status for callers to log

## Dependency Graph

```
config.ts (stats flag + dbPath)
    │
    ▼
stats/logger.ts (StatsLogger: SQLite schema, write, read, prune)
    │
    ├──▸ subagent/synthesizer.ts (extended SynthesizeResult)
    │        │
    │        ▼
    ├──▸ tools/remember.ts  ── instrumented ──┐
    ├──▸ tools/recall.ts    ── instrumented ──┤
    ├──▸ tools/search.ts    ── instrumented ──┤
    ├──▸ tools/list.ts      ── instrumented ──┤
    ├──▸ tools/list-projects.ts ─ instrumented┤
    ├──▸ hooks/agent-start.ts ── instrumented ┤
    ├──▸ hooks/compaction.ts ── instrumented ──┤
    │                                          │
    ▼                                          ▼
stats/server.ts (HTTP server + API routes)  index.ts (wiring)
    │
    ▼
stats/dashboard.html.ts (embedded HTML/CSS/JS)
    │
    ▼
commands/stats.ts (/memory-stats, /memory-stats-stop)
```

## Task List

---

### Phase 1: Foundation (Config + Logger + DB)

---

## Task 1: Add stats feature flag and DB path to config

**Description:** Add the `stats` feature flag to `FeatureFlags`, `ResolvedFeatures`, and `FEATURE_DEFAULTS` in `config.ts`. Add a `statsDbPath()` helper function.

**Acceptance criteria:**
- [ ] `FeatureFlags` has `stats?: { enabled?: boolean }`
- [ ] `ResolvedFeatures` has `stats: { enabled: boolean }` (default: `true`)
- [ ] `resolveFeatures()` resolves the new flag with default
- [ ] `statsDbPath()` returns `~/.pi/pi-remembers-stats.db`
- [ ] Existing tests still pass

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (no regressions)

**Dependencies:** None

**Files likely touched:**
- `src/config.ts`

**Estimated scope:** XS (1 file)

---

## Task 2: Create StatsLogger with SQLite schema and write API

**Description:** Create `src/stats/logger.ts` with the `StatsLogger` class. It initializes the SQLite DB using `node:sqlite` (`DatabaseSync`), creates the schema (operations + pipeline_steps tables with indexes), and exposes write methods: `startOperation()`, `logStep()`, `completeOperation()`. All writes are fire-and-forget — errors are caught and swallowed. Payloads > 1MB are truncated. Secret fields are stripped.

**Acceptance criteria:**
- [ ] `StatsLogger` constructor creates/opens the SQLite DB at the given path
- [ ] Schema is created on first open (both tables + indexes)
- [ ] `startOperation()` inserts an operations row and returns a UUID
- [ ] `logStep()` inserts a pipeline_steps row linked to the operation
- [ ] `completeOperation()` updates the operation's status, error, duration_ms
- [ ] JSON payloads > 1MB are truncated with marker text
- [ ] Fields named `apiToken`, `token`, `secret`, `authorization` are stripped from logged data
- [ ] All write methods catch errors internally and never throw
- [ ] `close()` closes the DB connection

**Verification:**
- [ ] New test: `test/stats/logger.test.ts` — write ops/steps, verify row counts
- [ ] New test: payload truncation at 1MB boundary
- [ ] New test: secret stripping
- [ ] `npm run typecheck` passes

**Dependencies:** Task 1 (for `statsDbPath`)

**Files likely touched:**
- `src/stats/logger.ts` (new)
- `test/stats/logger.test.ts` (new)

**Estimated scope:** M (2 files, complex logic)

---

## Task 3: Add read API and prune to StatsLogger

**Description:** Add read methods to `StatsLogger` for the dashboard server to consume: `getSummary()`, `listOperations()`, `getOperation()`, `getOperationCount()`. Add `prune()` method that deletes rows older than 7 days using `ON DELETE CASCADE`.

**Acceptance criteria:**
- [ ] `getSummary()` returns total ops, breakdown by type, by status, avg duration per type, error count in 24h, time range
- [ ] `listOperations({ type?, status?, limit?, offset? })` returns paginated operation rows
- [ ] `getOperation(id)` returns operation + all pipeline steps ordered by step_order
- [ ] `getOperationCount({ type?, status? })` returns filtered count
- [ ] `prune()` deletes operations where `created_at < datetime('now', '-7 days')` and returns count
- [ ] CASCADE deletes associated pipeline_steps

**Verification:**
- [ ] New tests in `test/stats/logger.test.ts` — read back after writes, pagination, filtering
- [ ] New test: prune deletes old rows, keeps recent ones
- [ ] `npm run typecheck` passes

**Dependencies:** Task 2

**Files likely touched:**
- `src/stats/logger.ts` (extend)
- `test/stats/logger.test.ts` (extend)

**Estimated scope:** S (1-2 files)

---

### ✅ Checkpoint: Foundation

- [ ] `npm test` — all tests pass (existing + new logger tests)
- [ ] `npm run typecheck` — clean
- [ ] StatsLogger can write operations + steps and read them back
- [ ] Prune works with 7-day TTL

---

### Phase 2: Synthesizer Extension

---

## Task 4: Extend `SynthesizeResult` with observability fields

**Description:** Add new fields to `SynthesizeResult` in `synthesizer.ts`: `systemPrompt`, `taskPrompt`, `piArgs`, `rawStdout`, `rawStderr`, `exitCode`, `timedOut`, `model`, `thinking`. Populate them in the `synthesize()` function. This is a non-breaking change — callers already destructure only the fields they use.

**Acceptance criteria:**
- [ ] `SynthesizeResult` interface has all new fields
- [ ] `synthesize()` populates `systemPrompt` with the `SYNTHESIS_SYSTEM_PROMPT` constant
- [ ] `synthesize()` populates `taskPrompt` with the constructed task prompt string
- [ ] `synthesize()` populates `piArgs` with the full argument array
- [ ] `synthesize()` populates `rawStdout` and `rawStderr` from the child process
- [ ] `synthesize()` populates `exitCode` from the child process close event
- [ ] `synthesize()` populates `timedOut` from the timeout handler
- [ ] `synthesize()` populates `model` and `thinking` from options
- [ ] Existing callers (recall.ts, search.ts) continue to work unchanged

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (no regressions)

**Dependencies:** None (can be done in parallel with Tasks 2-3)

**Files likely touched:**
- `src/subagent/synthesizer.ts`

**Estimated scope:** S (1 file)

---

### Phase 3: Tool Instrumentation

---

## Task 5: Instrument `memory_remember`

**Description:** Add `StatsLogger` parameter to `registerRememberTool()`. Wrap the `execute()` body with operation tracking: `startOperation()` at entry, `logStep()` at each pipeline stage (input_params, resolve_instance, cloudflare_upload, manifest_schedule, final_output), `completeOperation()` at exit. Wrap in try/catch for error logging.

**Acceptance criteria:**
- [ ] `registerRememberTool` accepts optional `logger?: StatsLogger | null`
- [ ] Operation type is `'remember'`
- [ ] 5 pipeline steps logged: input_params, resolve_instance, cloudflare_upload, manifest_schedule, final_output
- [ ] Each step captures timing (`durationMs`)
- [ ] Error path logs `completeOperation` with `status: 'error'`
- [ ] When logger is null/undefined, behavior is identical to current (no overhead)

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Manual verification: call memory_remember, check SQLite DB has operation + 5 steps

**Dependencies:** Tasks 2, 3

**Files likely touched:**
- `src/tools/remember.ts`

**Estimated scope:** S (1 file)

---

## Task 6: Instrument `memory_recall`

**Description:** Add `StatsLogger` parameter to `registerRecallTool()`. This is the most complex instrumentation — 10 pipeline steps including instance resolution, discovery, Cloudflare search, raw chunks analysis, and full synthesis subprocess detail (config, system prompt, LLM call, result with fallback tracking).

**Acceptance criteria:**
- [ ] `registerRecallTool` accepts optional `logger?: StatsLogger | null`
- [ ] Operation type is `'recall'`
- [ ] 10 pipeline steps logged: input_params, resolve_instances, discovery, cloudflare_search, raw_chunks, synthesis_config, synthesis_system_prompt, synthesis_llm_call, synthesis_result, final_output
- [ ] `raw_chunks` step metadata includes avgScore, minScore, maxScore, count
- [ ] Synthesis steps capture: full system prompt text, task prompt, pi args, raw stdout, exit code, timeout, fallback-to-raw flag
- [ ] Discovery step captures: enabled flag, discovered projects, scores, or skipped reason
- [ ] When synthesis is disabled, steps 6-9 are logged with `skipped` metadata
- [ ] When synthesis fails, step 9 logs error and `fallbackToRaw: true`

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Manual: call memory_recall, verify all 10 steps in DB with correct data

**Dependencies:** Tasks 2, 3, 4

**Files likely touched:**
- `src/tools/recall.ts`

**Estimated scope:** M (1 file, complex instrumentation)

---

## Task 7: Instrument `memory_search`

**Description:** Add `StatsLogger` parameter to `registerSearchTool()`. 8 pipeline steps including Cloudflare search, raw chunks, and full synthesis detail.

**Acceptance criteria:**
- [ ] `registerSearchTool` accepts optional `logger?: StatsLogger | null`
- [ ] Operation type is `'search'`
- [ ] 8 pipeline steps logged: input_params, cloudflare_search, raw_chunks, synthesis_config, synthesis_system_prompt, synthesis_llm_call, synthesis_result, final_output
- [ ] Same synthesis detail as recall (system prompt, task prompt, LLM output, fallback)

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

**Dependencies:** Tasks 2, 3, 4

**Files likely touched:**
- `src/tools/search.ts`

**Estimated scope:** S (1 file)

---

## Task 8: Instrument `memory_list` and `memory_list_projects`

**Description:** Add `StatsLogger` parameter to both `registerListTool()` and `registerListProjectsTool()`. Lighter instrumentation — list operations don't involve synthesis.

**Acceptance criteria:**
- [ ] Both tools accept optional `logger?: StatsLogger | null`
- [ ] `memory_list`: operation type `'list'`, steps: input_params, resolve_targets, cloudflare_list (per target), final_output
- [ ] `memory_list_projects`: operation type `'list_projects'`, steps: input_params, load_registry, final_output
- [ ] Error paths captured

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

**Dependencies:** Tasks 2, 3

**Files likely touched:**
- `src/tools/list.ts`
- `src/tools/list-projects.ts`

**Estimated scope:** S (2 files, simple)

---

### ✅ Checkpoint: Tools Instrumented

- [ ] `npm test` — all tests pass
- [ ] `npm run typecheck` — clean
- [ ] All 5 tools log operations + pipeline steps to SQLite
- [ ] Synthesis subprocess detail is captured in recall/search

---

### Phase 4: Hook Instrumentation

---

## Task 9: Instrument auto-recall hook (`before_agent_start`)

**Description:** Add `StatsLogger` parameter to `registerAgentStartHook()`. Log the auto-recall pipeline: hook config check, query extraction, cache check, instance resolution, Cloudflare search, context building, final output. Also log crash recovery and TTL refresh as separate brief operations.

**Acceptance criteria:**
- [ ] `registerAgentStartHook` accepts optional `logger?: StatsLogger | null`
- [ ] Auto-recall: operation type `'auto_recall'`, 7 steps as per spec
- [ ] Cache hit path: logs `cache_check` step with `cacheHit: true` and skips Cloudflare search
- [ ] Skip paths (disabled, short query, no user message): operation logged with `status: 'skipped'`
- [ ] Crash recovery and TTL refresh: brief `'manifest_refresh'` operations

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

**Dependencies:** Tasks 2, 3

**Files likely touched:**
- `src/hooks/agent-start.ts`

**Estimated scope:** M (1 file, multiple paths)

---

## Task 10: Instrument compaction hook and manifest operations

**Description:** Add `StatsLogger` parameter to `registerCompactionHook()`. Log the compaction ingest pipeline. Also instrument `refreshManifest()` and `discoverProjects()` in `manifest.ts` to log their internal steps.

**Acceptance criteria:**
- [ ] `registerCompactionHook` accepts optional `logger?: StatsLogger | null`
- [ ] Compaction: operation type `'compaction_ingest'`, steps: hook_config, extract_messages, cloudflare_upload, manifest_refresh
- [ ] `refreshManifest` can accept optional logger, logs type `'manifest_refresh'` with steps: build_manifest, ensure_instance, remove_stale, publish, clear_dirty
- [ ] `discoverProjects` can accept optional logger, logs type `'manifest_discover'` with steps: discovery_config, cloudflare_search, rank_projects

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes

**Dependencies:** Tasks 2, 3

**Files likely touched:**
- `src/hooks/compaction.ts`
- `src/manifest.ts`

**Estimated scope:** M (2 files)

---

## Task 11: Instrument session lifecycle in `index.ts`

**Description:** Wire the `StatsLogger` into `index.ts`: create it on first `initClients()`, pass it to all tool/hook registrations, run `prune()` on `session_start`, close on `session_shutdown`. Also log `session_start` and `instance_ensure` operations.

**Acceptance criteria:**
- [ ] `StatsLogger` is created once when config resolves and `features.stats.enabled` is true
- [ ] Logger is passed to all `register*` functions
- [ ] `session_start` triggers `logger.prune()` (7-day TTL cleanup)
- [ ] `session_start` logs a `'session_start'` operation with steps: init_config, registry_touch
- [ ] `ensureProjectInstances()` logs an `'instance_ensure'` operation
- [ ] `session_shutdown` calls `logger.close()`
- [ ] If stats feature is disabled, logger is null and all calls are no-ops

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (existing tests pass with null logger)

**Dependencies:** Tasks 5, 6, 7, 8, 9, 10

**Files likely touched:**
- `src/index.ts`

**Estimated scope:** M (1 file, many wiring changes)

---

### ✅ Checkpoint: Full Instrumentation

- [ ] `npm test` — all tests pass
- [ ] `npm run typecheck` — clean
- [ ] Every tool, hook, and lifecycle event logs operations + steps
- [ ] Manual: run a session, check `~/.pi/pi-remembers-stats.db` has data

---

### Phase 5: Dashboard Server

---

## Task 12: Create HTTP server with API routes

**Description:** Create `src/stats/server.ts` with a function that starts an HTTP server on a random port (bound to `127.0.0.1`). Implement all API endpoints: `/api/summary`, `/api/operations`, `/api/operations/:id`, `/api/memories`, `/api/config`, `/api/shutdown`. The server reads data from `StatsLogger` read methods and calls Cloudflare API for live memory listings.

**Acceptance criteria:**
- [ ] `startStatsServer(logger, getClient, getConfig)` returns `{ server, port, url, close() }`
- [ ] Server binds to `127.0.0.1` on port 0 (OS-assigned)
- [ ] `GET /api/summary` returns JSON from `logger.getSummary()`
- [ ] `GET /api/operations?type=&status=&limit=&offset=` returns paginated operations
- [ ] `GET /api/operations/:id` returns operation + steps
- [ ] `GET /api/memories` calls Cloudflare API live and returns project + global items
- [ ] `GET /api/config` returns sanitized config (apiToken → "***")
- [ ] `POST /api/shutdown` closes the server and resolves
- [ ] `GET /` serves the dashboard HTML (placeholder for now)
- [ ] All routes set CORS headers for localhost
- [ ] Server uses `node:http` only (no express/koa)

**Verification:**
- [ ] New test: `test/stats/server.test.ts` — start server, hit endpoints with fetch, verify responses
- [ ] `npm run typecheck` passes

**Dependencies:** Task 3

**Files likely touched:**
- `src/stats/server.ts` (new)
- `test/stats/server.test.ts` (new)

**Estimated scope:** M (2 files)

---

## Task 13: Build the dashboard HTML — layout, tabs, summary cards

**Description:** Create `src/stats/dashboard.html.ts` exporting `getDashboardHtml(port: number): string`. Build the shell: dark-themed layout, tab navigation (Overview, Operations, Memory Store, Config), header with status/refresh/live-toggle/shutdown buttons. Implement the **Overview tab**: summary cards fetched from `/api/summary`, timeline bar chart (ops per hour over 24h), recent errors list.

**Acceptance criteria:**
- [ ] `getDashboardHtml(port)` returns valid, self-contained HTML with all CSS/JS inline
- [ ] Dark theme with CSS variables (background: #0d1117, cards: #161b22, text: #e6edf3)
- [ ] Header: title, connection status dot, Refresh button, Live toggle (5s polling, off by default, localStorage-persisted), Shutdown button
- [ ] Tab bar: Overview, Operations, Memory Store, Config — switching shows/hides content
- [ ] Overview tab: summary cards (total ops, by type, success rate, avg durations, errors 24h, last op time)
- [ ] Overview tab: simple CSS bar chart for operations per hour (last 24h, color by type)
- [ ] Overview tab: recent errors list (last 10 errors with type, time, message, clickable to Operations tab)
- [ ] Shutdown button POSTs to `/api/shutdown` and shows "Server stopped" message
- [ ] Live toggle: when ON, polls `/api/summary` and `/api/operations` every 5s
- [ ] No external CDN links or dependencies

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] Manual: open HTML in browser, verify layout, tabs work, dark theme renders

**Dependencies:** Task 12

**Files likely touched:**
- `src/stats/dashboard.html.ts` (new)

**Estimated scope:** L (1 file, substantial HTML/CSS/JS)

---

## Task 14: Build the Operations tab — table, filters, pipeline detail

**Description:** Add the Operations tab to the dashboard: filterable operations table, pagination, and the **pipeline detail panel** that expands when clicking a row. The pipeline view shows step boxes connected by arrows, each with expandable JSON viewers, duration bars, and bottleneck highlighting.

**Acceptance criteria:**
- [ ] Operations table: columns — Timestamp, Type (badge), Scope, Query (truncated+tooltip), Status (badge), Duration, Steps count
- [ ] Type badges color-coded: Remember=green, Recall=blue, Search=purple, Auto-Recall=yellow, Compaction=orange, Manifest=gray
- [ ] Status badges: Success=green, Error=red, Skipped=dim
- [ ] Filters: Type dropdown, Status dropdown, time range (1h/6h/24h/7d), search box (query text)
- [ ] Pagination: 50 per page, prev/next buttons, showing "Page X of Y"
- [ ] Click row → expands pipeline detail panel below
- [ ] Pipeline view: horizontal step boxes connected by → arrows
- [ ] Each step box shows: name, duration badge, click to expand input/output/metadata
- [ ] Expanded step: collapsible JSON viewer (pretty-printed, monospace), metadata key-values, error (red box)
- [ ] Bottleneck: slowest step gets orange "⚠ SLOWEST" badge
- [ ] Steps with >50% of total duration get warning indicator
- [ ] Error steps: red border + ❌
- [ ] Skipped steps: gray/dim styling

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] Manual: with test data, verify table rendering, filters, pagination, pipeline expansion, JSON viewers, bottleneck highlighting

**Dependencies:** Task 13

**Files likely touched:**
- `src/stats/dashboard.html.ts` (extend)

**Estimated scope:** L (1 file, substantial JS logic)

---

## Task 15: Build Memory Store and Config tabs

**Description:** Add the remaining two dashboard tabs. Memory Store shows live data from Cloudflare (project + global items). Config shows sanitized resolved config with feature flag badges.

**Acceptance criteria:**
- [ ] Memory Store tab: two sections (Project Memories, Global Memories)
- [ ] Each section: table with Key, Status, Timestamp columns + item count
- [ ] Loading spinner while fetching from `/api/memories`
- [ ] Error display if API call fails
- [ ] Config tab: shows ResolvedConfig as formatted key-value sections
- [ ] Feature flags shown with enabled/disabled badges (green/red)
- [ ] Hook settings shown with checkmark/circle indicators
- [ ] Instance names, project identity (id, name, aliases, root)
- [ ] apiToken displayed as "***"

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] Manual: verify both tabs render correctly with mock/real data

**Dependencies:** Task 13

**Files likely touched:**
- `src/stats/dashboard.html.ts` (extend)

**Estimated scope:** M (1 file)

---

### ✅ Checkpoint: Dashboard Complete

- [ ] `npm test` — all tests pass
- [ ] `npm run typecheck` — clean
- [ ] Dashboard renders all 4 tabs with correct data
- [ ] Pipeline detail view shows all steps with JSON expansion
- [ ] Bottleneck highlighting works
- [ ] Refresh and live toggle work

---

### Phase 6: Commands & Final Wiring

---

## Task 16: Register `/memory-stats` and `/memory-stats-stop` commands

**Description:** Create `src/commands/stats.ts` that registers both commands. `/memory-stats` starts the dashboard server, opens the browser, shows a notification. If already running, re-opens browser to existing URL. `/memory-stats-stop` shuts down the server. Wire both commands into `index.ts`.

**Acceptance criteria:**
- [ ] `/memory-stats` starts the HTTP server via `startStatsServer()`
- [ ] Opens browser via `open` (macOS) / `xdg-open` (Linux) / `start` (Windows)
- [ ] Shows notification: `"📊 Memory Stats dashboard at http://localhost:PORT — /memory-stats-stop to close"`
- [ ] If server already running, re-opens browser to existing URL (doesn't start a second server)
- [ ] `/memory-stats-stop` closes the server and notifies `"📊 Dashboard server stopped."`
- [ ] If no server running, `/memory-stats-stop` notifies "No dashboard server running"
- [ ] Both commands registered in `index.ts`
- [ ] Server reference stored in module-level closure

**Verification:**
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes
- [ ] Manual: run `/memory-stats`, browser opens, dashboard loads, `/memory-stats-stop` kills it

**Dependencies:** Tasks 12, 13, 14, 15, 11

**Files likely touched:**
- `src/commands/stats.ts` (new)
- `src/index.ts` (import + register)

**Estimated scope:** S (2 files)

---

## Task 17: Integration test — full pipeline roundtrip

**Description:** Write an integration test that: creates a StatsLogger, instruments a mock remember + recall cycle, verifies the DB contains the expected operations and pipeline steps with correct structure and data.

**Acceptance criteria:**
- [ ] Test creates a temp SQLite DB
- [ ] Simulates remember operation with all 5 steps
- [ ] Simulates recall operation with all 10 steps (including synthesis detail)
- [ ] Verifies operations table has 2 rows with correct types and statuses
- [ ] Verifies pipeline_steps has correct step counts and ordering
- [ ] Verifies synthesis steps contain system prompt, task prompt, LLM output
- [ ] Verifies prune removes old data but keeps recent
- [ ] Cleans up temp DB after test

**Verification:**
- [ ] `npm test` passes including this test

**Dependencies:** Tasks 2, 3

**Files likely touched:**
- `test/stats/integration.test.ts` (new)

**Estimated scope:** M (1 file)

---

### ✅ Checkpoint: Complete

- [ ] `npm test` — all tests pass (existing + 3 new test files)
- [ ] `npm run typecheck` — clean
- [ ] `/memory-stats` launches dashboard, all tabs work
- [ ] Pipeline detail shows every step for remember/recall/search/hooks
- [ ] Synthesis subprocess detail visible (system prompt, LLM call, fallback)
- [ ] Bottleneck highlighting identifies slow steps
- [ ] Error operations show which step failed and why
- [ ] Live toggle polls every 5s when enabled
- [ ] `/memory-stats-stop` cleanly shuts down
- [ ] 7-day TTL prune runs on extension start
- [ ] Stats logging doesn't slow down or break any tool

---

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `node:sqlite` experimental API changes | Med | API surface we use (DatabaseSync, prepare, run, get, all) is stable; pin to known-good patterns. Can swap to better-sqlite3 later if needed. |
| Large payloads bloat DB | Low | 1MB cap per field + 7-day TTL + prune on startup keeps DB manageable |
| Instrumentation slows down tools | High | All logger calls are `?.`-guarded, fire-and-forget, wrapped in try/catch. Sync SQLite writes are <1ms. |
| Dashboard HTML is too large for a template literal | Med | Split into sections, use string concatenation. At ~50KB HTML this is fine. |
| Concurrent sessions writing to same SQLite DB | Low | `node:sqlite` uses WAL mode by default; concurrent readers/writers are safe at our scale. |
| Browser open command varies by OS | Low | Use `child_process.exec` with platform detection: `open` (darwin), `xdg-open` (linux), `start` (win32). |
