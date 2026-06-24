# Examples

This directory contains a sample workspace that demonstrates the storage layout and content conventions used by Kimi Code Memory MCP Server.

## sample-workspace/

```text
sample-workspace/
├── index.json              # v3-kv index cache
├── essence/
│   └── essence.md          # workspace digest
├── memory/
│   ├── decisions/          # architecture and product decisions
│   ├── knowledge/          # project-specific knowledge
│   ├── rules/              # conventions and guardrails
│   └── reference/          # external references
├── notes/                  # scratch notes
└── themes/                 # theme associations
```

## How to Use

1. Copy `sample-workspace/` to your own location.
2. Set `MEMORY_STORE_ROOT` to the parent directory of `sample-workspace/`.
3. Or rename `sample-workspace/` to match your workspace ID and place it under `~/.kimi-code-memory/`.

## Files

- `memory/decisions/choose-sqlite-cache.md` — example decision record
- `memory/knowledge/project-tech-stack.md` — example knowledge record
- `memory/rules/no-plaintext-secrets.md` — example rule
- `memory/reference/mcp-spec.md` — example external reference
- `essence/essence.md` — example workspace digest
- `themes/cache-design.json` — example theme association
