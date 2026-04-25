# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Pipeline Observatory** — Local dashboard (`/memory-stats`) showing every operation’s pipeline steps, timing, chunk scores, and synthesis details. Backed by SQLite (`~/.pi/pi-remembers-stats.db`) with 7-day TTL. Opens in browser on `127.0.0.1`.
- **PipelineRecorder abstraction** — Clean logging wrapper (`src/stats/recorder.ts`) that auto-numbers steps and provides `success()/error()/skip()` completions. Returns a silent NOOP recorder when stats are disabled — no conditionals needed in business logic.
- **Chunk score filtering** — `features.recall.minChunkScore` (default 0.6) and `features.search.minChunkScore` (default 0.5) independently filter low-scoring chunks before synthesis or display.
- New config: `features.stats.enabled` (default true), `features.search.minChunkScore`.
- New commands: `/memory-stats`, `/memory-stats-stop`.
- New files: `src/stats/logger.ts`, `src/stats/recorder.ts`, `src/stats/server.ts`, `src/stats/dashboard.html.ts`, `src/commands/stats.ts`.
- Tests: `test/stats/logger.test.ts` (13 tests), `test/stats/recorder.test.ts` (7 tests), `test/stats/integration.test.ts` (3 tests).
- ADR-001: Pipeline observability design rationale (`docs/decisions/ADR-001-pipeline-observability.md`).

### Changed
- All tools and hooks refactored to use PipelineRecorder instead of inline logger calls.
- `SynthesizeResult` now includes observability fields (system prompt, task prompt, raw stdout/stderr, exit code) for pipeline tracing.
- `prune()` uses `changes` from DELETE statement instead of two COUNT queries.


## [0.3.0] - 2026-04-22

### Added
- **Context synthesis** — `memory_recall` and `memory_search` results are automatically synthesized via a lightweight `pi --print` sub-process before returning to the main agent. Raw Cloudflare AI Search chunks are filtered down to only query-relevant information, reducing context window consumption by ~80%. Enabled by default; configure via `features.subagent` in `~/.pi/pi-remembers.json`.
- New files: `src/subagent/pi-spawn.ts` (pi binary resolution), `src/subagent/synthesizer.ts` (spawn + collect logic).

### Changed
- `memory_recall` and `memory_search` now return synthesized output when `features.subagent.enabled` is `true` (default). Set to `false` to restore raw output.
- README updated with cross-project recall documentation, `memory_list_projects` tool, new slash commands, and context synthesis configuration.

## [0.2.0] - 2026-04-20

### Added
- **Cross-project memory** — search memories across any known project with stable project identity.
- Stable project identity via `.pi/pi-remembers.json` marker with opaque id, slug, and aliases.
- Git-style walk-up marker resolution (fixes subfolder confusion).
- `memory_recall`: new `related` and `all` scopes, plus `projects` parameter for explicit cross-project reads.
- `memory_list_projects` tool for LLM-side project discovery.
- Manifest-based automatic discovery (Phase 3, opt-in via `features.manifest.enabled`).
- New commands: `/memory-project`, `/memory-manifest-refresh`.
- 57 tests covering config, registry, manifest, tools, and regression.

## [0.1.2] - 2026-04-19

## [0.1.1] - 2026-04-19

## [0.1.0] - 2026-04-19

### Added
- Initial release of `@p8n.ai/pi-remembers`
- **Direct Cloudflare AI Search REST API**
  - Standard Cloudflare API Token auth (AI Search:Edit + AI Search:Run)
  - Namespace support (`default` or custom like `pi-remembers`)
  - Native cross-instance search via namespace API
- **4 LLM-callable tools**
  - `memory_recall` — search persistent memories across project and global scopes
  - `memory_remember` — store facts, decisions, and preferences as persistent memories
  - `memory_search` — hybrid vector + keyword search over indexed project files
  - `memory_list` — list stored memories for current project or globally
- **4 slash commands**
  - `/memory-setup` — guided Cloudflare Account ID, API Token, and namespace setup
  - `/memory-settings` — interactive toggle for hooks (auto-recall, auto-ingest, footer status)
  - `/memory-status` — show API connection status, hook states, memory counts, and indexed file stats
  - `/memory-index [paths]` — index project files into AI Search (respects `.gitignore`)
- **3 automatic event hooks** (all OFF by default except footer status)
  - `session_before_compact` — ingest conversation summaries into memory on compaction (default: OFF)
  - `before_agent_start` — auto-recall relevant memories before each LLM turn (default: OFF)
  - `session_start` — show memory status in footer (default: ON)
- **2 bundled skills**
  - `pi-remembers` — teaches the agent when and how to use memory tools
  - `pi-remembers-index` — teaches the agent about file indexing
- **Dual-scope memory profiles**
  - Global (`pi-remembers-global`) — cross-project user preferences
  - Project (`pi-remembers-proj-{name}`) — project-specific architecture and decisions
- **Secure configuration**
  - `~/.pi/pi-remembers.json` for global config (Account ID, API token env var, namespace, hook defaults)
  - `.pi/pi-remembers.json` for project overrides (instance names, hook toggles)
  - API token resolved from environment variable, never stored in plaintext

[Unreleased]: https://github.com/p8n-ai/pi-remembers/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/p8n-ai/pi-remembers/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/p8n-ai/pi-remembers/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/p8n-ai/pi-remembers/releases/tag/v0.1.2
[0.1.1]: https://github.com/p8n-ai/pi-remembers/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/p8n-ai/pi-remembers/releases/tag/v0.1.0
