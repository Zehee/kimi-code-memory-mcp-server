---
name: memory-manage
description: 统一管理 agent-memory MCP 的读取、删除、列出、搜索、归档等操作（按需加载，启动协议请配置在 ~/.kimi-code/AGENTS.md）
type: prompt
whenToUse: >
  当用户表达以下任一意图时自动调用：
  1. "记住"、"记下来"、"保存决策/规则/知识"、"写入决策/规则/知识"
  2. "删除"、"移除"、"清理" 某条记忆
  3. "列出"、"看看"、"有哪些" 记忆
  4. "查找"、"搜索" 记忆或上下文
  5. "恢复"、"加载"、"读取" 上次上下文或某条记忆
  6. "归档"、"移动" 记忆到另一个 folder
  7. "整理"、"重新组织"、"合并重复" 记忆
  8. "有哪些标签"
  9. "速记"、"便签"、"个人笔记" 等非项目临时记录
  10. "主题"、"这个话题怎么发展的"、"回顾一下 xx"、"把这条记录关联到 xx 主题"、"有哪些主题"
---

# 记忆管理协议

本 Skill 按需加载。如果希望每次会话启动时自动恢复记忆上下文，请将配套 `AGENTS.md` 复制到 `~/.kimi-code/AGENTS.md`。

---

## 记忆分类

| 类型 | folder | tags |
|------|--------|------|
| 决策 | `memory/decisions/` | `decision` |
| 规则 | `memory/rules/` | `rule` |
| 知识 | `memory/knowledge/` | `knowledge` |
| 参考 | `memory/reference/` | `reference` |
| 速记 | `notes/` | `scratch` |

---

## 什么时候必须 `remember`？

- 用户说"我们决定…"、"拍板了" → `memory/decisions/`，tag `decision`
- 用户说"这里必须…"、"红线是…" → `memory/rules/`，tag `rule`
- 技术选型、接口约定首次出现 → `memory/knowledge/`，tag `knowledge`
- 定位到 bug 根因和修复方案 → `memory/decisions/` 或 `memory/knowledge/`，tag `fix`
- 编码风格、目录结构、命名规范 → `memory/rules/`，tag `convention`

每次 `remember` 前自检：这条信息三天后还有价值吗？是否已有重复记忆？

---

## 什么时候不要 `remember`？

- ❌ 临时调试命令或探索性代码
- ❌ 用户未确认的推测
- ❌ 一次性报错（没有形成通用结论）
- ❌ 当前会话的临时上下文（由 `wire.jsonl` 自动捕获）
- ❌ 已经在 `memory/` 中存在的知识

---

## 决策守卫

准备执行任何可能改变项目状态的操作之前（写文件、改结构、做选择、引入依赖）：

1. 提取关键词
2. 并行查询：
   - `search(query, folder="memory")` —— 查决策/规则/知识
   - `search_context(query)` —— 查历史对话
3. 命中且一致 → 引用来源后继续
4. 命中但矛盾 → 向用户报告冲突，请求澄清
5. 未命中但重要 → 询问用户"这是一个新决策，是否记录？"

---

## 引用来源

所有从 `memory/` 召回的关键结论，回复中必须标注来源：

- ✅ "根据 `memory/decisions/xxx`，我们决定…"
- ❌ "我们之前决定…"（无来源）

---

## 主题追溯冷启动

当用户要求追溯某个主题时：

1. 确认主题范围
2. 索要 1-3 个关键词种子
3. 用 `search_context` 粗筛候选 turns
4. 经用户确认后，用 `refine_session_turns` 提炼缺失 turns
5. 用 `tag_theme` 生成/更新 `themes/<theme>.json`
6. 用 `trace_theme` 输出主题时间线

禁止没有关键词种子就全量提炼历史对话。

---

## 工具速查

| 场景 | 工具 |
|------|------|
| 写入记忆 | `remember` |
| 读取记忆 | `recall` |
| 搜索记忆 | `search` |
| 列出记忆 | `list` |
| 列出标签 | `list_tags` |
| 移动/归档 | `move` |
| 删除 | `delete` |
| 整理精要 | `organize_memories` |
| 同步索引 | `sync_workspace_index` |
| 搜索历史对话 | `search_context` |
| 加载指定轮次 | `load_turn_context` |
| 主题关联 | `tag_theme` |
| 主题追溯 | `trace_theme` |
| 列出主题 | `list_themes` |
| 精炼轮次 | `refine_session_turns` |

详细参数见 `docs/USAGE.md`。

---

## 禁止行为

- 禁止用 `folder="notes"` 保存项目相关记忆
- 禁止写入空 tags
- 禁止只口头答应而不调用工具
- 禁止在没有种子关键词的情况下全量提炼历史对话
- 禁止手动修改 `~/.kimi-code/sessions/` 下的 `wire.jsonl`
