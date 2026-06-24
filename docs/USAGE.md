# Usage Guide

This guide shows how to use the tools provided by Kimi Code Memory MCP Server in typical workflows.

## Tool Categories

| Category | Tools |
|----------|-------|
| Memory CRUD | `remember`, `recall`, `recall_recent`, `search`, `list`, `list_tags`, `delete`, `move` |
| Context recovery | `bootstrap_workspace`, `load_workspace_context`, `load_more_context`, `search_context`, `load_turn_context` |
| Theme tracing | `tag_theme`, `trace_theme`, `list_themes`, `refine_session_turns` |
| System | `organize_memories`, `sync_workspace_index`, `get_current_workspace` |

## Writing a Memory

Use `remember` to persist a decision, knowledge item, or rule.

```json
{
  "name": "remember",
  "arguments": {
    "key": "use-sqlite-for-cache",
    "folder": "memory/decisions",
    "tags": ["decision", "database", "cache"],
    "content": "# Use SQLite for Cache Layer\n\nWe chose SQLite over Redis because:\n- Single-file deployment\n- No additional service to run\n- Good enough for our read-heavy cache workload"
  }
}
```

Result:

```json
{
  "success": true,
  "filePath": ".../memory/decisions/use-sqlite-for-cache.md",
  "folder": "memory/decisions",
  "key": "use-sqlite-for-cache"
}
```

## Recalling a Memory

```json
{
  "name": "recall",
  "arguments": {
    "key": "use-sqlite-for-cache",
    "folder": "memory/decisions"
  }
}
```

Result:

```json
{
  "found": true,
  "key": "use-sqlite-for-cache",
  "folder": "memory/decisions",
  "content": "...",
  "tags": ["decision", "database", "cache"],
  "createdAt": "...",
  "updatedAt": "..."
}
```

## Searching Memories

```json
{
  "name": "search",
  "arguments": {
    "query": "SQLite cache",
    "folder": "memory"
  }
}
```

Result is a ranked list of matching memories.

## Bootstrapping Context

When a new session starts, call `bootstrap_workspace` to load:

- Recent conversation context from `wire.jsonl`
- `essence/essence.md`
- The memory index tree

```json
{
  "name": "bootstrap_workspace",
  "arguments": {}
}
```

Result:

```json
{
  "workspace": { "cwd": "...", "workspaceId": "...", "storePath": "..." },
  "recentContext": { ... },
  "essence": { "found": true, "content": "..." },
  "memoryIndexTree": "memory/...",
  "notesRefs": []
}
```

## Searching Conversation History

```json
{
  "name": "search_context",
  "arguments": {
    "query": "SQLite cache decision",
    "limit": 5
  }
}
```

Returns matching conversation turns across sessions.

## Loading Specific Turns

```json
{
  "name": "load_turn_context",
  "arguments": {
    "references": [
      { "sessionId": "session_abc123", "turnId": 5 }
    ]
  }
}
```

## Theme Tracing

Themes connect memories and conversation turns across sessions.

### Tag a memory with a theme

```json
{
  "name": "tag_theme",
  "arguments": {
    "theme": "cache-design",
    "memoryKey": "use-sqlite-for-cache",
    "memoryFolder": "memory/decisions"
  }
}
```

### Tag a conversation turn with a theme

```json
{
  "name": "tag_theme",
  "arguments": {
    "theme": "cache-design",
    "sessionId": "session_abc123",
    "turnId": 5
  }
}
```

### Trace a theme

```json
{
  "name": "trace_theme",
  "arguments": {
    "theme": "cache-design",
    "includeTurnContent": true
  }
}
```

Result is a timeline of memories and turns associated with the theme.

## Generating Refined Turn Summaries

```json
{
  "name": "refine_session_turns",
  "arguments": {
    "sessionId": "session_abc123"
  }
}
```

This creates atomic summaries in `refined/<sessionId>.jsonl`, which can then be linked to themes.

## Organizing Memories

`organize_memories` has a two-stage design.

### Stage 1: Prepare

```json
{
  "name": "organize_memories",
  "arguments": {}
}
```

Returns a prompt-ready summary of `memory/` for the LLM to distill.

### Stage 2: Store

```json
{
  "name": "organize_memories",
  "arguments": {
    "content": "# Workspace Essence\n\n## Decisions\n- Use SQLite for cache...\n\n## Rules\n- ..."
  }
}
```

Stores the result as `essence/essence.md` if it is ≤15 KB.

## Rebuilding the Index

If you edit Markdown files outside the MCP tools, rebuild the index:

```json
{
  "name": "sync_workspace_index",
  "arguments": {}
}
```

## Typical Workflow

1. **Start of session** — `bootstrap_workspace` to load context and essence.
2. **During work** — `remember` decisions and knowledge as they arise.
3. **Before a big decision** — `search` and `recall` related memories.
4. **End of session** — `organize_memories` to update the workspace essence.
5. **Long-term tracking** — `tag_theme` and `trace_theme` for cross-session narratives.

## Companion Skill

For automatic, protocol-driven use of these tools, install the companion Skill from `skills/memory-manage/SKILL.md`:

```bash
cp -r skills/memory-manage ~/.kimi-code/skills/memory-manage
```

The Skill encodes when to remember, when to search, and how to trace themes, so you do not have to prompt the agent manually.

## Memory Content Format

When writing memories with `remember`, follow these conventions for consistency.

### Decisions

- Decision content
- Decision rationale
- Impact scope
- Related files

### Rules

- Rule content
- Scope of application
- Consequence of violation

### Knowledge

- Knowledge point
- Applicable scenarios
- Related files or interfaces

### References

- URL or identifier
- Why it is relevant
- When it was last verified
