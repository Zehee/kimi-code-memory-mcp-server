# Kimi 记忆协议

## 会话启动：优先调用 `mcp__kimi-memory__bootstrap_workspace()`

每次新会话开始后、回答用户第一个问题或执行任何可能改变项目状态的操作之前，**优先**调用 `mcp__kimi-memory__bootstrap_workspace()`，并阅读内化：

1. `workspace` —— 工作区基本信息
2. `sessionIdentity` —— 当前会话身份；`identityAssumed: true` 表示身份是按 mtime 猜测的低置信度结果，此时不要把 `recentContext` 当作确凿事实，更不要据此执行删除、覆盖等破坏性操作
3. `essence` —— `essence/essence.md` 的内容
4. `memoryIndexTree` —— 记忆目录结构，关注 `[new]` 标记
5. `notesRefs` —— 是否有待处理的速记

**动态加载路径**：如果首轮顶层工具列表中没有 `mcp__kimi-memory__bootstrap_workspace`，但存在内置 `select_tools`，先调用 `select_tools(names=["mcp__kimi-memory__bootstrap_workspace"])`，加载成功后立即调用它。不要仅因首轮未直接注入就判定记忆服务不可用。

**降级路径（fail-open）**：如果直接调用和动态加载都不可用，或调用超时、报错，**明确向用户提示一次**"记忆服务不可用，本次会话将不加载/写入长期记忆"，然后正常继续基本工作。不要反复重试，不要虚构记忆内容，不要因为记忆服务不可用而拒绝完成任务。

调用成功后，向用户汇报当前上下文（任务、状态、下一步、阻塞项）。

---

## 记忆分类约定

| 类型 | folder | tags | 用途 |
|------|--------|------|------|
| 决策 | `memory/decisions/` | `decision` | 架构、接口、流程决策 |
| 规则 | `memory/rules/` | `rule` | 编码规范、协作红线 |
| 知识 | `memory/knowledge/` | `knowledge` | 技术栈、业务背景 |
| 参考 | `memory/reference/` | `reference` | 外部链接、文档引用 |
| 速记 | `notes/` | `scratch` | 临时便签，不进入长期精要 |

## 什么时候必须 `remember`？

出现以下信号时立即写入 `memory/`：

- 用户说"我们决定…"、"拍板了" → `memory/decisions/`，tag `decision`
- 用户说"这里必须…"、"红线是…" → `memory/rules/`，tag `rule`
- 技术选型、接口约定首次出现 → `memory/knowledge/`，tag `knowledge`
- 定位到 bug 根因和修复方案 → `memory/decisions/` 或 `memory/knowledge/`，tag `fix`
- 编码风格、目录结构、命名规范 → `memory/rules/`，tag `convention`

更新已存在的记忆时，可携带 `expectedRevision`（recall/list 返回的 revision）做乐观并发控制；冲突时读取当前版本，合并后再写。

## 什么时候不要 `remember`？

- ❌ 临时调试命令或探索性代码
- ❌ 用户未确认的推测
- ❌ 一次性报错（没有形成通用结论）
- ❌ 当前会话的临时上下文（由 `wire.jsonl` 自动捕获）
- ❌ 已经在 `memory/` 中存在的知识

判断口诀：如果这条信息三天后回头看仍然有价值，才写入 `memory/`。

## 决策守卫（低成本）

准备执行任何可能改变项目状态的操作之前（写文件、改结构、做选择、引入依赖）：

1. 提取关键词（技术实体 + 动作）
2. 并行查询（**守卫检查必须带 `save_view: false`，避免高频检查产生大量搜索视图**）：
   - `search(query, folder="memory")` —— 查决策/规则/知识
   - `search_context(query, save_view: false)` —— 查历史对话
3. 命中且一致 → 引用来源后继续
4. 命中但矛盾 → 向用户报告冲突，请求澄清
5. 未命中但重要 → 询问用户"这是一个新决策，是否记录？"

不需要每次写操作都全量搜索：任务开始、架构敏感操作和上下文明显变化时执行守卫即可。

## 删除与恢复

- `delete` 是软删除：条目进入回收站（`trash/`），主题引用标记为 `deleted`，结果中会返回 `trashPath`。
- 恢复用 `restore_memory(key, folder)`：稳定 ID 与 revision 保持不变，主题引用重新激活。
- 精要回滚用 `rollback_essence`（不带参数恢复最近一版，或指定 `revision`）；当前版本会先归档，所以回滚本身也可回滚。
- 只有用户明确要求"彻底删除"时，才说明回收站副本仍存在并请求确认（永久清理用 `kimi-memory-setup --purge-derived-data`，由用户在终端执行）。

## 精要整理（organize_memories）

两阶段：空调用 prepare → 得到 `prepareToken` 与待整理记忆；带上 `content` + `prepareToken` 存回。若期间 memory 变化，store 会返回 `conflict`，此时重新 prepare 再提交，不要用旧 token 强行覆盖。整理时正文内用 `> 来源：memory/<folder>/key` 标注来源。

## 引用来源的纪律

所有从 `memory/` 召回的关键结论，回复中必须标注来源：

- ✅ "根据 `memory/decisions/xxx`，我们决定…"
- ❌ "我们之前决定…"（无来源）

## 主题追溯

当用户要求追溯某个主题时：

1. 确认主题范围
2. 用 `search_context` 打捞相关 turns（主题追溯是显式任务，允许保存视图；调用时会自动按 90 秒时间簇扩展并提炼命中的 turns）
3. 用 `list_search_views` 查看最近的搜索视图，作为 theme 挂载的候选集
4. 对搜索命中的 turns 做语义分析，用 `tag_theme` 把 genuinely belongs to the theme 的 turns 逐个挂载到 `themes/<theme>.json`
5. 如果候选不足，用新的 query 再次 `search_context` 打捞，生成新的 search view
6. 用 `trace_theme` 输出主题时间线

`search_context` 已内置提炼能力，不需要单独调用 `refine_session_turns`。

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

## 禁止行为

- 禁止用 `folder="notes"` 保存项目相关记忆
- 禁止写入空 tags
- 禁止只口头答应而不调用工具
- 禁止手动修改 `~/.kimi-code/sessions/` 下的 `wire.jsonl`
- **当用户输入以 `？` / `?` 结尾时，禁止执行任何写入/修改/构建/运行等改变项目状态的操作**：只能回答问题和进行讨论，必须等待用户明确说出「确定」「可以」「开始吧」等指令后才能行动
