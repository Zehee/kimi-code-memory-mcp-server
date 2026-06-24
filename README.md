# Kimi Code Memory MCP Server

[中文](./README.zh-CN.md)

[![CI](https://github.com/Zehee/kimi-code-memory-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Zehee/kimi-code-memory-mcp-server/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/kimi-code-memory-mcp-server)](https://www.npmjs.com/package/kimi-code-memory-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A local stdio MCP server that gives [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) cross-session memory.

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

```bash
npm install -g kimi-code-memory-mcp-server
```

Or run directly with npx:

```bash
npx kimi-code-memory-mcp-server
```

## Configure Kimi Code CLI

Edit `~/.kimi-code/mcp.json`:

```json
{
  "mcpServers": {
    "memory": {
      "command": "npx",
      "args": ["kimi-code-memory-mcp-server"],
      "enabled": true
    }
  }
}
```

Restart Kimi Code CLI to load the server.

## Optional: Install User-Level AGENTS.md Startup Hook

For automatic memory recovery and behavioral rules on every session start, copy the bundled `AGENTS.md` to your Kimi Code user directory:

```bash
cp AGENTS.md ~/.kimi-code/AGENTS.md
```

This installs a startup hook that tells Kimi Code CLI to call `bootstrap_workspace` at the beginning of every session, and to follow the memory classification and decision-guard rules. Because `AGENTS.md` is injected into **every** session, it is the right place for memory-related behavior protocols.

> **Note:** Keep `AGENTS.md` focused on memory-related conventions only. Do not include tool preferences that belong to other MCP servers.

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
    └── <sessionId>.jsonl   # turn-level summaries
```

You can override the storage root with the `MEMORY_STORE_ROOT` environment variable.

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
├── server.js              # MCP server entry
├── config.js              # defaults and paths
├── theme-manager.js       # theme storage
├── refined-manager.js     # refined turn storage
├── dao/
│   ├── index.js           # index.json DAO (v3-kv)
│   └── memory-store.js    # Markdown file operations
├── context/
│   └── wire-context.js    # wire.jsonl parsing
├── tools/
│   ├── index.js           # tool schemas & dispatch
│   ├── memory-tools.js    # memory CRUD
│   ├── context-tools.js   # context recovery
│   ├── theme-tools.js     # theme tracing
│   └── system-tools.js    # organize/sync/bootstrap
└── utils/
    ├── frontmatter.js
    ├── paths.js
    └── validation.js
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
