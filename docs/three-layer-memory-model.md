> **Note:** This document is adapted from a discussion on agent memory architecture between Zehee and K2.7 Code thinking.

# Three-Layer Memory Model

## TL;DR

`kimi-code-memory-mcp-server` uses a lightweight, file-system-based memory architecture:

- **Continuous cognition layer** — `AGENTS.md` / `essence.md`: rules, identity, and core constraints carried into every session.
- **Persistent knowledge layer** — `memory/`: structured Markdown notes for decisions, knowledge, rules, and references.
- **Context retention & recall layer** — `wire.jsonl` parsed on demand, with a `refined/` SQLite cache and `themes/` for cross-session tracing.

No vector database or graph database is required.

---

## 1. What is Worth Remembering?

Not everything deserves persistence. We keep only three kinds of information:

1. **Continuous cognition** — who the agent is, what rules it follows, core project constraints.
2. **Persistent knowledge** — decisions, patterns, conventions, and reference material worth revisiting.
3. **Context & recall** — recent conversation state and cross-session theme associations.

Everything else stays in `wire.jsonl` as an audit trace or is discarded.

---

## 2. Layer One: Continuous Cognition

File: `essence/essence.md` (and optionally user-level `~/.kimi-code/AGENTS.md`)

This layer is small, hot-reloadable, and always present. It contains:

- Identity and role expectations
- Hard rules (e.g., "no git mutations without explicit user approval")
- Language and style preferences
- Project-wide conventions

In this MCP server, `essence.md` is constrained to **≤15 KB**. If it grows beyond that, `organize_memories` refuses to write until the user condenses it. The file is loaded at session start via `bootstrap_workspace`.

---

## 3. Layer Two: Persistent Knowledge

Directory: `memory/`

Structured Markdown files, categorized by purpose:

| Folder | Purpose | Tag |
|---|---|---|
| `memory/decisions/` | Architecture and product decisions | `decision` |
| `memory/knowledge/` | Project-specific technical knowledge | `knowledge` |
| `memory/rules/` | Conventions, guardrails, and red lines | `rule` |
| `memory/reference/` | External links and documentation references | `reference` |

Each file has YAML frontmatter:

```yaml
---
key: agent-memory-three-layer-model
folder: memory
tags: [knowledge, memory, architecture]
---
```

A lightweight `index.json` v3-kv cache records file paths, titles, and tags. The cache is rebuildable from disk via `sync_workspace_index`; the Markdown files are the source of truth.

---

## 4. Layer Three: Context Retention & Theme Tracing

Source: Kimi Code CLI's `wire.jsonl`
Cache: `refined/refined.sqlite`
Associations: `themes/<theme>.json`

### 4.1 Why not use raw `wire.jsonl`?

Raw wire streams contain a lot of noise: streaming fragments, "Thinking..." traces, repeated tool headers. Searching and clustering them directly produces poor results.

### 4.2 Refined turns

When the user triggers theme tracing, `search_context` finds candidate turns across all workspace sessions. `refine_session_turns` then compresses them into structured records:

```json
{
  "sessionId": "sess-a",
  "turnId": 42,
  "summary": "Fixed port occupation issue when MCP server starts",
  "facts": [
    "Modified listen() logic in src/mcp/server.ts",
    "Added port fallback mechanism (3000 -> 3001)"
  ],
  "entities": {
    "files": ["src/mcp/server.ts"],
    "tools": ["edit_file", "bash"],
    "errors": []
  }
}
```

These refined turns are stored in `refined/refined.sqlite` and reused on later queries.

### 4.3 Themes as views, not containers

A theme file only holds pointers to turns and memories:

```json
{
  "theme": "memory-mcp-evolution",
  "turns": [
    {"sessionId": "sess-a", "turnId": 12},
    {"sessionId": "sess-b", "turnId": 3}
  ],
  "memories": [
    {"key": "agent-memory-three-layer-model", "folder": "memory"}
  ]
}
```

A single refined turn can be referenced by multiple themes. This avoids duplicating content and keeps the storage model simple.

---

## 5. Tools by Layer

| Layer | Tools |
|---|---|
| Continuous cognition | `bootstrap_workspace`, `organize_memories` |
| Persistent knowledge | `remember`, `recall`, `search`, `list`, `move`, `delete`, `sync_workspace_index` |
| Context & themes | `load_workspace_context`, `load_more_context`, `search_context`, `refine_session_turns`, `load_turn_context`, `tag_theme`, `trace_theme`, `list_themes` |

---

## 6. Why No Vector or Graph Database?

For coding agents, the hard problem is usually **curation**, not **retrieval scale**. A well-structured Markdown library with path/tag/keyword search covers most needs:

- Path search: `memory/decisions/*`
- Tag filter: `tag = architecture`
- Keyword search: `search` and `search_context`
- Theme traversal: `trace_theme`

These are fast, deterministic, and explainable. If vector retrieval is ever needed, it can be added as an optional plugin, not the default.

---

## 7. References

- CoALA: A Cognitive Architecture for Language Agents (Princeton, 2023)
- Mem0: Chhikara et al., 2025
- Zep / Graphiti: Rasmussen et al., 2025
- Claude Code Auto-Memory / CLAUDE.md: datastudios.org, 2026
