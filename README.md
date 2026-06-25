# Kimi Code Memory MCP Server

[中文](./README.zh-CN.md)

[![CI](https://github.com/Zehee/kimi-code-memory-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Zehee/kimi-code-memory-mcp-server/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A local stdio MCP server that gives [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) cross-session memory.

> **Note:** This package is not yet published to npm. Install and run it from source (see below).

All data is stored as plain Markdown files on disk. No vector database, no graph database, no external services.

> **Note for publishers:** Replace `Zehee` in badge URLs and `package.json` with your actual GitHub username or organization before publishing.

## Features

- **Markdown-first memories** — human-readable, git-friendly, LLM-compatible.
- **Structured long-term memory** — `memory/decisions/`, `memory/knowledge/`, `memory/rules/`, `memory/reference/`.
- **Workspace essence** — condensed digest (≤15 KB) generated from `memory/`.
- **Cross-session context recovery** — parses Kimi Code CLI's `wire.jsonl` directly.
- **Theme tracing** — associate conversation turns and memories with themes, then trace their evolution.
- **Refined turn summaries** — reusable turn-level atomic summaries shared across themes.
- **Rebuilding index** — `index.json` is a cache; `.md` files are the source of truth.

## Why Markdown?

Most agent memory systems default to vector databases. That works for fuzzy retrieval, but it also makes memories opaque, hard to audit, and hard to version-control.

This project starts from the opposite assumption:

> Memories should be **judged, structured, and owned by the user** before they are stored.

Markdown + YAML frontmatter gives you:

- Full readability and editability
- Native git diff support
- Zero external dependencies
- Compatibility with any LLM that can read text

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the design rationale.

## Install

Currently the package must be installed from source. Node.js ≥ 18 is required.

```bash
git clone https://github.com/Zehee/kimi-code-memory-mcp-server.git
cd kimi-code-memory-mcp-server
npm install
npm run build
```

## Configure Kimi Code CLI

Edit `~/.kimi-code/mcp.json` and point to the built server entry:

```json
{
  "mcpServers": {
    "kimi-memory": {
      "command": "node",
      "args": ["/absolute/path/to/kimi-code-memory-mcp-server/dist/server.js"],
      "enabled": true
    }
  }
}
```

The server name **`kimi-memory`** is important because the bundled `AGENTS.md` rules call tools as `mcp__kimi-memory__*` (for example `mcp__kimi-memory__bootstrap_workspace`).

Restart Kimi Code CLI to load the server.

## Optional: Install User-Level AGENTS.md Startup Hook

For automatic memory recovery and behavioral rules on every session start, copy the bundled `AGENTS.md` to your Kimi Code user directory:

```bash
cp AGENTS.md ~/.kimi-code/AGENTS.md
```

This installs a startup hook that tells Kimi Code CLI to call `bootstrap_workspace` at the beginning of every session, and to follow the memory classification and decision-guard rules. Because `AGENTS.md` is injected into **every** session, it is the right place for memory-related behavior protocols.

> **Note:** Keep `AGENTS.md` focused on memory-related conventions only. Do not include tool preferences that belong to other MCP servers.
>
> **Prerequisite:** The MCP server must be registered under the name `kimi-memory` in `~/.kimi-code/mcp.json`, otherwise the `mcp__kimi-memory__*` calls in `AGENTS.md` will fail.

## Optional: Install the Memory Skill

This repository also includes a lightweight Skill (`skills/memory-manage/SKILL.md`) that reminds Kimi Code CLI to call the memory tools when the user expresses a memory-related intent.

```bash
cp -r skills/memory-manage ~/.kimi-code/skills/memory-manage
```

The Skill does **not** enforce behavior on its own; it is a dispatcher. The actual protocols (when to remember, decision guard, etc.) live in `AGENTS.md`.

## Quick Start

After the server is loaded, the agent can call memory tools naturally:

```text
User: Let's use SQLite for the cache layer.
Agent: [calls remember] memory/decisions/use-sqlite-cache

User: Why did we choose SQLite?
Agent: [calls search] SQLite cache decision
       [calls recall] use-sqlite-cache
       → "We chose SQLite over Redis because..."

User: How has the cache design evolved?
Agent: [calls tag_theme] theme=cache-design
       [calls trace_theme] cache-design
       → shows related turns and decisions across sessions
```

## Storage Layout

The server stores data under `~/.kimi-code-memory/<workspace-id>/`:

```text
~/.kimi-code-memory/workspace-a1b2c3d4/
├── index.json              # v3-kv metadata cache (rebuildable)
├── memory/
│   ├── decisions/          # architecture and product decisions
│   ├── knowledge/          # project-specific knowledge
│   ├── rules/              # conventions and guardrails
│   └── reference/          # external references
├── essence/
│   └── essence.md          # workspace digest (≤15 KB)
├── notes/                  # scratch notes
├── themes/
│   └── my-theme.json       # theme -> turn/memory refs
└── refined/
    └── refined.sqlite      # turn-level summaries
```

You can override the storage root with the `MEMORY_STORE_ROOT` environment variable.

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `MEMORY_STORE_ROOT` | Override the default `~/.kimi-code-memory` storage root. |
| `MEMORY_SESSIONS_ROOT` | Override the default `~/.kimi-code/sessions` path used to discover `wire.jsonl` files. |
| `KIMI_CODE_HOME` | Alternative to `MEMORY_SESSIONS_ROOT`; sessions are read from `<KIMI_CODE_HOME>/sessions`. |

## Tools

| Tool | Purpose |
|------|---------|
| `remember` | Write a Markdown memory |
| `recall` | Read a memory by key |
| `recall_recent` | List recently updated memories |
| `search` | Keyword search across memories |
| `list` | List memories |
| `list_tags` | List all tags |
| `delete` | Delete a memory |
| `move` | Move or rename a memory |
| `organize_memories` | Distill `memory/` into `essence/essence.md` |
| `sync_workspace_index` | Rebuild `index.json` from disk |
| `bootstrap_workspace` | Load context, essence, and memory tree |
| `load_workspace_context` | Load recent conversation context |
| `load_more_context` | Load older conversation rounds |
| `search_context` | Search across all session wires |
| `load_turn_context` | Load specific turn details |
| `tag_theme` | Associate a turn or memory with a theme |
| `trace_theme` | Trace a theme's evolution |
| `list_themes` | List themes |
| `refine_session_turns` | Generate refined turn summaries |

## Development

```bash
git clone https://github.com/Zehee/kimi-code-memory-mcp-server.git
cd kimi-code-memory-mcp-server
npm install
npm test
npm run lint
```

See [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) for contribution guidelines.

## Project Structure

```text
src/
├── server.ts              # MCP server entry
├── config.ts              # defaults and paths
├── theme-manager.ts       # theme storage
├── refined-manager.ts     # refined turn storage
├── dao/
│   ├── index.ts           # index.json DAO (v3-kv)
│   └── memory-store.ts    # Markdown file operations
├── context/
│   └── wire-context.ts    # wire.jsonl parsing
├── tools/
│   ├── index.ts           # tool schemas & dispatch
│   ├── memory-tools.ts    # memory CRUD
│   ├── context-tools.ts   # context recovery
│   ├── theme-tools.ts     # theme tracing
│   └── system-tools.ts    # organize/sync/bootstrap
└── utils/
    ├── frontmatter.ts
    ├── paths.ts
    └── validation.ts
```

## Roadmap

- [x] Modular source structure
- [x] ESLint + Prettier
- [x] Basic integration tests
- [ ] Full test coverage for context/theme tools
- [ ] Optional local embedding search
- [ ] Optional LLM-based turn refinement
- [ ] Pluggable wire format adapters
- [ ] Memory usage benchmarks

## Related Documents

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — system design and data flow
- [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) — how to contribute
- [`docs/third-party-evaluation.md`](./docs/third-party-evaluation.md) — original design evaluation

## License

MIT
