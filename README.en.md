# Kimi Code Memory MCP Server

[中文](./README.md)

[![CI](https://github.com/Zehee/kimi-code-memory-mcp-server/actions/workflows/ci.yml/badge.svg)](https://github.com/Zehee/kimi-code-memory-mcp-server/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/kimi-code-memory-mcp-server.svg?color=brightgreen)](https://www.npmjs.com/package/kimi-code-memory-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A local stdio MCP server that gives [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) cross-session memory.

> **Note:** This package is published to npm as `kimi-code-memory-mcp-server`. You can install it directly or run it from source.

## Features

- **Markdown-first memories** — human-readable, git-friendly, LLM-compatible.
- **Structured long-term memory** — `memory/decisions/`, `memory/knowledge/`, `memory/rules/`, `memory/reference/`.
- **Workspace essence** — condensed digest (≤15 KB) generated from `memory/`.
- **Cross-session context recovery** — parses Kimi Code CLI's `wire.jsonl` directly.
- **Theme tracing** — associate conversation turns and memories with themes, then trace their evolution.
- **Refined turn summaries** — reusable turn-level atomic summaries shared across themes.
- **Rebuilding index** — `index.json` is a cache; `.md` files are the source of truth.
- **Theme & search-view deletion** — remove low-quality themes or saved search views, optionally purging their refined turns.
- **Dashboard enhancements** — dynamic workspace title, read-only Markdown viewer with lightweight rendering, delete actions.

## Theme Tracing

Traditional context management only focuses on the **vertical** dimension: the closer in time, the clearer; the further away, the more it decays. But this misses a core feature of real work:

> **Multiple sessions in the same workspace are often not a single narrative, but several intertwined theme lines running in parallel.**

For example:

- Session A: developing auth authentication
- Session B: discussing orders table migration
- Session C: encryption RSA + decryption BCrypt + CAPTCHA + Cookie
- Session D: fix SQL error bug
- Session E: login Login API design

If you only look vertically, these sessions appear independent. But if you scan horizontally, you'll find that A, C, and E all belong to the "registration/login" theme.

**Theme tracing** is: treat each turn on the timeline as a cylinder, where the height represents the turn's computation/thinking depth, and the color/tag represents the theme. We can even mine from Kimi Code's already compressed and archived context, perform deep horizontal scanning, find cylinders (turns) of the same color, re-establish their associations, form a theme, and store it in memory. Three weeks later, when you're about to upgrade your "registration/login" module or fix a bug, you don't have to re-explain the original design rationale to an agent whose context has been compressed countless times. Instead, your agent can say: "I just traced the 'registration/login' theme. Based on the design decision from three weeks ago and the two adjustments made since then, we should use solution B for the current problem."

> The diagram below shows how `kimi-memory` views conversation history: vertical bars are turns on the timeline, thick horizontal lines are clusters, gray boxes are sessions, and colored brackets connect related turns/clusters across sessions into theme lines.

![Turns, clusters, sessions, and theme tracing over time](./assets/contextFlow.svg)

The animated clip below is a real Kimi Code CLI session using `kimi-memory`. The user asks for two cross-session summaries — first the evolution history of the MCP memory server itself, then the evolution history of the E2E testing tools. The agent retrieves related memories and conversation turns, then synthesizes structured answers.

![Kimi Memory MCP Server demo](https://github.com/user-attachments/assets/a8947676-1487-47ed-8e0c-8d15f8662618)

Tools: `tag_theme`, `trace_theme`, `list_themes`, `search_context`, `refine_session_turns`, `load_turn_context`.

## Why Markdown?

Most agent memory systems default to vector databases. That works for fuzzy retrieval, but it also makes memories opaque, hard to audit, and hard to version-control.

This project starts from the opposite assumption:

> Memories should be **judged, structured, and owned by the user** before they are stored.

Markdown + YAML frontmatter gives you:

- Full readability and editability
- Native git diff support
- No required external database or cloud service
- Compatibility with any LLM that can read text

See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the design rationale.

## Install

Node.js ≥ 18 is required.

### From npm (recommended)

```bash
npm install -g kimi-code-memory-mcp-server
```

### From source

```bash
git clone https://github.com/Zehee/kimi-code-memory-mcp-server.git
cd kimi-code-memory-mcp-server
npm install
npm run build
```

## Quick Setup (recommended)

After installing from npm, run the setup command to configure Kimi Code CLI automatically:

```bash
npx kimi-memory-setup
```

This will:

1. Detect your `~/.kimi-code` directory.
2. Inject memory protocol rules at the top of `~/.kimi-code/AGENTS.md`.
3. Install the `memory-manage` skill to `~/.kimi-code/skills/memory-manage`.
4. Add the `kimi-memory` MCP server entry to `~/.kimi-code/mcp.json`.

Preview changes without writing anything:

```bash
npx kimi-memory-setup --dry-run
```

Remove the injected configuration later:

```bash
npx kimi-memory-setup --undo
```

## Configure Kimi Code CLI (manual)

If you prefer to configure manually, edit `~/.kimi-code/mcp.json` and add the server.

If you installed from npm with `-g`, use the absolute path to `dist/server.js` inside your global `node_modules`:

```json
{
  "mcpServers": {
    "kimi-memory": {
      "command": "node",
      "args": ["/absolute/path/to/global/node_modules/kimi-code-memory-mcp-server/dist/server.js"],
      "enabled": true
    }
  }
}
```

Or run it directly via `npx` (no install required):

```json
{
  "mcpServers": {
    "kimi-memory": {
      "command": "npx",
      "args": ["-y", "kimi-code-memory-mcp-server"],
      "enabled": true
    }
  }
}
```

If you built from source, point to your local `dist/server.js`:

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

After the server is loaded, the agent can call memory tools naturally (tool names are prefixed with the MCP server name you configured, e.g. `mcp__kimi-memory__*`):

```text
User: Let's use SQLite for the cache layer.
Agent: [calls mcp__kimi-memory__remember] key=use-sqlite-cache, folder=memory/decisions

User: Why did we choose SQLite?
Agent: [calls mcp__kimi-memory__search] query=SQLite cache decision
       [calls mcp__kimi-memory__recall] key=use-sqlite-cache, folder=memory/decisions
       → "We chose SQLite over Redis because..."

User: How has the cache design evolved?
Agent: [calls mcp__kimi-memory__tag_theme] theme=cache-design
       [calls mcp__kimi-memory__trace_theme] theme=cache-design
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
| `KIMI_MEMORY_AUTO_VIS` | Whether to auto-start the dashboard when the MCP server starts. Defaults to `1`/`true`; set to `0`/`false` to disable. |
| `KIMI_MEMORY_VIS_PORT` | Starting port for the dashboard. Defaults to `58628`; falls back through the next 10 ports if occupied. |
| `KIMI_MEMORY_VIS_HOST` | Host for the dashboard to bind to. Defaults to `127.0.0.1`. |

## Tools

| Tool | Purpose |
|------|---------|
| `remember` | Write a Markdown memory |
| `recall` | Read a memory by key |
| `search` | Keyword search across memories |
| `list` | List memories, with optional folder / tag filter and limit |
| `list_tags` | List all tags |
| `delete` | Delete a memory |
| `move` | Move or rename a memory |
| `organize_memories` | Distill `memory/` into `essence/essence.md` |
| `sync_workspace_index` | Rebuild `index.json` from disk |
| `bootstrap_workspace` | Load context, essence, and memory tree |
| `load_more_context` | Load older conversation rounds |
| `search_context` | Search across all session wires |
| `load_turn_context` | Load specific turn details |
| `tag_theme` | Associate a turn or memory with a theme |
| `trace_theme` | Trace a theme's evolution |
| `list_themes` | List themes |
| `delete_theme` | Delete a theme association file |
| `list_search_views` | List saved search views |
| `delete_search_view` | Delete a saved search view (optionally purge referenced refined turns) |
| `open_memory_dashboard` | Open the memory dashboard in the browser |
| `refine_session_turns` | Generate refined turn summaries |

## Dashboard

A standalone web dashboard is available to visualize workspace memory, theme timelines, and recent decisions.

### Starting the dashboard

1. **Auto-start with the MCP server (default)**

   `kimi-code-memory-mcp-server` starts the dashboard in the background and tries to open your browser. Default URL:

   ```text
   http://127.0.0.1:58628
   ```

   If the port is in use, it tries `58629`–`58637` automatically.

   To disable auto-start:

   ```bash
   export KIMI_MEMORY_AUTO_VIS=0
   ```

2. **Start manually**

   After installing the package:

   ```bash
   npx kimi-memory-vis
   ```

   From source:

   ```bash
   npx tsx src/vis-cli.ts
   ```

   Common options:

   ```bash
   npx kimi-memory-vis --port 8080        # use a custom port
   npx kimi-memory-vis --no-open          # do not open the browser
   npx kimi-memory-vis --workspace /path  # view another workspace
   ```

3. **Open on demand from a conversation**

   Ask the Agent to call:

   ```text
   mcp__kimi-memory__open_memory_dashboard
   ```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `KIMI_MEMORY_AUTO_VIS` | Whether to auto-start the dashboard when the MCP server starts. Defaults to `1`/`true`; set to `0`/`false` to disable. |
| `KIMI_MEMORY_VIS_PORT` | Starting port for the dashboard. Defaults to `58628`. |
| `KIMI_MEMORY_VIS_HOST` | Host for the dashboard to bind to. Defaults to `127.0.0.1`. |

### Dashboard features

- Workspace overview and `essence.md` viewing/editing (read-only by default; click **Edit** to modify)
- Lightweight Markdown rendering with scrollable previews
- Theme timeline browsing and theme deletion
- Search-view list with optional cascading cleanup of refined turns
- Recent decisions list
- Explicit memory folder browsing
- Dynamic page title using the workspace folder name

## Development

```bash
git clone https://github.com/Zehee/kimi-code-memory-mcp-server.git
cd kimi-code-memory-mcp-server
npm install
npm run build
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
- [x] Core test coverage for context/theme tools
- [ ] Optional local embedding search
- [ ] Optional LLM-based turn refinement
- [ ] Pluggable wire format adapters
- [ ] Memory usage benchmarks

## Related Documents

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — system design and data flow
- [`docs/three-layer-memory-model.md`](./docs/three-layer-memory-model.md) — the theoretical memory model behind this server
- [`docs/search-logic.md`](./docs/search-logic.md) — how `search` and `search_context` work
- [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md) — how to contribute

## License

MIT
