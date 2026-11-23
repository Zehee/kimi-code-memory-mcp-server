# 记忆全面梳理报告（2026-11-19）

- 梳理对象：本项目的两套记忆语料 —— workspace store（`~/.kimi-code-memory/workspace-10ab0c98de85/`）与项目内 `memory/` 目录
- 范围说明：`~/.kimi-code-memory/` 下另有 12 个工作区的 store，属于其他项目的语料，本轮未纳入
- 方法：证据优先。逐条核验记忆声明 → 与当前代码/磁盘数据对照 → 修正或标注 → 落档为可检索的记忆条目
- 上游依据：`reviews/2026-11-19-v0.6.0-remediation-code-review.zh-CN.md`（含上次 review 原文）、`memory/decisions/v0-6-0-local-parallel-remediation.md`
- 重要前提：**梳理期间外部 agent 仍在开发整改**，凡涉及代码现状的结论都是**快照**，需在整改完成后复验

## 1. 结论摘要

1. 记忆语料**分裂为两份且互不可见**：MCP 工具只读写 workspace store；项目内 `memory/` 目录被 `.gitignore` 忽略、从未纳入版本管理，MCP 的 `search`/`recall`/`list`/`list_tags`/`bootstrap_workspace` 都读不到它，而 `AGENTS.md` 的引用示例恰恰指向项目内路径。
2. v0.5.1 基线知识条目中的**多数能力性结论已被 v0.6.0 取代**（跨进程锁、journal、回收站、CAS、仪表盘认证、wire 发现、检索语义、CI 矩阵、发布门禁、可逆安装等），但条目本身没有更新，仍会以"现状"被引用。已补指针表。
3. 九条审查发现在当前代码中**均已出现对应整改实现**；但整改尚未复验，因此不能记为"已验收"。
4. 记忆数据本身存在可修的卫生问题：1 条缺 frontmatter、11 条缺稳定身份字段、索引 structureHash 过期。**已全部修好并同步索引。**
5. 记忆体系新增了一条自我约束规则（`memory-claim-verification`），把本轮方法固化为可执行条目。

## 2. 梳理方法

| 步骤 | 做法 | 证据 |
| --- | --- | --- |
| 盘点 | 枚举两份语料的全部条目、目录与索引 | `~/.kimi-code-memory/workspace-10ab0c98de85/`、仓库 `memory/` |
| 体检 | 用项目自身的严格 frontmatter 解析器逐条解析，检查 `key/title/tags/createdAt/updatedAt`、key 与文件名一致性、分类标签、身份字段 | `src/utils/frontmatter.ts` |
| 索引核对 | 比对 `index.json` 条目与磁盘文件；用真实 `IndexReconciler.computeStructureHash()` 重算结构哈希 | `src/dao/index-reconciler.ts`、`src/dao/index-store.ts` |
| 引用完整性 | 解析 `searches/*.json` 的 session 引用，逐个到 `~/.kimi-code/sessions/` 核对是否仍存在 | `src/search/search-view-repository.ts` |
| 内容核验 | 把知识条目中的每条事实性声明，对照当前实现逐条验证并记录"仍成立 / 已被取代 / 未复核" | `src/**` |
| 修复 | 补 frontmatter、补指针、建新条目、按服务器自身加锁路径同步索引 | `IndexDao.reconcileIndex()`（内部持 `WorkspaceLock`） |

一次性体检脚本运行在系统临时目录，核对完成后已删除；上述"步骤 + 证据"列可按同样方式复现。

## 3. 数据体检结果

梳理前实际存在 11 条条目（store 7 / 项目内 4），梳理后 16 条（store 11 / 项目内 5）：

| 检查项 | 梳理前 | 梳理后 |
| --- | --- | --- |
| 条目总数 | store 7 / 项目内 4 | store 11 / 项目内 5 |
| frontmatter 可被当前解析器解析 | 10 / 11（项目内 `rules/mcp-versioning.md` 缺失） | 16 / 16 |
| `tags` 含分类标签 | 11 / 11 | 16 / 16 |
| key 与文件名一致 | 11 / 11 | 16 / 16 |
| 稳定身份字段 `id`/`revision`/`contentHash` | store 0 / 7，索引 0 / 7 | store 11 / 11，索引 11 / 11 |
| 跨语料重复 key | 0 | 0 |
| `index.json` 条目与磁盘文件一致 | 一致（无缺失/悬空条目） | 一致 |
| `structureHash` | 陈旧（记录 `372179…` vs 实算 `d4b45f…`） | 一致（`5de125c6…`） |
| 搜索视图 | 2 个，均 legacy 命名 `search-<12hex>` | 未改动（仍为 legacy，写入端已改 v2 命名） |
| 搜索视图引用的 session | 4 个，**全部仍存在**，无悬空引用 | 同左 |
| `essence/` `notes/` `themes/` `trash/` | 均为空 | 均为空 |

同步方式：通过 `IndexDao.reconcileIndex()` 执行（内部持 workspace 锁），未手工改 `index.json`。

**附带发现**：首次 reconcile 会先写身份字段再记录结构哈希，导致它自己记录的哈希随即失效，需要第二次 reconcile 才收敛（第二次零变更、零 revision 递增）。幂等、无数据损失，但每次升级后多一次全量扫描。

## 4. 内容核验：v0.5.1 基线条目与当前实现的差异

基线条目 `memory/knowledge/v0-5-1-architecture-and-runtime.md` 的声明分类如下：

**已被 v0.6.0 取代（14 项）**：工具数 22→24；回收站与稳定 ID；跨进程锁 / CAS / journal；主题 `memoryId`；index 缓存字段与结构哈希算法；仪表盘认证（`/api/*` 现强制 bearer token + Host/Origin 校验）；搜索视图路径越界；`wd_`/`wm_` wire 发现；refined 的 WAL/busy_timeout/来源 hash；raw 与 refined 检索语义统一为 AND；key 校验与 tags 三态、frontmatter 可逆解析；CI 矩阵；发布门禁与 lockfile 版本；setup 的 manifest 与整体回滚；essence 的 prepare/commit 与历史回滚。

**仍然成立**：系统定位（本地 Markdown + 规则式精炼，无向量检索 / embedding / LLM 服务）；workspace ID 派生方式；store 根目录与 `MEMORY_STORE_ROOT`；仪表盘默认端口 58628 起探测 10 个；prompts 仍 3 个；`search_context` / `refine_session_turns` 的本地规则属性。

**未复核（本轮未下结论）**：「index 损坏会静默视为空缓存」。

已在基线条目末尾补上指针表（逐条列出取代关系并指向 store 语料条目 `v0-6-0-architecture-delta`），避免基线被当作现状引用。

## 5. 本轮新增与修复的记忆条目

store 语料（MCP 可检索，已入索引）：

| key | 类型 | 内容 |
| --- | --- | --- |
| `v0-6-0-remediation-review-status` | knowledge / fix / review | 九项发现的**整改状态快照**，逐项给出实现位置与"待复验"口径，并列出仍欠缺的验证 |
| `v0-6-0-architecture-delta` | knowledge / architecture | 相对 v0.5.1 基线的已核验架构增量，每条带代码位置 |
| `memory-corpus-layout` | knowledge | 两份语料的物理分布、索引与身份字段状态、本次体检结果 |
| `memory-claim-verification` | rule / convention | 记忆声明的核验与引用规则（可核验、标时点、三分状态、引用标语料、元数据完整、去重、失效处理） |

项目内语料（人可读，随仓库走）：

| 文件 | 处置 |
| --- | --- |
| `memory/rules/mcp-versioning.md` | 补 frontmatter（`key/title/tags/createdAt/updatedAt`），并声明与 `AGENTS.md` 同源、冲突以 `AGENTS.md` 为准 |
| `memory/knowledge/v0-5-1-architecture-and-runtime.md` | 补「后续状态」指针表：14 项已被取代的基线结论 + 未复核项 |
| `memory/knowledge/memory-corpus-map.md` | 新增语料地图：两份语料的定位、可见性、条目分布与引用写法 |

## 6. 需要用户决策的事项

1. **两份语料如何收敛**：现状是项目内 `memory/` 既不被 MCP 读取，又被 git 忽略（易失）。可选：(a) 保持分工并互加指针（当前做法）；(b) 把项目内条目迁入 store，项目内只留文档；(c) 让 AGENTS.md 的路径示例改指 store 位置。
2. **项目内 `memory/` 是否纳入版本管理**：若要随仓库分发，需要 `git add -f` 或调整 `.gitignore` 规则；这属于仓库结构决策，未擅自改动。
3. **v0.6.0 验收**：按 `memory/decisions/v0-6-0-local-parallel-remediation.md`，构建后真实 MCP 运行实例复验仍未完成；即使仓库测试全绿也不构成验收。

## 7. 本轮未做的事

- 未修改任何 `src/`、`tests/`、`scripts/` 代码与测试。
- 未替外部 agent 复验整改实现（跨进程竞争、真实运行实例、故障注入全矩阵、恶意浏览器实测）。
- 未迁移或删除任何既有记忆条目；只做补全、指针与新增。
- 未把在途整改写成"已修复 / 已验收"，相关条目一律标注快照与待复验。

## 8. 上次 review 的衔接

上次 review（`reviews/2026-11-19-v0.6.0-remediation-code-review.zh-CN.md`）的九项发现在本轮梳理时的状态：

| ID | 级别 | 快照状态 | 实现位置 |
| --- | --- | --- | --- |
| R-01 读取回填未持锁 | P1 | 已整改（待复验） | `src/dao/memory-store.ts` 的 `scheduleIdentityPersist()` / `persistIdentity()` |
| R-02 搜索游标重复 / 不推进 | P1 | 已整改（待复验） | `src/context/wire-context.ts` 的分页扫描分支 |
| R-03 主题时间线渲染已删除记忆 | P1 | 已整改（待复验） | `src/vis/api.ts` 的 `memoryToTimelineItem()` |
| R-04 递归删除绕过回收站 | P2 | 已整改（待复验） | `src/vis/api.ts` 的递归删除改为逐条软删除 |
| R-05 移动忽略源文件删除失败 | P1 | 已整改（待复验） | `src/dao/memory-store.ts` 的 `moveWithResult()` 重试 + 回滚 |
| R-06 仪表盘 singleton 跨进程竞争 | P1 | 已整改（待复验） | `src/vis/auto-start.ts` 锁内 claim + 租约心跳 |
| R-07 新建文件无 CAS | P2 | 已整改（待复验） | `src/vis/static/app.js` 的 `expectedRevision: 0` |
| R-08 essence 保存未写 journal | P2 | 已整改（待复验） | `src/tools/system-tools.ts` 的 `runJournaled()` |
| R-09 purge 报告失真 | P2 | 已整改（待复验） | `src/purge.ts` 改用 `findAllWorkspaceSessions()` |

明细与证据等级见 store 语料条目 `v0-6-0-remediation-review-status`。

## 9. 本轮验证记录（2026-11-19）

```text
npm run typecheck            通过
npm run lint                 通过
npm run test:unit            通过（7 suites）
npm test                     通过（退出码 0，121 个用例；39 suites + setup 20 suites + search/storage/vis）
npx tsx tests/vis-security.test.ts   通过
npm run build                通过（版本同步为 0.6.0）
```

数据层验证（用项目自身实现核对）：

- `IndexDao.reconcileIndex()` 同步结果：`addedEntries 4`、`updatedEntries 7`、`corruptFiles 0`、`errors 0`；
  二次同步零变更、零 revision 递增，`checkFreshness()` 返回 `fresh`。
- 索引中 11 条 store 条目全部带 `title` / `tags` / `id` / `revision` / `contentHash`，可被 `search` / `list` 检索。
- 搜索视图引用的 4 个 session 在 `~/.kimi-code/sessions/` 中全部仍存在。

未做的事见 §7；`npm test` 通过只说明仓库内验证为绿，**不构成 v0.6.0 发布验收**。
