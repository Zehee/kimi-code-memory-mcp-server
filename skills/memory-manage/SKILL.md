---
name: memory-manage
description: 提示 agent 在用户表达记忆相关意图时调用 agent-memory MCP 工具
type: prompt
whenToUse: >
  当用户表达以下任一意图时：
  1. "记住"、"记下来"、"保存决策/规则/知识"
  2. "删除"、"移除"、"清理" 某条记忆
  3. "列出"、"看看"、"有哪些" 记忆
  4. "查找"、"搜索" 记忆或上下文
  5. "恢复"、"加载"、"读取" 上次上下文或某条记忆
  6. "归档"、"移动" 记忆到另一个 folder
  7. "整理"、"重新组织"、"合并重复" 记忆
  8. "有哪些标签"
  9. "速记"、"便签"、"个人笔记"
  10. "主题"、"这个话题怎么发展的"、"回顾一下 xx"、"把这条记录关联到 xx 主题"、"有哪些主题"
---

# 记忆工具调度提示

本 Skill 是轻量提醒。当用户意图匹配上述任一情况时，调用对应的 `mcp__agent-memory__*` 工具。

## 快速映射

| 用户意图 | 工具 |
|----------|------|
| "记住…" / "保存…" | `mcp__agent-memory__remember` |
| "读取…" / "看看…" | `mcp__agent-memory__recall` |
| "搜索记忆…" | `mcp__agent-memory__search` |
| "列出记忆/标签" | `mcp__agent-memory__list` / `mcp__agent-memory__list_tags` |
| "移动/归档…" | `mcp__agent-memory__move` |
| "删除…" | `mcp__agent-memory__delete` |
| "整理记忆" | `mcp__agent-memory__organize_memories` |
| "同步索引" | `mcp__agent-memory__sync_workspace_index` |
| "搜索历史对话" | `mcp__agent-memory__search_context` |
| "加载第 N 轮" | `mcp__agent-memory__load_turn_context` |
| "关联到主题" | `mcp__agent-memory__tag_theme` |
| "追溯主题" | `mcp__agent-memory__trace_theme` |
| "列出主题" | `mcp__agent-memory__list_themes` |
| "精炼轮次" | `mcp__agent-memory__refine_session_turns` |

行为规范（何时 remember、决策守卫、主题追溯协议）见 `AGENTS.md` 或 `docs/USAGE.md`。
