# 架构审核与详细整改方案

> 审核对象：`kimi-code-memory-mcp-server` v0.5.1  
> 基线提交：`37665aa`  
> 审核日期：2026-11-18  
> 文档性质：架构审核与整改建议，不代表相关设计已经获批或实施  
> 审核方式：源码审查、文档比对、现有构建与测试验证；未进行长期压力测试、恶意浏览器实测和在线 CVE 查询

## 1. 执行摘要

项目的模块划分、Markdown 可审计性、本地优先和跨会话追溯方向合理，现有静态检查、构建和测试也全部通过。但当前实现仍主要按照“单进程本地文件工具”设计，实际运行形态已经是：

- 同一工作区存在多个 MCP 进程；
- 多个进程共享 Markdown、JSON 和 SQLite；
- 仪表盘通过浏览器提供读写能力；
- wire 与精炼摘要形成长期上下文数据；
- 全局 `AGENTS.md` 协议影响所有工作区。

因此，当前最主要的问题不是功能不足，而是以下四类基础契约没有跟上运行形态：

1. **信任边界**：浏览器网页、MCP 客户端、本地文件和共享进程之间缺少明确认证与授权边界。
2. **一致性边界**：多进程写入和跨存储更新没有统一事务、锁、版本与恢复机制。
3. **身份与新鲜度**：当前会话依赖 mtime 猜测，精炼索引无法证明覆盖全部原始数据。
4. **生命周期边界**：记忆、主题、搜索视图、精要、仪表盘和安装配置缺少完整的拥有者及清理规则。

整改不建议直接推倒重写。推荐采用两阶段路线：

- **短期**：修复安全漏洞和检索正确性，在现有进程模型上增加统一校验、跨进程锁、原子写入、版本检查和恢复机制。
- **中长期**：若多进程共享是长期主场景，演进为“每工作区一个存储守护进程 + 瘦 MCP 适配器”，由守护进程独占存储和仪表盘生命周期。

## 2. 对上一轮审核的自审与校正

### 2.1 结论仍然成立的部分

以下问题可由源码直接确认，不依赖推测：

- 仪表盘 API 没有认证，并允许任意 Origin 的跨域读写。
- 搜索视图删除键未限制在 `searches/` 目录内。
- SQLite 有命中时提前返回，会漏掉未精炼的原始匹配轮次。
- 锁仅是进程内 `Mutex`，临时文件名固定。
- 当前会话通过最新 mtime 选择，而不是显式 session ID。
- 仪表盘属主退出会关闭其他进程仍在复用的实例。
- `remember`/`move` 的 key 规范化路径不一致。
- `saveEssence` 未等待异步索引更新。
- 安装流程并未对所有修改提供备份和所有权检查。
- `package.json` 与 `package-lock.json` 根版本不一致。
- 多项文档描述与当前代码不一致。

### 2.2 需要收紧或澄清的表述

| 上轮表述                       | 自审后的准确边界                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 任意网站可攻击 loopback 仪表盘 | 无认证和通配 CORS 是已确认的设计漏洞；具体利用是否成功还受浏览器 loopback/PNA 策略影响，不能把这些浏览器策略当作安全控制。            |
| 多进程会造成数据损坏           | 缺少跨进程保护已确认，但本次没有观察到真实损坏，也没有完成并发故障复现；应表述为高风险而非既发事故。                                  |
| 敏感文件被服务器读取           | 没有发现服务器直接打开 `.env`、SSH 私钥的代码；风险是敏感内容可能已通过 wire 的用户文本、助手文本、工具参数或结果进入摘要和返回结果。 |
| SQLite 会发生锁冲突            | 未配置 WAL 和 busy timeout 已确认，实际 `SQLITE_BUSY` 频率需要多进程压力测试验证。                                                    |
| Markdown 链接存在 XSS          | 未限制 URL scheme 是安全缺口，但本次没有证明稳定可利用的脚本执行链；应作为安全加固项，而不是已确认 XSS。                              |
| lockfile 漂移破坏发布          | 根版本漂移和发布脚本未同步 lockfile 已确认，但不能据此断言 `npm ci` 或 `npm publish` 必然失败。                                       |
| 性能不满足要求                 | 全量扫描、同步 I/O 和无界输入已确认，实际延迟与容量拐点尚未基准测量。                                                                 |

### 2.3 证据等级

本文使用三个等级：

- **已确认**：控制流或数据处理可从源码直接推出。
- **风险**：缺陷条件存在，但影响程度需要并发、故障或性能实验确认。
- **缺口**：尚未提供的架构或产品能力，不表示当前代码一定出错。

## 3. 审核范围与当前验证结果

### 3.1 已执行验证

以下命令在基线提交上通过：

```bash
npm run typecheck
npm run lint
npm run test:unit
npm test
npm run build
```

其中：

- 单元测试 6/6 套件通过；
- MCP stdio 集成测试通过；
- 仪表盘 HTTP 与自动启动测试通过；
- 构建和静态资源复制通过；
- 验证后 Git 工作区保持干净。

这些结果说明当前已覆盖用例没有回归，但不能覆盖本文列出的恶意 Origin、路径穿越、真实多进程、混合精炼/未精炼数据、属主退出和损坏恢复场景。

### 3.2 当前信任边界

```text
任意网站 / 本地浏览器
          │ HTTP，当前无认证且 CORS *
          ▼
仪表盘 Hono API ───────────────┐
                              │
Kimi Code / 其他 MCP 客户端    │
          │ stdio             │
          ▼                   │
多个 MCP 进程 ────────────────┤
                              ▼
        Markdown + index.json + themes/*.json
        searches/*.json + refined.sqlite
                              ▲
                              │ 读取
                    Kimi Code wire.jsonl
```

当前缺失的边界包括：

- 浏览器到仪表盘：认证、Origin、请求大小和授权。
- MCP 进程之间：锁、版本、写入顺序和崩溃恢复。
- wire 到 refined：来源版本、覆盖水位和失效规则。
- memory 到 theme/essence：稳定 ID、来源版本和引用完整性。
- setup 到用户配置：所有权、备份和可逆性。

## 4. 风险登记

| ID       | 级别 | 维度     | 问题                                                                 | 证据等级 |
| -------- | ---- | -------- | -------------------------------------------------------------------- | -------- |
| SEC-01   | P0   | 安全     | 仪表盘无认证且允许任意 Origin 读写                                   | 已确认   |
| SEC-02   | P0   | 安全     | 搜索视图 key 可路径穿越并删除越界 JSON                               | 已确认   |
| RET-01   | P1   | 检索     | 部分精炼命中导致原始匹配漏检                                         | 已确认   |
| RET-02   | P1   | 检索     | 精炼与原始路径的关键词语义和排序不一致                               | 已确认   |
| CON-01   | P1   | 并发     | 进程内锁无法保护共享文件，固定 tmp 存在竞争                          | 风险     |
| CON-02   | P1   | 一致性   | Markdown、索引、主题、SQLite 缺少跨存储恢复契约                      | 已确认   |
| ID-01    | P1   | 身份     | 当前会话通过 mtime 猜测                                              | 已确认   |
| ID-02    | P1   | 身份     | managed workspace（`wm_`）会话发现、primary 变更和路径别名映射未覆盖 | 已确认   |
| LIFE-01  | P1   | 生命周期 | 仪表盘属主退出导致复用方失效                                         | 已确认   |
| API-01   | P1   | 写入     | key 规范化不一致，可能写错路径或索引                                 | 已确认   |
| API-02   | P1   | 写入     | 精要保存未等待索引更新                                               | 已确认   |
| REF-01   | P1   | 引用     | 移动/删除产生悬空主题引用，级联删除影响共享摘要                      | 已确认   |
| SETUP-01 | P1   | 安装     | 备份、所有权和回滚不完整                                             | 已确认   |
| PRIV-01  | P1   | 隐私     | 缺少脱敏、保留、导出和彻底清除策略                                   | 缺口     |
| PERF-01  | P1   | 性能     | 全量同步扫描、无界 hits 和重复目录发现                               | 风险     |
| IDX-01   | P2   | 索引     | 普通读取不自动 reconcile，mtime hash 可能漏检                        | 已确认   |
| DATA-01  | P2   | 序列化   | frontmatter 单引号不能可靠往返，空 tags 无法清空                     | 已确认   |
| DATA-02  | P2   | 演进     | 缺少统一 schema 校验、SQLite migration 和损坏隔离                    | 缺口     |
| GOV-01   | P2   | 记忆治理 | 缺少修订、替代关系、来源版本和回滚                                   | 缺口     |
| HOST-01  | P2   | 宿主集成 | 全局协议缺少 MCP 不可用时的降级路径                                  | 已确认   |
| REL-01   | P2   | 发布     | lockfile 漂移、清洁检查和发布门禁不完整                              | 已确认   |
| TEST-01  | P2   | 测试     | 缺少安全、多进程、故障、性能和 Windows CI                            | 缺口     |
| DOC-01   | P2   | 文档     | 索引格式、refined 存储和手动安装说明漂移                             | 已确认   |
| WEB-01   | P2   | 前端     | Markdown 链接无 scheme 白名单，缺少 CSP                              | 缺口     |

## 5. 目标架构与核心约束

### 5.1 短期目标：保留现有部署模型

```text
MCP Tool / Vis API
        │
        ▼
统一应用服务层
  ├─ 输入校验与规范化
  ├─ 权限和路径边界
  ├─ 乐观版本检查
  ├─ 工作区级跨进程锁
  └─ 写入日志与恢复
        │
        ├─ MemoryRepository
        ├─ IndexRepository
        ├─ ThemeRepository
        ├─ SearchViewRepository
        └─ RefinedRepository
```

这一阶段不改变用户安装方式，重点是让所有写操作经过同一应用服务，而不是由 MCP 工具和 HTTP handler 分别拼装路径、操作文件。

### 5.2 中长期目标：单工作区存储守护进程

```text
MCP 进程 A ─┐
MCP 进程 B ─┼─ 本机 IPC / 命名管道 ─┐
MCP 进程 C ─┘                      │
                                  ▼
                       Workspace Memory Daemon
                       ├─ Memory / Theme / Search Service
                       ├─ SQLite 与文件写入
                       ├─ 增量索引进程
                       └─ 认证后的 Vis HTTP API
                                  │
浏览器 ── Bearer + same-origin ───┘
```

优点：

- 单写者模型消除大部分共享文件竞争；
- 仪表盘不再依附任意一个 MCP 进程；
- 会话发现、索引和缓存可以统一；
- 数据迁移、备份、健康检查有明确拥有者。

代价：

- 增加 IPC 协议、守护进程启动和升级兼容成本；
- 需要处理 daemon 崩溃、版本不匹配和孤儿进程；
- Windows 命名管道与 Unix socket 需要跨平台测试；
- IPC 必须校验同用户身份，使用独立协议版本握手，并定义滚动升级期间新旧客户端的兼容矩阵；
- daemon 升级不得让旧 MCP 客户端静默连接到不兼容存储格式。

因此，不建议把 daemon 作为 P0 修复的前置依赖。

### 5.3 数据真相源契约

| 数据          | 权威来源               | 可重建性               | 必须补充的契约                                   |
| ------------- | ---------------------- | ---------------------- | ------------------------------------------------ |
| 长期记忆      | `memory/**/*.md`       | 自身即权威             | 稳定 ID、revision、来源、软删除                  |
| 索引          | 由 Markdown 重建       | 可重建                 | schema 版本、文件版本、新鲜度                    |
| 原始会话      | Kimi Code `wire.jsonl` | 外部拥有               | session ID、文件版本、读取位置                   |
| refined turns | 由 wire 生成           | wire 存在时可重建      | extractor 版本、来源 hash；wire 删除后的保留策略 |
| 主题          | 用户/Agent 创建的关联  | 不能完全从 memory 重建 | 独立权威数据、稳定引用、schema 版本              |
| 搜索视图      | 查询结果快照           | 可重新查询             | 查询参数、时间、schema 版本、临时数据定位        |
| 精要          | 由 memory 和旧精要生成 | 语义上不可完全重建     | 来源 revision、生成器、历史版本、回滚            |
| setup 配置    | 用户 Kimi 配置         | 用户拥有               | 安装所有权、原始备份、修改 hash                  |

关键原则：**不能因为 index 可重建，就把 themes、essence 或 wire 删除后的 refined 也当成同等可丢弃缓存。**

### 5.4 必须维持的系统不变量

1. 未认证请求不能读取或修改任何工作区数据。
2. 所有文件路径解析后必须位于预期根目录，且不允许通过符号链接逃逸。
3. 任意搜索结果都不能仅因另一部分数据已精炼而遗漏未精炼匹配。
4. 同一 turn 在 refined/raw 两条路径上使用一致的关键词、过滤和排序语义。
5. 同一工作区的写操作必须有跨进程顺序或乐观版本冲突，不允许静默 last-write-wins。
6. 任意写入阶段崩溃后，下次启动能恢复或明确报告，不能静默丢数据。
7. memory 移动或删除后，主题不能继续把旧路径当作有效引用。
8. 已确认的当前会话只能由明确身份确定；mtime 回退只能产生低置信度候选上下文，不能驱动破坏性操作。
9. setup undo 只能移除本工具拥有且未被用户另作修改的内容。
10. 所有派生数据必须记录来源版本或明确标记为无来源的快照。

## 6. 详细解决方案

### 6.1 SEC-01：重建仪表盘安全边界

#### 改动方案

1. 默认仅绑定 `127.0.0.1` 或 `::1`，非回环监听先不支持隐式开启。
2. 删除 `Access-Control-Allow-Origin: *`。正常仪表盘与 API 同源，不需要开放跨域。
3. 所有 `/api/*`，包括 GET，都要求 Bearer token；健康检查只返回无敏感信息的固定状态。
4. 校验 `Host`，只允许当前监听地址和端口，降低 DNS rebinding 风险。
5. 对存在 `Origin` 的请求，只允许仪表盘自身 Origin；跨域预检默认拒绝。
6. 写请求要求 `Content-Type: application/json`，限制 body 大小和超时。
7. 增加统一 401/403/413 错误响应，不返回内部堆栈。

#### token 发放与进程复用

推荐每个工作区维护仅当前用户可读写运行文件：

```json
{
  "schemaVersion": 1,
  "workspaceId": "workspace-...",
  "url": "http://127.0.0.1:58628",
  "pid": 12345,
  "token": "<32 字节以上随机值>",
  "createdAt": "..."
}
```

运行文件位于工作区私有运行目录，权限尽量设置为 `0600`；Windows 使用继承的用户 ACL 并验证行为。

打开浏览器时使用 URL fragment 传递引导 token，例如（token 本身不是一次性凭证）：

```text
http://127.0.0.1:58628/#bootstrap=<token>
```

fragment 不会进入 HTTP 请求日志或 Referer。前端读取后立即：

1. 将 token 放入 `sessionStorage`；
2. 用 `history.replaceState` 清除 fragment；
3. 后续通过 `Authorization: Bearer ...` 调用 API。

sibling MCP 进程从私有运行文件读取 token，完成认证后的 `/api/workspace` 探测。不要把 token 放在 query 参数、HTML 源码、控制台日志或 MCP 工具返回值中。

#### 临时兼容策略

在认证完成并发布前，建议将 `KIMI_MEMORY_AUTO_VIS` 默认改为关闭；已有显式开启用户仍应看到安全警告。不要通过“仅隐藏写接口”解决，因为记忆读取本身也敏感。任何保留的只读模式也必须先完成认证，未认证只读模式不属于安全止损方案。升级过程中不得复用旧版本遗留的无认证实例，应绑定新端口或 fail closed，并提示重启旧 MCP 进程。

#### 验收标准

- 无 token 的 GET/POST/DELETE 全部返回 401。
- 恶意 Origin 即使带预检也不能获得可读响应。
- token 不出现在 URL query、访问日志和响应体中。
- 非回环监听默认拒绝启动或要求独立、明确的强认证配置。
- 同源仪表盘功能保持可用。

### 6.2 SEC-02：统一搜索视图标识和路径处理

不要在 MCP 和 vis 中分别拼接路径。新增共享 `SearchViewRepository`：

```ts
const SEARCH_VIEW_KEY = /^search-(?:[a-f0-9]{12}|v2-[a-f0-9]{32})$/;

function resolveSearchView(root: string, key: string): string {
  if (!SEARCH_VIEW_KEY.test(key)) {
    throw new InvalidSearchViewKeyError(key);
  }
  return safeResolve(root, 'searches', `${key}.json`);
}
```

其中 `search-[a-f0-9]{12}` 仅用于兼容现有视图，`search-v2-[a-f0-9]{32}` 用于新视图。解析器不得接受其他“看起来像 ID”的变体；写入端只生成 v2 ID，读取和安全删除端同时支持两种格式。

同时要求：

- 对已有文件执行 `lstat`/`realpath`，拒绝符号链接逃逸；
- GET、DELETE 和级联删除使用同一个解析函数；
- 无效 key 返回 400，不存在返回 404，禁止尝试其他路径；
- 搜索视图 ID 不再只由 query 决定，见 RET-02；
- MCP 与 HTTP 共用删除服务，避免两份级联逻辑继续漂移。

回归用例至少覆盖：

```text
../../mcp-config
../../../.kimi-code/mcp
..%2F..%2Fmcp-config
search-abcdef123456.json
search-ABCDEF123456
search-v2-0123456789abcdef0123456789abcdef
search-v2-0123456789ABCDEF0123456789abcdef
search-../index
```

### 6.3 RET-01/RET-02：先保证召回完整，再优化索引

#### 正确性优先的查询流程

```text
规范化 query 和 filters
          │
          ├─ 查询 refined candidates
          │
          └─ 扫描所有未覆盖、已变化或无法证明新鲜的 wire
                    │
                    ▼
          按 sessionId + turnId 合并
                    │
          wire 存在：原始 turn 为内容权威
          wire 缺失：refined-only 作为降级内容
                    │
          统一日期过滤、关键词匹配、评分和去重
                    │
          排序后应用 limit
                    │
          只针对返回候选构建 clusters 和补充精炼
```

短期最简单的正确实现是每次合并 refined 与全量 raw 结果，然后统一去重排序。性能可以后续通过增量索引恢复，不应重新加入“有 refined 命中就提前返回”的捷径。

#### 统一语义

建议默认多关键词采用 AND：每个 term 至少在 `user + agent + action names` 或 refined 可搜索字段中出现一次。评分只影响排序，不决定 AND 条件是否满足。

统一以下规则：

- term 规范化、大小写和空白处理；
- 日期时区和无效日期处理；
- 排序：相关性降序、时间降序、session/turn ID 作为稳定 tie-breaker；
- `matchCount` 表示本次扫描实际发现的匹配数，`matches.length` 表示本次返回数；
- 只有完成全部候选扫描时，`totalMatches` 才表示合并后的完整总数；预算中断时不得伪造该字段；
- partial 结果必须包含 `isComplete: false`、`truncationReason` 和 `nextCursor` 或未完成 session 列表；
- `limit` 在合并后执行，默认 10、最大 100；
- cluster 候选和精炼副作用也受独立上限控制；
- refined-only 结果增加 `source: 'refined-only'`，避免被误认为原文；
- 一致性保证仅覆盖 wire 存在时的同一内容权威；wire 缺失时只承诺 refined 已保留字段内的召回，不承诺与完整原文等价。

#### 增量索引的新鲜度

为 refined row 增加：

```text
extractor_version
source_size
source_mtime_ns
source_content_hash
refined_at
```

turn 行的 `source_content_hash` 用于判断该轮来源是否变化，session 进度表的 offset 用于增量读取；两者职责不同，不能互相替代。

另建 session 索引进度表：

```text
session_id
wire_identity
last_offset
last_complete_line_offset
last_size
last_mtime_ns
last_indexed_at
extractor_version
```

判断规则：

- wire 变大：从安全边界继续解析，并处理未写完的最后一行；
- wire 变小或身份变化：该 session 索引作废并重建；
- extractor 版本变化：后台逐步重建，不让新旧摘要静默混用；
- wire 删除：保留或删除 refined 必须遵循明确保留策略。

#### 搜索视图

新视图统一使用 `search-v2-<32 位小写十六进制随机 ID>`，完整查询参数保存在文件内容而不是拼进文件路径。旧 12 位 hash ID 继续按兼容格式读取和安全删除：

```json
{
  "schemaVersion": 1,
  "id": "search-v2-0123456789abcdef0123456789abcdef",
  "query": "sqlite cache",
  "filters": {
    "dateFrom": null,
    "dateTo": null,
    "limit": 10,
    "clusterGapSeconds": 90,
    "maxClusterSize": 15
  },
  "createdAt": "...",
  "clusters": []
}
```

建议新增 `save_view` 参数。为保持兼容可先默认 `true`，后续大版本再改为默认 `false`。决策守卫等高频只读场景应显式 `save_view: false`，避免检索自身制造大量状态。

### 6.4 CON-01/CON-02：跨进程写入和崩溃恢复

#### 短期文件写入

1. 工作区级锁覆盖完整的“读取—修改—写入—更新索引”过程，而不是只覆盖单次 `rename`。
2. 临时文件名包含 PID 和随机值，使用独占创建，失败时清理自己的临时文件。
3. 写入、flush、close 后再 rename；需要 durability 时增加文件和目录 fsync。
4. Windows 与 POSIX 分别验证 rename-over-existing、杀毒软件占用和崩溃残留。
5. 索引写入前重新读取磁盘最新版本，不能拿当前进程旧 cache 覆盖其他进程更新。
6. 锁文件必须包含拥有者、时间和 lease； stale lock 处理需要测试，不能简单按文件存在就永久等待。

可以评估成熟锁库，但引入依赖前应确认维护状态和 Windows 语义；不要自行实现一个看似完整但未经过崩溃测试的分布式锁。

#### 乐观并发

为 memory 增加单调递增 `revision`。写接口支持：

```json
{
  "key": "auth-flow",
  "folder": "memory/decisions",
  "content": "...",
  "expectedRevision": 7
}
```

不匹配时返回 `409 RevisionConflict` 和当前 revision，不静默覆盖。仪表盘编辑时携带读取到的 revision。

revision 不能只在 API 写入时递增。frontmatter 同时保存 `contentHash`，reconcile 检测到用户直接编辑 Markdown 后，必须在锁内提升 revision 并更新 hash；否则外部编辑会绕过 CAS。恢复旧文件或手工修改 frontmatter 时，以磁盘内容和 hash 为准，不信任调用方伪造的 revision。

#### 跨存储写入日志

跨 Markdown、JSON 和 SQLite 无法获得单一原子事务，建议使用工作区级 journal：

```text
prepare(operationId, expectedRevision)
  → write memory
  → rebuild/update index
  → update theme associations
  → mark committed
```

每条记录包含操作 ID、前后路径、revision、备份位置和状态。下次启动：

- committed：只做完整性校验；
- memory_written：继续更新派生数据；
- prepared：安全回滚或标记未完成；
- 无法恢复：隔离损坏文件并报告明确错误，不静默当成“未找到”。

#### SQLite

- 开启 WAL 和合理 busy timeout；
- 使用 `user_version` 管理迁移；
- `saveRefinedTurns` 只 UPSERT 输入行，不再读取整 session 后逐条 REPLACE；
- 写操作使用事务，读取 JSON 列时增加校验和损坏报告；
- MCP graceful shutdown 等待请求和 DB 关闭后再退出；
- 对锁冲突返回可重试错误，并记录无内容指标。

### 6.5 ID-01/LIFE-01：会话身份与仪表盘生命周期

#### 工作区和会话身份

工作区身份必须兼容宿主现有分桶，不能用 `realpath` 后的路径重新计算 bucket：

1. implicit workspace（`wd_`）沿用宿主的字面路径规范化：统一路径分隔符并移除末尾分隔符，保持 hash 输入与宿主字节兼容；显示路径保留原样。
2. 从宿主 `projects.json` 和 `session_index.jsonl` 建立 `wd_` / `wm_`、primary path、session ID 与存储目录的映射；managed workspace 的 primary path 改变时更新映射，不改变稳定 host workspace ID。
3. `realpath` 和 Windows 大小写规范化只用于别名比较与安全边界检查，不参与重新分桶，避免把已有记忆拆到另一个 workspace。
4. 会话发现同时覆盖 implicit 和 managed workspace；映射缺失或冲突时显式降级，不能猜测后静默关联。

当前 baseline MCP 初始化只提供宿主产品名和版本，不提供 session ID；同工作区会话复用 MCP 实例。因此 `KIMI_MEMORY_SESSION_ID` 只能作为手工或测试覆盖入口，不能宣称宿主会自动注入。当前 session 解析优先级为：

```text
宿主显式 session ID（需要宿主扩展，当前 baseline MCP 不提供）
  > 已验证的 projects/session index 一一映射
  > 手工或测试覆盖入口 KIMI_MEMORY_SESSION_ID
  > mtime 低置信度回退，并返回 identityAssumed: true
```

mtime 回退不应执行级联删除等破坏性操作。`findPreviousSession` 必须先知道当前 session，再按 session 创建时间和活跃时间排除当前项。

证据来源：`MoonshotAI/kimi-code` main 中 `apps/kimi-code` v2.6.3 的 workspace、stdio MCP 和 session index 实现，以及本机同版本进程与配置观测；详细记录见 `memory/knowledge/kimi-host-workspace-mcp-lifecycle.md`。

#### 仪表盘生命周期

短期保留多进程时：

- 运行文件包含 owner PID、lease 和 heartbeat；
- 复用方定期探测，而不是永久信任 `activeUrl`；
- owner 退出前尝试移交，或复用方发现失效后重新竞争；
- `open_memory_dashboard` 每次先验证实例，不直接打开缓存 URL。

长期由 daemon 独立拥有 HTTP server，MCP stdio 关闭不再决定仪表盘生命周期。

### 6.6 API-01/API-02/REF-01：统一写入服务与引用规则

#### key 和 folder

不要在不同入口选择“原始 key”或“清理后 key”。推荐：

- 对外 ID 严格校验并拒绝非法值，而不是静默替换；
- 显示名与文件 ID 分离；
- Unicode 统一 NFC；
- 禁止 `/`、反斜杠、NUL、控制字符、Windows 保留名和结尾点/空格；
- key 规范化只在应用服务边界执行一次；
- folder 只允许 `memory/`、`notes/` 等明确命名空间，系统目录不能通过 `remember` 任意写入。

这属于潜在不兼容变更，应先统计现有非法 key，提供迁移报告和兼容读取。PATCH 版本只能保证新写入路径一致，并保留旧 key 的读取、移动和安全删除能力；全面拒绝非法 key 应放入显式迁移版本或 MAJOR。若安全修复必须在 PATCH 中拒绝某类新输入，需要同时提供旧数据兼容路径和明确迁移说明。

#### 写入流程

`MemoryService.write` 统一负责：

1. 参数校验与规范化；
2. revision 检查；
3. Markdown 写入；
4. 索引更新；
5. themes 关联更新；
6. 返回实际规范化后的 ID、路径和 revision。

`saveEssence` 改为 `async` 并 `await indexDao.upsertEntry`，路由也等待服务完成；索引失败时返回失败或明确的降级状态，不能提前报告完整成功。

#### 引用完整性

memory frontmatter 增加稳定 `id`，theme 保存 `memoryId`，路径只作为可重建定位缓存。

- move/rename：ID 不变，更新路径缓存；
- delete：默认移动到 `trash/`，引用标记为 `deleted`，可恢复；
- folder rename：通过同一服务批量更新引用；
- 删除 refined turns：先统计搜索视图和主题引用；共享数据默认拒绝级联删除；
- 确实需要清理时，使用引用计数垃圾回收，而不是从某个视图直接删除共享行。

### 6.7 IDX-01/DATA-01/DATA-02：索引、序列化与迁移

#### 索引新鲜度

- 普通读取也应执行低成本新鲜度检查，或明确文档为“最终一致，必须 sync”；
- hash 至少包含相对路径、size、mtimeNs；高完整性场景增加内容 hash；
- 每次返回可附带 `indexState: fresh | stale | rebuilding | corrupt`；
- reconcile 失败不能静默继续使用旧数据而不标记；
- `IndexStore` 对完整 schema 做运行时校验，而不是只检查 `version` 和 `index`。

#### frontmatter

二选一：

1. 使用符合项目依赖策略的成熟 YAML 库；
2. 明确只支持严格 YAML 子集，并为字符串、数组、空数组、多行文本定义可逆格式。

必须补充以下往返测试：

- 单引号、双引号、冒号、`#`、反斜杠；
- 空 tags 与“未传 tags”的区别；
- Unicode 和换行；
- 以 `---` 开头的正文；
- 重复 key、非法 frontmatter 和损坏文件。

写入参数建议使用 `tags?: string[]` 的三态语义：`undefined` 保留，`[]` 清空，非空数组替换。MCP/HTTP handler 必须保留调用者是否显式提供 `tags` 的信息，不能先把缺失参数归一化成 `[]` 再交给存储层。

#### schema 与损坏恢复

所有持久化 JSON 增加 `schemaVersion`。迁移器必须：

- 备份原文件；
- 校验输入；
- 迁移到临时文件；
- 重新读取并校验；
- 原子替换；
- 保留回滚路径。

读取错误区分为 `NotFound`、`PermissionDenied`、`CorruptData`、`UnsupportedVersion`，不得全部吞成 `null`。

### 6.8 GOV-01/PRIV-01：长期记忆和隐私治理

#### 建议的记忆元数据

```yaml
schemaVersion: 1
id: mem_01J...
key: auth-flow
title: Auth Flow
tags: [decision, auth]
revision: 8
createdAt: ...
updatedAt: ...
supersedes: mem_01H...
sourceRefs:
  - type: session-turn
    sessionId: session_...
    turnId: 12
sensitivity: project
```

不必一次实现全部字段，优先顺序为：`id`、`revision`、来源、替代关系、保留状态。

#### 精要可追溯与回滚

`organize_memories` prepare 阶段返回：

- 当前 essence revision；
- 每条 memory 的 ID、revision 和 content hash；
- prepare token。

store 阶段提交 prepare token 和来源清单。若期间 memory 已变化，返回冲突并要求重新 prepare。精要持久化：

```yaml
revision: 12
generatedAt: ...
generator: agent
sources:
  - memoryId: mem_...
    revision: 8
    contentHash: sha256:...
```

旧精要保存在历史目录或版本库中，支持 diff 和回滚。`sources` 不能只回显给调用者而不保存。

#### 隐私与保留

- 精炼前提供可配置脱敏过滤器，默认不持久化完整工具结果；
- 明确说明正则脱敏不是绝对保证，不能声称彻底消除秘密；
- 提供工作区导出、备份、清除和保留期限；
- refined 在 wire 删除后是否保留必须由用户策略决定；
- 清除操作同时处理主题、搜索视图、SQLite、历史版本和回收站；
- “工作区彻底清除”默认只覆盖本服务拥有派生数据，不包括 Kimi Code 原始 `wire.jsonl`；原始 wire 需要宿主支持的独立删除能力，清除报告必须列出仍存在的宿主数据和残留范围；
- 日志和指标默认不记录记忆正文、token 或完整 query。

### 6.9 SETUP-01/HOST-01：可逆安装与低侵入协议

#### setup

新增安装 manifest，记录：

- 本工具写入的每个文件；
- 原始备份位置及 hash；
- 注入块版本；
- MCP entry 的原始值；
- skill 是否原本存在。

安装顺序：

```text
读取并校验全部目标
  → 生成完整执行计划/diff
  → 备份全部目标
  → 原子写入
  → 任一步失败则按逆序回滚
  → 写 manifest
```

undo 时：

- 只删除 manifest 证明由本工具创建的 entry；
- 当前内容已被用户修改时，不直接覆盖或删除，提示冲突；
- skill 原本存在时恢复原备份，而不是递归删除；
- 保留备份清理的独立命令。

#### 宿主协议

与 `docs/5.decision-guard-design-notes.md` 的低侵入原则一致，建议：

- MCP 不可用时明确提示一次并继续基本工作，不制造无法遵守的硬阻塞；
- 支持按工作区启用，而不是默认影响所有项目；
- 决策守卫采用低成本召回和提醒，不替 LLM 判断冲突；
- 高频只读检查使用 `save_view: false`、结果缓存和查询预算；
- 将“每次任何写操作都全量搜索”改为任务开始、架构敏感操作和上下文明显变化时触发。

### 6.10 PERF-01：性能、可靠性与可观测性

#### 资源和并发预算

建议先提供保守默认值，再通过基准调整：

| 参数                     |                    建议初始值 |
| ------------------------ | ----------------------------: |
| 单条 memory 正文         |                         1 MiB |
| 单次 HTTP JSON body      |                         1 MiB |
| `search_context.limit`   |             默认 10，最大 100 |
| 单次 cluster 候选 turns  |                      最大 100 |
| 单次保存搜索视图数       |     每次查询最多 1 个，可关闭 |
| 单请求 wire 扫描字节预算 | 可配置，超限返回 partial 状态 |
| HTTP 请求超时            |            读 10 秒，写 30 秒 |

超限必须显式返回 `partial/truncated`，不能静默少结果。

#### 性能实现

- 单次搜索只发现一次 session 列表并共享 Map；
- wire 使用增量 offset 和文件身份检测；
- 大文件解析、精炼和索引放到后台队列或 worker，避免同步阻塞 MCP；
- 仪表盘 GET 不应每次全量 reconcile，使用 watcher、版本检查或显式刷新；
- 支持 MCP 取消信号和超时；
- 大数据集使用分页，不通过 `detail: full` 无界返回。

#### 可观测性

增加不带正文的技术指标：

- request duration、error count、active requests；
- index rebuild count、stale entries、last reconcile duration；
- wire bytes/turns parsed、refined lag；
- lock wait/conflict、SQLite busy；
- dashboard owner 和 lease 状态；
- corrupt files quarantined。

提供健康状态：`ready / degraded / rebuilding / corrupt`。错误响应对用户使用稳定错误码，详细诊断写本地结构化日志。

### 6.11 WEB-01：前端渲染加固

- Markdown link 使用 URL 解析，默认仅允许 `https:`、`http:`、`mailto:` 和明确的相对链接；
- 拒绝 `javascript:`、`data:` 等未批准 scheme；
- 保留现有文本转义，不把未经清理的 HTML 交给 `innerHTML`；
- 增加 CSP，至少限制 `script-src 'self'`、`connect-src 'self'`、`object-src 'none'`、`base-uri 'none'`；
- 将前端 JS 纳入 lint，并增加 DOM/browser 测试；
- 在未完成浏览器验证前，不把该问题宣传为已证实 XSS。

由于认证 token 会进入浏览器 `sessionStorage`，URL scheme 白名单和基础 CSP 属于阶段 0 的最小安全依赖，不能全部推迟到长期治理阶段；完整 DOM、可访问性和交互测试可后续实施。

### 6.12 REL-01/TEST-01/DOC-01：交付体系

#### 发布

- 使用统一版本命令同步 `package.json`、lockfile 和 `src/version.ts`；
- 清洁检查同时覆盖 unstaged、staged 和 untracked；
- publish 前重新执行 `npm ci`、lint、typecheck、unit、integration、build；
- 执行 `npm pack --dry-run` 并检查实际包内容；
- 评估 npm provenance 和最小权限发布；
- 文档变更按 PATCH 规则处理，不手工修改 `src/version.ts`。

#### CI

建议矩阵：

- Ubuntu + Node 22/24；
- Windows + Node 22/24；
- 安全与并发专项可单独运行，避免普通 PR 过度耗时；
- 覆盖率关注关键分支，不追求无意义的 100% 行覆盖。

#### 文档

优先修正：

- `3-kv` 与 `v3-kv`、真实 meta 字段和 hash 算法；
- “下次访问自动 rebuild”的真实触发入口；
- refined 已迁移到 SQLite；
- 手动安装应使用 `assets/user-agents.md`；
- 隐私描述区分“没有直接读取敏感文件”和“可能处理 wire 中的敏感内容”；
- `CONTRIBUTING` 补齐 typecheck、unit、build 和完整验证顺序。

工具 schema 和持久化格式应尽量生成参考文档，减少手工漂移。

### 6.13 兼容性、数据迁移、外部编辑与降级恢复

#### 威胁模型边界

近期安全方案主要防御：

- 恶意网站通过浏览器访问 loopback 仪表盘；
- prompt injection 或错误 Agent 调用产生恶意工具参数；
- 多 MCP 进程并发和异常退出；
- 用户直接编辑 Markdown、JSON 或删除 wire 后造成的不一致。

默认不把“已经能以同一用户身份执行任意代码的恶意本地进程”视为可完全隔离对象，因为该进程通常已经能直接读取同一用户的记忆文件。`lstat + realpath` 只能降低意外符号链接逃逸，不能彻底消除检查与使用之间的竞态；若未来要防御该攻击者，需要独立的低权限服务账户、句柄级 no-follow/openat 语义和更严格的 IPC 授权，而不能仅靠路径字符串检查。

#### 迁移原则

任何持久化格式升级必须提供：

1. 旧版本真实数据 fixture，而不是只测试新造数据；
2. 默认 dry-run 的迁移报告，列出新增、修改、跳过、冲突和孤儿数据；
3. 迁移前完整备份及备份完整性校验；
4. 工作区锁内的原子迁移，迁移期间拒绝其他写进程；
5. 迁移后重新读取、schema 校验和抽样内容 hash 比对；
6. 明确的回滚版本和恢复步骤；
7. 用户可理解的失败报告，禁止把迁移失败当成空工作区。

#### memory ID 与主题 backfill

为现有 memory 增加稳定 ID 时：

- 首次迁移为每个文件生成随机 ID 并立即持久化，不能每次启动按路径重新生成；
- 建立 `legacy folder/key → memoryId` 映射，再迁移 theme 引用；
- 移动文件只更新路径缓存，不改变 ID；
- 遇到重复 ID 时不自动合并正文，生成冲突报告并分配新 ID；
- 找不到目标文件的主题引用保留为 `orphaned`，不得静默删除；
- 缺少 frontmatter 或文件损坏时进入人工处理清单；
- 迁移完成前同时保留 legacy 引用和新 ID，全部引用验证通过后再切换读取路径。

外部新建但没有 ID 的 Markdown 采用同样的按需 backfill 流程，避免只有升级时才能获得稳定身份。

#### refined SQLite 迁移

- 在事务中提升 `user_version`，新增列使用明确默认值或 `NULL`；
- 旧行的来源 hash、offset 和 extractor 版本统一标记为 `unknown/stale`；
- 新鲜度未知的旧行仍可参与 refined-only 降级召回，但不能阻止 raw 扫描；
- 后台重建按 session 分批提交，失败可续跑，不要求一次迁移全部历史；
- 不承诺新版本数据库可以直接被旧代码读取；需要降级时先恢复到迁移前备份；
- WAL、锁和迁移测试必须覆盖 Windows 上文件句柄未释放的情况。

#### 搜索视图和工具参数兼容

- legacy 12 位 hash ID 与 v2 32 位十六进制 ID 共用严格解析器；
- 旧视图不强制重写，读取时按 legacy schema 校验，保存新视图时才写 v2；
- `save_view` 等新可选参数缺省保持旧行为；
- 新增响应字段应保持向后兼容，旧字段只能在 MAJOR 中移除；
- `tags` 必须由 handler 区分未提供与显式空数组；
- 非法旧 key 保持只读/迁移能力，新输入的严格拒绝按版本计划逐步启用。

#### 外部 Markdown 编辑与 CAS

外部编辑是核心设计能力，不是异常路径。每条 memory 同时维护 `revision` 和 `contentHash`：

```text
API 读取：返回 revision + contentHash
外部编辑：文件内容变化，但调用方没有经过 MemoryService
reconcile：锁内检测 hash 变化 → revision + 1 → 更新索引和引用元数据
API 写入：校验 expectedRevision，再检查当前文件 hash
```

如果 API 写入前发现磁盘 hash 与读取快照不同，即使 revision 因旧数据缺失而相同，也必须返回冲突。迁移初期缺少 revision 的旧文件从 1 开始，但 hash 检测不能省略。

#### 部分失败和降级策略

- 索引失败：memory 已写入时返回 `degraded/index_stale`，后台可重建，不回滚用户正文；
- theme 更新失败：保留 memory 和 journal，标记关联未完成；
- SQLite 不可用：长期记忆 CRUD 可继续，上下文搜索明确降级为 raw-only 或 unavailable；
- daemon 不可用：MCP 返回明确连接错误，不允许静默开启多个非协调写者；
- 原始 wire 不存在：使用 refined-only，并标记来源和召回限制；
- 原始 wire 仍存在：不得因为 refined-only 数据存在而跳过 raw 新鲜度检查。

#### 清除与恢复报告

工作区清除报告至少分别列出：已删除的 memory、themes、search views、refined、历史版本、回收站，以及未删除的 Kimi Code 原始 wire。恢复操作必须恢复稳定 ID 和引用关系，不能只把 Markdown 文件放回原路径。

## 7. 文件级实施计划

| 模块       | 主要文件                                                                           | 建议改动                                                                  |
| ---------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| HTTP 安全  | `src/vis/server.ts`、新增 `src/vis/security.ts`                                    | token、Host/Origin、body limit、CORS 移除、统一错误                       |
| 浏览器引导 | `src/vis/auto-start.ts`、`src/server.ts`、`src/vis/static/api.js`                  | 私有运行文件、fragment 引导、Bearer、失效探测                             |
| 搜索视图   | `src/tools/context-tools.ts`、`src/vis/api.ts`、新增 repository                    | 严格 key、唯一 ID、统一删除、schema 校验                                  |
| 检索       | `src/context/wire-context.ts`、`src/tools/context-tools.ts`、`src/utils/search.ts` | 合并候选、统一语义、limit 后置、单次 session 发现                         |
| refined    | `src/refine/store.ts`、`src/refine/types.ts`、`src/refine/adapter.ts`              | 来源版本、迁移、UPSERT、WAL、busy timeout                                 |
| 文件原子性 | `src/utils/paths.ts`、新增工作区锁模块                                             | 唯一 tmp、跨进程锁、flush、清理与恢复                                     |
| 记忆写入   | `src/tools/memory-tools.ts`、`src/dao/memory-store.ts`、新增 `MemoryService`       | key 一次规范化、revision、统一事务流程                                    |
| 索引       | `src/dao/index-store.ts`、`src/dao/index-reconciler.ts`                            | 完整校验、新鲜度状态、锁内重读、增强 hash                                 |
| 主题引用   | `src/theme-manager.ts`、`src/tools/theme-tools.ts`                                 | 稳定 memory ID、引用检查、垃圾回收                                        |
| 精要       | `src/tools/system-tools.ts`、`src/vis/api.ts`                                      | await、revision、来源持久化、冲突与历史版本                               |
| 会话身份   | `src/config.ts`、`src/context/wire-context.ts`、新增宿主 workspace 映射模块        | 宿主兼容分桶、`wd_`/`wm_` 发现、projects/session index 映射、低置信度回退 |
| 生命周期   | `src/vis/auto-start.ts`、`src/server.ts`                                           | lease、owner 失效、关闭 DB、异步 graceful shutdown                        |
| 序列化     | `src/utils/frontmatter.ts`                                                         | 可逆格式、严格校验、空 tags 三态                                          |
| 数据迁移   | 新增 migration/backfill 模块及旧版本 fixtures                                      | ID 回填、schema 升级、外部 hash、dry-run、回滚                            |
| 安装       | `src/setup.ts`、`src/setup-cli.ts`                                                 | manifest、完整备份、冲突检测、回滚                                        |
| 宿主协议   | `assets/user-agents.md`                                                            | fail-open 降级、按工作区启用、低成本守卫                                  |
| 前端       | `src/vis/static/utils/markdown.js`、静态入口                                       | URL 白名单、CSP、lint 与 browser 测试                                     |
| 发布       | `scripts/release.mjs`、`.github/workflows/*.yml`                                   | lock 同步、完整清洁检查、验证和 pack 门禁                                 |
| 文档       | `docs/ARCHITECTURE.md`、README、贡献指南                                           | 与代码和真实数据格式对齐                                                  |

## 8. 测试与验收矩阵

| 场景                | 测试方法                        | 必须验证的结果                                           |
| ------------------- | ------------------------------- | -------------------------------------------------------- |
| 无 token API 请求   | HTTP 集成                       | 所有敏感 GET/POST/DELETE 返回 401                        |
| 恶意 Origin         | 浏览器或模拟预检                | 无可读 CORS 响应，写操作被拒绝                           |
| token 泄漏检查      | 日志与响应断言                  | query、日志、HTML 和工具结果无 token                     |
| 搜索视图路径穿越    | 参数化安全测试                  | 所有越界 key 返回 400，目标文件保持不变                  |
| 符号链接逃逸        | Windows/POSIX 分别测试          | 读写删除均拒绝越界 realpath                              |
| 旧 refined + 新 raw | 混合数据集成测试                | 两个匹配都返回，来源和 totalMatches 正确                 |
| wire 已删除         | refined-only 测试               | 明确标记降级来源，不伪装成原文                           |
| AND/OR 与排序       | wire 存在的两路径 golden corpus | 合并后匹配和稳定顺序一致；refined-only 单独验证降级召回  |
| partial 扫描        | 超预算多 session fixture        | `isComplete: false`，不返回伪造 totalMatches，游标可续扫 |
| limit 副作用        | 大批量 hits                     | 只处理允许数量的候选，不精炼全部 hits                    |
| 两进程不同 key 写入 | 真实多进程压力                  | 无丢失、无 JSON 损坏、无固定 tmp 冲突                    |
| 同 key 并发写       | revision CAS                    | 一个成功，另一个获得冲突，不静默覆盖                     |
| 写阶段崩溃          | fault injection                 | 重启可恢复或明确隔离，不静默丢数据                       |
| SQLite 锁竞争       | 多进程读写                      | busy 可重试，无永久等待和半事务                          |
| 同工作区并行会话    | 显式 session fixture            | current/previous 不串会话                                |
| 仪表盘 owner 退出   | 两进程生命周期测试              | 复用方探测、接管或重启，功能持续可用                     |
| 记忆移动/删除       | 主题集成测试                    | 无有效旧路径，恢复后引用可还原                           |
| 共享 refined 清理   | 多视图/主题引用                 | 不删除仍被引用的数据                                     |
| 精要并发整理        | prepare/store 冲突测试          | 来源变化时拒绝覆盖，可 diff/回滚                         |
| frontmatter 往返    | 属性/参数化测试                 | 特殊字符、空 tags、Unicode 不漂移                        |
| 外部 Markdown 编辑  | API 快照后直接改文件            | hash 冲突可见，reconcile 提升 revision，不静默覆盖       |
| v0.5.1 数据迁移     | 旧 store fixture + 故障注入     | ID/主题/refined 可回滚，孤儿和冲突有报告，旧行不伪装新鲜 |
| 新旧搜索视图 ID     | legacy/v2 参数化测试            | 两种合法 ID 可用，其他格式和越界路径全部拒绝             |
| setup 部分失败      | 故障注入                        | 全部回滚，用户原配置不变                                 |
| undo 用户修改       | 安装集成测试                    | 不删除非本工具拥有或已修改内容                           |
| 大语料性能          | 固定基准数据集                  | 延迟、内存、partial 状态满足已确认 SLO                   |

建议基准数据集至少包含：1,000 条 memory、100 个 session、10,000 个 turn、若干超大 wire 和损坏行。性能门槛应先测量当前基线，再由维护者确认；不要在缺少参考硬件和真实分布时凭空承诺毫秒级指标。

## 9. 分阶段实施与发布建议

工作量仅以一名熟悉项目的工程师粗略估算，不包含需求评审和跨平台发布等待时间。

### 阶段 0：安全止损，建议 v0.5.2

预计 2–4 天：

1. 认证完成前默认关闭自动仪表盘；如保留只读模式，也必须先认证。
2. 完成 token、Host/Origin、CORS 和 body limit，不复用旧版无认证实例。
3. 修复搜索视图路径穿越，兼容 legacy/v2 合法 ID。
4. 同步完成 URL scheme 白名单和基础 CSP，降低浏览器 token 被同源脚本读取的风险。
5. 增加安全回归测试。
6. 发布安全说明和升级指引。

完成门槛：SEC-01、SEC-02 的全部安全测试通过，正常仪表盘同源读写可用。

### 阶段 1：正确性热修复，建议 v0.5.3

预计 3–5 天：

1. 合并 refined/raw 候选，统一过滤、评分、limit 和 complete/partial 语义。
2. 在保留非法旧 key 兼容读取和迁移能力的前提下修复新写入路径，修复 `saveEssence` await 和空 tags 三态传递。
3. 新搜索视图使用 v2 ID，旧 ID 保持兼容，并提供 `save_view`。
4. 修复共享 refined 级联删除。
5. 修正关键文档漂移。

完成门槛：混合检索、写入路径和引用完整性测试通过，无既有数据丢失。

### 阶段 2：并发、身份和生命周期，建议 v0.6.0

预计 8–13 天：

1. 工作区锁、唯一 tmp、revision + contentHash CAS 和写入恢复。
2. SQLite WAL、busy timeout、migration 和精简 UPSERT。
3. memory ID、主题引用和旧搜索视图的兼容 backfill，覆盖外部 Markdown 编辑。
4. 保持宿主兼容的工作区分桶，覆盖 `wd_`/`wm_` 会话发现，建立 projects/session index 映射。
5. managed workspace primary 变更和路径别名只更新映射、不重新分桶；保留显式覆盖与 mtime 低置信度回退。
6. 仪表盘 lease/owner 失效处理。
7. setup manifest 和可逆安装。
8. Windows CI、多进程、旧数据迁移和故障注入测试。

完成门槛：并发、崩溃恢复、并行会话、owner 退出和 setup 回滚测试全部通过。

### 阶段 3：治理与规模化，按 MINOR 迭代

持续实施：

- 增量 wire 索引和后台任务；
- memory/essence 来源、修订和回滚；
- 回收站、导出、保留和隐私策略；
- 结构化错误、健康状态和性能指标；
- 完整浏览器交互和可访问性测试，强化 CSP；
- 评估并决定是否引入 workspace daemon。

全面拒绝非法旧 key、删除 legacy 工具字段或改变默认 `save_view` 行为应单独评估 MAJOR，不能混入上述 PATCH/MINOR。只有发生不兼容工具签名、存储格式或默认行为变更时，才按 MAJOR 处理；内部锁、向后兼容的索引升级和安全修复不应随意提升 MAJOR。

## 10. 总体完成标准

整改不能仅以“现有测试通过”为完成标准，至少应满足：

- **安全**：未认证和越界路径测试全部通过，默认配置不暴露敏感 API。
- **召回**：混合 refined/raw golden corpus 无已知漏检，语义和排序一致。
- **并发**：真实多进程写入无静默丢失，冲突可见，崩溃可恢复。
- **迁移**：v0.5.1 数据可备份、backfill、验证和回滚，外部 Markdown 编辑不会绕过冲突检测。
- **身份**：并行会话不会互相恢复错误上下文。
- **生命周期**：任一 MCP 进程退出不会破坏其他进程依赖的共享服务。
- **治理**：记忆和精要可以追踪来源、处理冲突和回滚；本服务派生数据可彻底清除，原始 wire 残留范围明确报告。
- **交付**：Windows 与 Linux 验证通过，发布包版本一致，文档与实现一致。
- **可运维**：锁冲突、索引落后、损坏文件和 refined lag 可诊断，且日志不泄露正文。

## 11. 最终优先级判断

如果只能选择三项立即实施，顺序应为：

1. **关闭无认证的仪表盘读写面，并修复路径穿越。**
2. **修复 refined/raw 合并检索，消除确定性漏检。**
3. **统一写入服务并建立跨进程一致性保护。**

daemon、语义搜索、embedding 和更复杂的记忆评分都不应排在这三项之前。当前最需要补的不是更多智能能力，而是让现有数据在浏览器、多进程和长期生命周期下仍然安全、完整、可恢复。
