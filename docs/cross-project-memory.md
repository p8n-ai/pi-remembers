# Cross-Project Memory

Pi Remembers supports **cross-project memory discovery** with strict write
boundaries. You can *read* memories from any known project, but writes always
go to the current project (or global).

## Two problems this solves

1. **Subfolder confusion.** Opening a subdirectory of a project used to create
   a fresh "project" keyed on the subfolder's basename, separating memories
   from the same codebase. Phase 1 introduces stable project identity via a
   `.pi/pi-remembers.json` marker resolved git-style (walk up to the nearest
   marker).
2. **No cross-project recall.** Memories created in project A could not be
   found from project B, even when the projects integrate. Phase 2 adds
   explicit cross-project reads (`memory_recall({ projects: [...] })`). Phase
   3 adds automatic discovery via a shared manifest index.

## Project identity (Phase 1)

When you run any memory tool in a directory without a marker:

1. Plugin walks up from `cwd` looking for `.pi/pi-remembers.json`.
2. If none found and `features.identity.autoCreateMarker` is on (default), a
   new marker is written at `cwd` with a stable opaque id (`prj_xxxxxxxx`)
   and a slug derived from the folder name.
3. Subfolders of a project now resolve to the same marker → same memory
   instance.

The marker is safe to commit — the id is opaque and contains no secrets. Your
teammates hit the same memory instance.

### Marker contents

```jsonc
{
  "id": "prj_9f2e1c44",
  "name": "acme-api",
  "aliases": ["backend", "api"],         // optional: alternate names
  "relatedProjects": ["prj_a1b2c3"],     // optional: explicit cross-project links
  "workspace": "acme",                   // optional, Phase 4 hook
  "manifest": {                          // optional manifest override
    "description": "Payments + webhooks service.",
    "topics": ["payments", "stripe"]
  },

  // Overrides (pre-existing)
  "memoryInstance": "…",
  "searchInstance": "…",
  "hooks": { "autoRecall": false, "autoIngest": false, "showStatus": true }
}
```

### Project registry

A machine-local cache lives at `~/.pi/pi-remembers-projects.json`. It records
`{id, name, aliases, roots, lastSeen, memoryInstance}` per project so the
agent can enumerate known projects (via `memory_list_projects`) and resolve
cross-project references by name/alias. Losing this file is harmless — it
repopulates as you open each project.

## Cross-project read (Phase 2)

### Scopes

`memory_recall({ query, scope })`:

| Scope     | Searches                                                    |
|-----------|-------------------------------------------------------------|
| `project` | Current project only                                        |
| `global`  | Global memory only                                          |
| `both`    | Project + global (**default**, plus `relatedProjects` when `features.recall.includeRelated` is on) |
| `related` | Project + global + `relatedProjects`                        |
| `all`     | Every project in the registry + global (read-only)          |

### Explicit project refs

```
memory_recall({ query: "Clerk org-mode", projects: ["acme-frontend", "infra"] })
```

Refs are resolved case-insensitively against id, name, or alias. Unknown refs
surface as warnings in the tool result — they do not throw.

### Write boundary

`memory_remember` has no `projects` parameter. Writes always go to the current
project (`scope: "project"`, default) or to global (`scope: "global"`). This
is enforced by the tool schema itself.

### Enumeration

`memory_list_projects` returns everything in the registry so the LLM can
discover what exists before issuing a cross-project recall.

## Automatic discovery (Phase 3)

When `features.manifest.enabled=true` and `features.recall.includeDiscovered=true`,
every recall pre-queries a tiny **manifest index** (one document per project,
no raw memory bodies) to find semantically relevant projects, then fans out
the actual search to them.

### Manifest refresh triggers

All flag-gated under `features.manifest`:

| Flag                          | When                                          | Default   |
|-------------------------------|-----------------------------------------------|-----------|
| `autoUpdateOnWrite`           | Debounced flush after `memory_remember` (T1)  | on        |
| `autoUpdateOnSessionEnd`      | Flush pending on `session_shutdown` (T2)      | on        |
| `autoUpdateOnAgentStartTTL`   | Lazy refresh once/session if stale (T3)       | on        |
| `autoUpdateOnCompaction`      | Opportunistic during compaction (T4)          | on        |
| *(manual)*                    | `/memory-manifest-refresh` (T5)               | –         |

The write-through debounce window (`debounceMs`) has a **60 s minimum** —
bursts of writes collapse into a single publish, but the user always gets
their data reflected within a bounded window. A dirty-flag file
(`~/.pi/pi-remembers-dirty.json`) lets the plugin recover from crashed
sessions.

### Manifest contents

Derived only from memory *titles/counts* and user-declared overrides in
`.pi/pi-remembers.json > manifest`. Raw memory bodies are **never** uploaded
to the shared manifest instance.

## Feature flags — all toggles & defaults

All live in `~/.pi/pi-remembers.json > features`. Use `/memory-settings` for
an interactive UI.

```jsonc
{
  "features": {
    "identity": {
      "autoCreateMarker": true,
      "walkUp": true,
      "registryEnabled": true,
      "migrateLegacy": true
    },
    "recall": {
      "includeRelated": true,
      "includeDiscovered": false,
      "discoveryThreshold": 0.55,
      "discoveryTopK": 3,
      "discoveryTimeoutMs": 1500
    },
    "manifest": {
      "enabled": false,
      "instanceId": "pi-remembers-manifest",
      "autoUpdateOnWrite": true,
      "autoUpdateOnSessionEnd": true,
      "autoUpdateOnAgentStartTTL": true,
      "autoUpdateOnCompaction": true,
      "debounceMs": 60000,
      "ttlDays": 7,
      "sampleSize": 20
    }
  }
}
```

## Commands

- `/memory-project` — show current project's identity.
- `/memory-project --init` — force-create a marker at cwd.
- `/memory-project --add-alias <name>` — add an alias.
- `/memory-project --list` — list all known projects.
- `/memory-manifest-refresh` — manually rebuild + publish manifest record.
- `/memory-manifest-refresh --status` — inspect dirty projects and trigger state.
- `/memory-settings` — toggle any flag interactively.

## Upgrade path for existing installs

Nothing changes until you opt in:

- Legacy markerless sessions: if you had `pi-remembers-proj-<basename>`
  instances on Cloudflare, Phase 1's `migrateLegacy` (on by default) pins any
  newly-upgraded marker to the same legacy name. Your data stays reachable.
- Discovery & manifest are **off by default** — no behavior change until you
  flip `features.manifest.enabled`.
- Related-project recall defaults **on** but has no effect until you populate
  `relatedProjects` in your marker.
