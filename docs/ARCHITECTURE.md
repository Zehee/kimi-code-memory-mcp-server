# Architecture

This document explains how Kimi Code Memory MCP Server is structured, how data flows, and why we made the key design choices.

## Design Principles

1. **Markdown is the source of truth**
   - Every memory is a `.md` file with YAML frontmatter.
   - `index.json` is a rebuildable cache, not the database.
   - Users can edit files directly; running `sync_workspace_index` repairs the cache.

2. **Local-first, offline, zero external dependencies**
   - No vector database, no graph database, no cloud API.
   - Works entirely on the local filesystem.

3. **Structured before fuzzy**
   - Memories are written into typed folders (`decisions/`, `knowledge/`, `rules/`, `reference/`).
   - Keyword search + tags + theme tracing are the default retrieval model.
   - Optional embedding/LLM layers can be added later as plugins.

4. **Cross-session context recovery**
   - The server reads Kimi Code CLI's `wire.jsonl` to rebuild recent conversation context.
   - This is intentionally Kimi-specific; other CLI adapters can be added later.

## Data Flow

```text
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Kimi Code CLI  │────▶│  wire.jsonl      │────▶│ wire-context.ts │
│  (conversation) │     │  (event stream)  │     │ (parser)        │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  Agent tools    │◀────│  MCP server      │◀────│  context-tools  │
│  remember/      │     │  src/server.ts   │     │                 │
│  search/        │     │                  │     │                 │
│  trace_theme/   │     │                  │     │                 │
└─────────────────┘     └────────┬─────────┘     └─────────────────┘
                                 │
           ┌─────────────────────┼─────────────────────┐
           │                     │                     │
           ▼                     ▼                     ▼
   ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
   │ memory-tools  │    │ theme-tools   │    │ system-tools  │
   │ CRUD memory   │    │ tag/trace/    │    │ organize/     │
   │ files         │    │ refine        │    │ sync/bootstrap│
   └───────┬───────┘    └───────┬───────┘    └───────┬───────┘
           │                    │                    │
           ▼                    ▼                    ▼
   ┌───────────────┐    ┌───────────────┐    ┌───────────────┐
   │ memory-store  │    │ theme-manager │    │ refined-      │
   │ (.md I/O)     │    │ (themes/*.json)│   │ manager       │
   └───────┬───────┘    └───────────────┘    │ (refined/     │
           │                                  │  refined.sqlite)│
           ▼                                  └───────────────┘
   ┌───────────────┐
   │ IndexDao      │
   │ (index.json)  │
   └───────────────┘
```

## Module Responsibilities

| File                          | Responsibility                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/server.ts`               | MCP server entry, registers tools, starts stdio transport.                                                                      |
| `src/config.ts`               | Default paths, environment variable handling (`MEMORY_STORE_ROOT`, `MEMORY_SESSIONS_ROOT`, `KIMI_CODE_HOME`).                   |
| `src/tools/index.ts`          | Tool schemas, validation, and dispatch.                                                                                         |
| `src/tools/memory-tools.ts`   | `remember`, `recall`, `search`, `list`, `list_tags`, `delete`, `move`.                                                          |
| `src/tools/context-tools.ts`  | `load_more_context`, `search_context`, saved search views, `load_turn_context`.                                                 |
| `src/tools/theme-tools.ts`    | `tag_theme`, `trace_theme`, `list_themes`, `refine_session_turns`.                                                              |
| `src/tools/system-tools.ts`   | `organize_memories`, `sync_workspace_index`, `bootstrap_workspace`, workspace and dashboard entry points.                       |
| `src/dao/index.ts`            | `index.json` 3-kv DAO with structure-hash consistency check.                                                                    |
| `src/dao/memory-store.ts`     | Markdown I/O, stable memory identity, external-edit detection and revision/hash compare-and-swap.                               |
| `src/context/wire-context.ts` | Parses Kimi Code CLI `wire.jsonl` into conversation rounds.                                                                     |
| `src/theme-manager.ts`        | Reads/writes `themes/<theme>.json` and maintains stable memory references and lifecycle states.                                 |
| `src/search/`                 | Host workspace discovery, strict search-view persistence and shared deletion/reference protection.                              |
| `src/vis/security.ts`         | Dashboard bearer authentication, Host/Origin checks, runtime-file and request boundaries.                                       |
| `src/utils/workspace-lock.ts` | Cross-process workspace lock with leases, heartbeats and stale-owner recovery.                                                  |
| `src/utils/workspace-journal.ts` | Prepared/committed write records and crash recovery for Markdown, index and theme mutations.                                |
| `src/background/`             | Bounded wire indexing, source freshness, append-only incremental parsing and exact lag measurement.                             |
| `src/refined-manager.ts`      | Stores refined turn summaries in `refined/refined.sqlite`.                                                                      |
| `src/maintenance.ts`          | Doctor reports, mirrored exports, backups and retention pruning.                                                                |
| `src/purge.ts`                | Explicit derived-data purge with workspace-scoped safety checks.                                                                |
| `src/utils/metrics.ts`        | Content-free counters, gauges, health and timing metrics.                                                                       |
| `src/setup.ts`                | Installs and removes the Kimi Code integration (`AGENTS.md`, skill, `mcp.json`) with an install manifest, backups and rollback. |
| `src/utils/frontmatter.ts`    | YAML frontmatter parser and serializer.                                                                                         |
| `src/utils/paths.ts`          | Path helpers and storage root resolution.                                                                                       |
| `src/utils/validation.ts`     | Input sanitization (`sanitizeKey`, `sanitizeFolder`).                                                                           |

## `index.json` 3-kv

`index.json` is a fast cache over the Markdown files on disk. The `version` field is the literal string `3-kv`; the DAO also migrates the legacy `entries` format (`version: 1`) on load.

```json
{
  "version": "3-kv",
  "meta": {
    "lastSyncAt": "2026-06-24T12:00:00.000Z",
    "structureHash": "5f2b1c0d9a8e7f6a5b4c3d2e1f0a9b8c"
  },
  "index": {
    "memory/decisions/": {
      "comment": "Architecture and product decisions"
    },
    "memory/decisions/choose-sqlite.md": {
      "title": "Choose Sqlite",
      "tags": ["decision", "database"]
    }
  }
}
```

- `meta.lastSyncAt` is the timestamp of the last save of the index.
- `meta.structureHash` is the md5 digest of the sorted `"<relative path>:<size>:<mtime ns>"` lines of every `.md` file under `memory/`, `notes/` and `essence/`. It is a **change detector**, not a content hash.
- Memory files carry `id`, `revision`, `contentHash` and `metadataHash`; index entries expose `title`, `tags`, `id`, `revision` and `contentHash`. Folder descriptions are stored as `{ "comment": "..." }` entries keyed by the folder path with a trailing `/`. There is no separate `folderComments` object.
- A plain DAO `getIndex()` does not trigger a full rebuild. `sync_workspace_index`, `bootstrap_workspace` and index-backed dashboard GET routes (`workspace`, `memories`, `folders` and `themes`) reconcile the index; operational and refined-only routes do not. `remember` / `move` / `delete` update affected entries incrementally and reset `meta.structureHash`.
- The DAO also supports migration from older index formats.

## Memory Lifecycle

1. **Capture** — Agent writes a memory via `remember`.
2. **Index** — `MemoryStore` atomically writes the `.md` file, then `IndexDao` updates `index.json`.
3. **Recall** — Agent uses `search`, `recall`, or `list` to retrieve memories.
4. **Distill** — `organize_memories` condenses `memory/` into `essence/essence.md` (≤15 KB).
5. **Trace** — `tag_theme` and `trace_theme` connect memories and conversation turns into evolving themes.
6. **Archive/Move** — `move` renames or relocates a memory; `delete` removes it.

## Installation Ownership

`kimi-memory-setup` changes three targets in the Kimi Code home directory:

| Target                 | What is written                                                                                            | Ownership check                                           |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `AGENTS.md`            | The memory protocol, between `<!-- KIMI-MEMORY-INJECTED-START -->` and `<!-- KIMI-MEMORY-INJECTED-END -->` | The block must still match the one this tool wrote        |
| `skills/memory-manage` | The bundled skill directory                                                                                | The content hash of the directory must match the manifest |
| `mcp.json`             | The `mcpServers.kimi-memory` entry                                                                         | The canonical JSON of the entry must match the manifest   |

Every install is recorded in `<KIMI_CODE_HOME>/memory-setup/manifest.json`: the content hash of what was written, whether the target existed before, and the location of the backup. The previous content is copied to `<KIMI_CODE_HOME>/memory-setup/backups/` before anything is overwritten, and a failing step rolls the whole install back to the original state.

A re-install keeps the backup of the first installation while the target is unchanged. If the user changed a target after the install and a later run is about to overwrite it again, a FRESH backup of the current state is taken first — so an undo restores the pre-overwrite content (with the user's edits) instead of the first-install snapshot. For `AGENTS.md` an undo may also switch to surgical mode: it then removes only the injected block and leaves the user's changes in place.

`--undo` only removes content that still matches the manifest. Content the user changed after the install is kept and reported as a conflict, so an undo never destroys work that the tool does not own.

## Why No Vector Database by Default?

Vector search is excellent for:

- Fuzzy "something like this" queries
- Synonym matching
- Large corpora where keyword recall is insufficient

For a coding assistant, however, the most valuable memories are usually:

- Exact decisions (`decisions/`)
- Explicit conventions (`rules/`)
- Known project facts (`knowledge/`)

These are best retrieved by **path + tags + keywords + theme links**, which is fast, deterministic, and fully explainable.

We keep the door open for optional embedding plugins, but the default path is intentionally lightweight.

## Security Notes

- `sanitizeKey` and `sanitizeFolder` reject path traversal attempts; Windows reserved device names and control characters are rejected outright, keys are NFC-normalized.
- `move` refuses to overwrite an existing target.
- Writes use unique temp files, fsync and rename for atomicity; shared read-modify-write flows use a workspace-level cross-process lock.
- Memory updates support revision/hash conflict checks, and theme references preserve stable IDs and deleted/orphaned states.
- Dashboard APIs require a per-workspace bearer token, validate Host and Origin, bind to loopback, and are not auto-started unless explicitly enabled.
- The server does not open sensitive files such as `.env` or SSH private keys on its own; it reads the memory store, the Kimi Code session wires and the configuration files it owns.
- Conversation content is still processed. The session `wire.jsonl` (user text, assistant text, tool arguments and tool results) is parsed into turn summaries, so a secret that appears in a conversation can end up in the local summaries, the saved search views and the tool results. Treat the memory store as sensitive data.

## Observability & Operations

- **Metrics** (`src/utils/metrics.ts`): content-free counters, gauges and duration histograms for HTTP requests (active/errors/duration), MCP tool dispatch, lock waits/timeouts/stale reclaims, wire parsing, SQLite busy, index reconciles, quarantined files and dashboard ownership. Exposed via the authenticated `GET /api/metrics`.
- **Health**: `GET /api/health` reports `ok | degraded | rebuilding | corrupt` plus the current `indexState` (`empty | fresh | stale | rebuilding | corrupt`). The unauthenticated `/healthz` stays information-free by design.
- **Timeouts**: dashboard requests are bounded (read 10s, write 30s, `504` on overrun) so a hung handler cannot hold callers forever.
- **Cancellation**: MCP request abort signals propagate into `search_context`; a cancelled scan returns a partial result (`truncationReason: 'request-cancelled'`) and skips refinement side effects.
- **Background indexing** (`src/background/indexer.ts`): drains refined lag in bounded ticks with per-turn source hashes and extractor versions. Completed or rewritten turns are refreshed, orphaned rows are removed, and append-only batches resume at a complete-line byte offset only after the raw prefix hash matches the previous checkpoint; all other changes use a full stable snapshot. `refined_lag_turns` counts missing and stale turns, with asynchronous parsing when no valid checkpoint exists. Disable with `KIMI_MEMORY_BG_INDEX=0`.
- **Write journal** (`src/utils/workspace-journal.ts`): every multi-storage write (MCP tools and dashboard endpoints share the same `runJournaled` helper) records prepared/committed entries; startup, `sync_workspace_index` and `POST /api/sync` reconcile leftovers and report them.
- **Maintenance CLI** (`kimi-memory-setup`): `--doctor` (dry-run migration report), `--export-data <dir>`, `--backup-data --keep <n>`, `--prune-data --older-than <days>`, `--purge-derived-data`; all destructive commands run under the workspace lock and never touch the host-owned session wires. Exports mirror authoritative trees by removing stale destination entries, never follow source or destination links, and resolve real paths through existing ancestors to reject aliased source/destination overlap.
- **Essence lifecycle**: `organize_memories` (prepare token → store) and dashboard saves share the same contract — revision bump, history archive (`essence/history/`, last 10) and `rollback_essence` / `POST /api/essence/rollback` for recovery.
