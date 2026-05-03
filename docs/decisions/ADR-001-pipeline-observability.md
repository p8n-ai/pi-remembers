# ADR-001: Pipeline Observability with SQLite Stats Logger

## Status
Accepted

## Date
2026-04-25

## Context

As @p8n.ai/pi-remembers grew from simple remember/recall tools to a multi-phase pipeline (instance resolution → discovery → Cloudflare search → chunk filtering → synthesis → output), debugging became difficult. When a recall returned unexpected results, there was no way to know:

- Which pipeline step took the most time?
- Were chunks dropped by score filtering? How many?
- Did synthesis succeed or fall back to raw output?
- What was the actual query sent to Cloudflare?

Users reported "no results found" without context on whether the issue was Cloudflare returning empty, chunks being filtered below threshold, or synthesis failing silently. We needed observability without adding external dependencies or complicating the user setup.

## Decision

Instrument all tools and hooks with a SQLite-backed `StatsLogger` that records operations and their pipeline steps. Expose the data via a local-only HTTP dashboard (`/memory-stats` command).

### Key design choices:

1. **`node:sqlite` (DatabaseSync)** — Zero external dependencies. Available in Node 22.5+ which pi already requires. Synchronous writes keep the fire-and-forget logging pattern simple.

2. **Fire-and-forget writes** — All logger methods catch and swallow errors. Stats must never interfere with tool execution. If the DB is corrupt or unavailable, tools work exactly as before.

3. **PipelineRecorder abstraction** — Instead of interleaving `if (opId) logger?.logStep(...)` guards throughout business logic, a `createRecorder()` factory returns either a live recorder or a silent NOOP. Callers use `rec.step("name", { input, output })` without conditionals.

4. **Local-only HTTP server** — Dashboard binds to `127.0.0.1` on a random port. No authentication needed since it's localhost-only. Browser auto-opens via `open`/`xdg-open`.

5. **7-day TTL** — Rows are pruned on session start. Stats are for debugging recent issues, not long-term analytics.

6. **Separate `search.minChunkScore` from `recall.minChunkScore`** — Search (indexed files) and recall (memories) have different score distributions. Using a single threshold would either over-filter search results or under-filter recall results.

## Alternatives Considered

### Structured logging to stdout/file
- Pros: Simpler implementation, greppable
- Cons: No queryable structure, no dashboard, logs interleave with agent output, hard to correlate steps within an operation
- Rejected: The pipeline has 5-10 steps per operation; flat logs don't show the step-by-step flow

### OpenTelemetry / external tracing
- Pros: Industry standard, rich ecosystem, distributed tracing
- Cons: Requires external collector setup (Jaeger, Zipkin, or cloud service), heavyweight dependency, not appropriate for a pi extension where users expect zero-config
- Rejected: Violates the "your data, your account" principle and adds setup burden

### In-memory only (no persistence)
- Pros: Simplest, no disk I/O
- Cons: Lost on session end, can't compare across sessions, can't diagnose issues retroactively
- Rejected: The most valuable debugging happens after the fact — "why did my recall 20 minutes ago return nothing?"

### better-sqlite3 npm package
- Pros: Battle-tested, synchronous API, widely used
- Cons: Native binary dependency, complicates installation across platforms, `node:sqlite` is now stable enough
- Rejected: Zero-dependency philosophy of the extension; `node:sqlite` provides equivalent functionality

## Consequences

### Positive
- Every tool/hook operation is traceable with step-level timing
- Dashboard makes it easy to spot slow synthesis, filtered chunks, or failed API calls
- Feature-flagged (`features.stats.enabled`, default true) — can be disabled entirely
- PipelineRecorder keeps business logic clean — logging doesn't obscure the recall/search algorithms
- Secret redaction prevents accidental credential logging

### Negative
- SQLite DB grows on disk (~1KB per operation, pruned at 7 days — negligible)
- `node:sqlite` is still marked experimental (warnings on stderr); may need migration if API changes
- Dashboard is self-contained HTML (635 lines) — updates require code changes, not separate frontend deployment

### Risks
- Raw stdout/stderr from synthesis subprocess is logged — could contain sensitive user content. Mitigated by 7-day TTL and localhost-only dashboard, but worth monitoring.
