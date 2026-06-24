# Kimi Code Memory MCP 启动钩子

本文件作用于所有 Kimi Code CLI 会话。当把它放到 `~/.kimi-code/AGENTS.md` 后，每次会话启动时其中的规则会自动注入 model context。

> 配套项目：https://github.com/Zehee/kimi-code-memory-mcp-server

---

## 强制启动协议

每次会话开始后、回答用户第一个问题或执行任何可能改变项目状态的操作之前，**自动调用** `mcp__agent-memory__bootstrap_workspace()`。

必须读取并内化：
1. `essence.md` —— 当前工作区什么最重要
2. `memoryIndexTree` —— 记忆目录结构，关注标记 `[new]` 的最近变化
3. `recentContext` —— 当前 session 的最近对话
4. `notesRefs` —— 是否有待处理的速记

---

## 记忆分类约定

| 类型 | folder | tags | 用途 |
|------|--------|------|------|
| 决策 | `memory/decisions/` | `decision` | 架构、接口、流程决策 |
| 规则 | `memory/rules/` | `rule` | 编码规范、协作红线 |
| 知识 | `memory/knowledge/` | `knowledge` | 技术栈、业务背景 |
| 参考 | `memory/reference/` | `reference` | 外部链接、文档引用 |
| 速记 | `notes/` | `scratch` | 临时便签，不进入长期精要 |

---

## 什么时候必须 `remember`？

出现以下信号时立即写入 `memory/`：

- 用户说"我们决定…"、"拍板了" → `memory/decisions/`，tag `decision`
- 用户说"这里必须…"、"红线是…" → `memory/rules/`，tag `rule`
- 技术选型、接口约定首次出现 → `memory/knowledge/`，tag `knowledge`
- 定位到 bug 根因和修复方案 → `memory/decisions/` 或 `memory/knowledge/`，tag `fix`
- 编码风格、目录结构、命名规范 → `memory/rules/`，tag `convention`

---

## 什么时候不要 `remember`？

- ❌ 临时调试命令或探索性代码
- ❌ 用户未确认的推测
- ❌ 一次性报错（没有形成通用结论）
- ❌ 当前会话的临时上下文（由 `wire.jsonl` 自动捕获）
- ❌ 已经在 `memory/` 中存在的知识

判断口诀：如果这条信息三天后回头看仍然有价值，才写入 `memory/`。

---

## 决策守卫

准备执行任何可能改变项目状态的操作之前（写文件、改结构、做选择、引入依赖）：

1. 提取关键词（技术实体 + 动作）
2. 并行查询：
   - `search(query, folder="memory")` —— 查决策/规则/知识
   - `search_context(query)` —— 查历史对话
3. 命中且一致 → 引用来源后继续
4. 命中但矛盾 → 向用户报告冲突，请求澄清
5. 未命中但重要 → 询问用户"这是一个新决策，是否记录？"

---

## 引用来源的纪律

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

## 记忆卫生检查清单

每次调用 `remember` 前：

- [ ] 这条信息三天后还有价值吗？
- [ ] 是否已有重复记忆？（先 `search`）
- [ ] `folder` 选对了吗？项目相关不进 `notes/`
- [ ] `tags` 是否包含最贴切的分类标签？
- [ ] 正文是否包含决策原因/影响范围/相关文件？

每次做决策前：

- [ ] 是否已 `search` 相关历史决策？
- [ ] 是否已检查 `essence.md` 中的核心约束？
- [ ] 如果与历史记忆冲突，是否已向用户澄清？

---

## 禁止行为

- 禁止用 `folder="notes"` 保存项目相关记忆
- 禁止写入空 tags
- 禁止只口头答应而不调用工具
- 禁止在没有种子关键词的情况下全量提炼历史对话
- 禁止手动修改 `~/.kimi-code/sessions/` 下的 `wire.jsonl`

