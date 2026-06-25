> **说明：** 本文档由 Zehee 与 K2.7 Code thinking 关于 Agent 记忆架构的讨论整理而来。

# 三层记忆模型

## TL;DR

`kimi-code-memory-mcp-server` 采用轻量的、基于文件系统的记忆架构：

- **持续认知层** —— `AGENTS.md` / `essence.md`：每个会话都会携带的规则、身份与核心约束。
- **持久化知识层** —— `memory/`：结构化的 Markdown 笔记，记录决策、知识、规则与参考。
- **上下文保持与追溯层** —— 按需解析 `wire.jsonl`，通过 `refined/` SQLite 缓存与 `themes/` 实现跨会话主题追溯。

无需向量数据库或图数据库。

---

## 1. 什么值得被记住？

并非所有信息都值得持久化。我们只保留三类：

1. **持续认知**：Agent 是谁、遵循什么规则、核心项目约束。
2. **持久化知识**：值得反复查阅的决策、模式、约定与参考资料。
3. **上下文与追溯**：近期对话状态与跨会话主题关联。

其余内容留在 `wire.jsonl` 作为审计痕迹，或直接丢弃。

---

## 2. 第一层：持续认知

文件：`essence/essence.md`（以及可选的用户级 `~/.kimi-code/AGENTS.md`）

这一层体积小、支持热加载、始终在场，包含：

- 身份与角色期望
- 硬性规则（例如"未经用户明确授权不得进行 git 突变"）
- 语言与风格偏好
- 项目级约定

在本 MCP server 中，`essence.md` 被限制为 **≤15 KB**。超出时 `organize_memories` 会拒绝写入，强制用户精简。该文件通过 `bootstrap_workspace` 在会话启动时加载。

---

## 3. 第二层：持久化知识

目录：`memory/`

按用途分类的结构化 Markdown 文件：

| 目录 | 用途 | 标签 |
|---|---|---|
| `memory/decisions/` | 架构与产品决策 | `decision` |
| `memory/knowledge/` | 项目专属技术知识 | `knowledge` |
| `memory/rules/` | 约定、红线与行为规范 | `rule` |
| `memory/reference/` | 外部链接与文档引用 | `reference` |

每个文件都有 YAML frontmatter：

```yaml
---
key: agent-memory-three-layer-model
folder: memory
tags: [knowledge, memory, architecture]
---
```

轻量的 `index.json` v3-kv 缓存记录文件路径、标题与标签。该缓存可通过 `sync_workspace_index` 从磁盘重建；Markdown 文件才是真相来源。

---

## 4. 第三层：上下文保持与主题追溯

来源：Kimi Code CLI 的 `wire.jsonl`
缓存：`refined/refined.sqlite`
关联：`themes/<theme>.json`

### 4.1 为什么不直接用原始 `wire.jsonl`？

原始 wire 流包含大量噪声：流式输出碎片、"Thinking..." 痕迹、重复的 tool 头部。直接搜索和聚类效果很差。

### 4.2 精炼轮次

当用户触发主题追溯时，`search_context` 先跨所有工作区会话找到候选 turns。然后 `refine_session_turns` 将其压缩为结构化记录：

```json
{
  "sessionId": "sess-a",
  "turnId": 42,
  "summary": "修复了 MCP 服务器启动时的端口占用问题",
  "facts": [
    "修改了 src/mcp/server.ts 的 listen() 逻辑",
    "增加了端口回退机制 (3000 -> 3001)"
  ],
  "entities": {
    "files": ["src/mcp/server.ts"],
    "tools": ["edit_file", "bash"],
    "errors": []
  }
}
```

精炼后的 turns 存入 `refined/refined.sqlite`，后续查询直接复用。

### 4.3 主题是视图，不是容器

主题文件只保存指向 turns 和记忆的指针：

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

一个精炼 turn 可被多个主题引用，避免内容重复，保持存储模型简单。

---

## 5. 按层划分的工具

| 层 | 工具 |
|---|---|
| 持续认知 | `bootstrap_workspace`, `organize_memories` |
| 持久化知识 | `remember`, `recall`, `search`, `list`, `move`, `delete`, `sync_workspace_index` |
| 上下文与主题 | `load_workspace_context`, `load_more_context`, `search_context`, `refine_session_turns`, `load_turn_context`, `tag_theme`, `trace_theme`, `list_themes` |

---

## 6. 为什么不用向量或图数据库？

对 coding agent 来说，困难的问题通常是**整理**而非**检索规模**。结构良好的 Markdown 库配合路径/标签/关键词搜索足以覆盖大多数场景：

- 路径搜索：`memory/decisions/*`
- 标签过滤：`tag = architecture`
- 关键词搜索：`search` 与 `search_context`
- 主题遍历：`trace_theme`

这些方法快速、确定、可解释。如果未来确实需要向量检索，可以作为可选插件加入，而不是默认路径。

---

## 7. 参考

- CoALA: A Cognitive Architecture for Language Agents (Princeton, 2023)
- Mem0: Chhikara et al., 2025
- Zep / Graphiti: Rasmussen et al., 2025
- Claude Code Auto-Memory / CLAUDE.md: datastudios.org, 2026
