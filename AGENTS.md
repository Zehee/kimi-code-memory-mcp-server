## 强制启动协议

每次会话开始后、回答用户第一个问题或执行任何可能改变项目状态的操作之前，**必须调用** `mcp__kimi-memory__bootstrap_workspace()`。

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

## 主题追溯

当用户要求追溯某个主题时：

1. 确认主题范围
2. 用 `search_context` 打捞相关 turns（调用时会自动按 90 秒时间簇扩展并提炼命中的 turns）
3. 用 `list_search_views` 查看最近的搜索视图，作为 theme 挂载的候选集
4. 对搜索命中的 turns 做语义分析，用 `tag_theme` 把 genuinely belongs to the theme 的 turns 逐个挂载到 `themes/<theme>.json`
5. 如果候选不足，用新的 query 再次 `search_context` 打捞，生成新的 search view
6. 用 `trace_theme` 输出主题时间线

`search_context` 已内置提炼能力，不需要单独调用 `refine_session_turns`。

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

## MCP Server 版本号规则

项目存在两个版本号，必须区分并保持一致：

| 版本号 | 位置 | 用途 |
|--------|------|------|
| 仓库版本 | `package.json#version` | 发布包、Git tag、CHANGELOG 的版本 |
| 运行实例版本 | `src/version.ts` → `src/server.ts` | MCP 协议握手时报告的版本 |

- 采用 SemVer 2.0.0（`MAJOR.MINOR.PATCH`）。
- 单一事实来源：`package.json#version`。
- 运行实例版本通过 `npm run sync-version` 从 `package.json` 同步到 `src/version.ts`。
- `npm run build` 会自动执行同步。
- 禁止手动修改 `src/version.ts`；改版本只改 `package.json`。

### 升级触发条件

| 位 | 触发条件 |
|----|----------|
| MAJOR | 不兼容的协议/存储格式/工具签名变更 |
| MINOR | 新增工具或能力、非破坏性增强 |
| PATCH | Bug 修复、性能优化、文档/测试更新 |

### 代码变更后验证顺序

1. 仓库内：`npm run typecheck && npm run lint && npm test`
2. **运行实例实测**：当仓库测试受本地环境干扰（例如仓库本身积累了大量历史 sessions、数据状态复杂，导致难以在干净条件下验证）时，将新代码同步到实际 MCP 运行实例（如 Kimi Code CLI 调用的 server），用真实工作区验证行为。
3. 严禁仅以仓库测试通过为由跳过必要的运行实例实测，尤其是涉及环境变量、路径解析、缓存/模块状态的变更。

---

## 禁止行为

- 禁止用 `folder="notes"` 保存项目相关记忆
- 禁止写入空 tags
- 禁止只口头答应而不调用工具
- 禁止手动修改 `~/.kimi-code/sessions/` 下的 `wire.jsonl`
- 禁止手动修改 `src/version.ts`（应通过 `package.json` + `npm run sync-version` 同步）
- **当用户输入以 `？` / `?` 结尾时，禁止执行任何写入/修改/构建/运行等改变项目状态的操作**：只能回答问题和进行讨论，必须等待用户明确说出「确定」「可以」「开始吧」等指令后才能行动

