# 使用指南

本文档展示 Kimi Code Memory MCP Server 典型工作流中的工具用法。

## 工具分类

| 分类 | 工具 |
|------|------|
| 记忆增删改查 | `remember`、`recall`、`recall_recent`、`search`、`list`、`list_tags`、`delete`、`move` |
| 上下文恢复 | `bootstrap_workspace`、`load_workspace_context`、`load_more_context`、`search_context`、`load_turn_context` |
| 主题追溯 | `tag_theme`、`trace_theme`、`list_themes`、`refine_session_turns` |
| 系统 | `organize_memories`、`sync_workspace_index`、`get_current_workspace` |

## 写入记忆

使用 `remember` 持久化决策、知识点或规则。

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

返回：

```json
{
  "success": true,
  "filePath": ".../memory/decisions/use-sqlite-for-cache.md",
  "folder": "memory/decisions",
  "key": "use-sqlite-for-cache"
}
```

## 读取记忆

```json
{
  "name": "recall",
  "arguments": {
    "key": "use-sqlite-for-cache",
    "folder": "memory/decisions"
  }
}
```

返回：

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

## 搜索记忆

```json
{
  "name": "search",
  "arguments": {
    "query": "SQLite cache",
    "folder": "memory"
  }
}
```

返回按相关性排序的记忆列表。

## 引导上下文

新会话开始时调用 `bootstrap_workspace`，加载：

- `wire.jsonl` 中的最近对话上下文
- `essence/essence.md`
- 记忆索引树

```json
{
  "name": "bootstrap_workspace",
  "arguments": {}
}
```

返回：

```json
{
  "workspace": { "cwd": "...", "workspaceId": "...", "storePath": "..." },
  "recentContext": { ... },
  "essence": { "found": true, "content": "..." },
  "memoryIndexTree": "memory/...",
  "notesRefs": []
}
```

## 搜索对话历史

```json
{
  "name": "search_context",
  "arguments": {
    "query": "SQLite cache decision",
    "limit": 5
  }
}
```

返回跨会话命中的对话轮次。

## 加载指定轮次

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

## 主题追溯

主题用于连接跨会话的记忆和对话轮次。

### 给记忆打主题标签

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

### 给对话轮次打主题标签

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

### 追溯主题

```json
{
  "name": "trace_theme",
  "arguments": {
    "theme": "cache-design",
    "includeTurnContent": true
  }
}
```

返回与该主题关联的记忆和轮次时间线。

## 生成精炼轮次摘要

```json
{
  "name": "refine_session_turns",
  "arguments": {
    "sessionId": "session_abc123"
  }
}
```

这会在 `refined/<sessionId>.jsonl` 中创建原子摘要，供主题关联使用。

## 整理记忆

`organize_memories` 采用两态设计。

### 阶段 1：准备

```json
{
  "name": "organize_memories",
  "arguments": {}
}
```

返回供 LLM 提炼的 `memory/` 摘要。

### 阶段 2：存储

```json
{
  "name": "organize_memories",
  "arguments": {
    "content": "# Workspace Essence\n\n## Decisions\n- Use SQLite for cache...\n\n## Rules\n- ..."
  }
}
```

如果内容 ≤15 KB，则存储为 `essence/essence.md`。

## 重建索引

如果你用外部编辑器修改了 Markdown 文件，可以重建索引：

```json
{
  "name": "sync_workspace_index",
  "arguments": {}
}
```

## 典型工作流

1. **会话开始** —— `bootstrap_workspace` 加载上下文和精要。
2. **工作过程中** —— 出现决策和知识时及时 `remember`。
3. **做重大决策前** —— `search` 和 `recall` 相关记忆。
4. **会话结束** —— `organize_memories` 更新工作区精要。
5. **长期跟踪** —— `tag_theme` 和 `trace_theme` 构建跨会话叙事。

## 配套 Skill

如需自动、按协议驱动地使用这些工具，可安装 `skills/memory-manage/SKILL.md` 中的配套 Skill：

```bash
cp -r skills/memory-manage ~/.kimi-code/skills/memory-manage
```

该 Skill 规定了何时写入记忆、何时搜索、如何追溯主题，无需手动提示 Agent。
