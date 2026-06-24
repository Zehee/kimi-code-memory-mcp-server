---
key: 'essence'
title: 'Workspace Essence'
tags:
  - essence
  - workspace-memory
updatedAt: '2026-06-20T10:20:00.000Z'
---

# Workspace Essence: Sample Project

## Decisions

- Use SQLite for the cache layer to keep deployment simple.

## Knowledge

- Runtime: Node.js >= 18, MCP over stdio, Markdown + JSON index storage.

## Rules

- No plaintext secrets in memory.

## References

- MCP specification at https://modelcontextprotocol.io/.
