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

| File | Responsibility |
|------|----------------|
| `src/server.ts` | MCP server entry, registers tools, starts stdio transport. |
| `src/config.ts` | Default paths, environment variable handling (`MEMORY_STORE_ROOT`, `MEMORY_SESSIONS_ROOT`, `KIMI_CODE_HOME`). |
| `src/tools/index.ts` | Tool schemas, validation, and dispatch. |
| `src/tools/memory-tools.ts` | `remember`, `recall`, `search`, `list`, `list_tags`, `delete`, `move`. |
| `src/tools/context-tools.ts` | `load_workspace_context`, `load_more_context`, `search_context`, `load_turn_context`. |
| `src/tools/theme-tools.ts` | `tag_theme`, `trace_theme`, `list_themes`, `refine_session_turns`. |
| `src/tools/system-tools.ts` | `organize_memories`, `sync_workspace_index`, `bootstrap_workspace`, `get_current_workspace`. |
| `src/dao/index.ts` | `index.json` v3-kv DAO with structure-hash consistency check. |
| `src/dao/memory-store.ts` | Markdown file read/write and frontmatter handling. |
| `src/context/wire-context.ts` | Parses Kimi Code CLI `wire.jsonl` into conversation rounds. |
| `src/theme-manager.ts` | Reads/writes `themes/<theme>.json`. |
| `src/refined-manager.ts` | Stores refined turn summaries in `refined/refined.sqlite`. |
| `src/utils/frontmatter.ts` | YAML frontmatter parser and serializer. |
| `src/utils/paths.ts` | Path helpers and storage root resolution. |
| `src/utils/validation.ts` | Input sanitization (`sanitizeKey`, `sanitizeFolder`). |

## `index.json` v3-kv

`index.json` is a fast cache over the Markdown files on disk.

```json
{
  "version": "v3-kv",
  "meta": {
    "structureHash": "sha256-of-directory-tree",
    "updatedAt": "2026-06-24T12:00:00.000Z"
  },
  "index": {
    "memory/decisions/choose-sqlite.md": {
      "key": "choose-sqlite",
      "folder": "memory/decisions",
      "title": "Choose Sqlite",
      "tags": ["decision", "database"],
      "createdAt": "...",
      "updatedAt": "..."
    }
  },
  "folderComments": {
    "memory/decisions": "Architecture and product decisions"
  }
}
```

- `structureHash` is computed from the file tree.
- If the hash changes (e.g., external edit), the index is rebuilt on next access.
- The DAO also supports migration from older index formats.

## Memory Lifecycle

1. **Capture** — Agent writes a memory via `remember`.
2. **Index** — `IndexDao` updates `index.json` and writes the `.md` file.
3. **Recall** — Agent uses `search`, `recall`, or `list` to retrieve memories.
4. **Distill** — `organize_memories` condenses `memory/` into `essence/essence.md` (≤15 KB).
5. **Trace** — `tag_theme` and `trace_theme` connect memories and conversation turns into evolving themes.
6. **Archive/Move** — `move` renames or relocates a memory; `delete` removes it.

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

- `sanitizeKey` and `sanitizeFolder` reject path traversal attempts.
- `move` refuses to overwrite an existing target.
- Writes use temp-file + rename for atomicity.
- Sensitive files (`.env`, SSH keys, etc.) are never read by the server.
