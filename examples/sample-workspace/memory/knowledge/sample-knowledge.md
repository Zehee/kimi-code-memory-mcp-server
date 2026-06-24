---
key: 'project-tech-stack'
title: 'Project Tech Stack'
tags:
  - knowledge
  - stack
  - architecture
createdAt: '2026-06-20T10:05:00.000Z'
updatedAt: '2026-06-20T10:05:00.000Z'
---

# Project Tech Stack

- **Runtime**: Node.js >= 18
- **Protocol**: Model Context Protocol (MCP) over stdio
- **Storage**: Markdown files + rebuildable JSON index
- **Linting**: ESLint + Prettier
- **Testing**: Node.js built-in `assert` + `@modelcontextprotocol/sdk` client

## Notes

The server intentionally avoids external databases by default. Optional embedding or vector plugins may be added later as extensions.

> 来源：memory/knowledge/project-tech-stack
