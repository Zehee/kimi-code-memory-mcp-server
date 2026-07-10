# 功能依赖与运行流程图

> 基于 `src/` 当前实现（`package.json` v0.2.0）梳理。所有图均为 Mermaid，在 GitHub / VS Code Markdown 预览中可直接渲染。
>
> 阅读约定：
>
> - 实线箭头 `A --> B`：同步依赖或同步调用（A 依赖 / 调用 B）。
> - 虚线箭头 `A -.-> B`：异步、按需（dynamic import）或跨进程（stdio / HTTP）交互。
> - `{storeRoot}` 指 `~/.kimi-code-memory/<workspaceId>/`，可用 `MEMORY_STORE_ROOT` 覆盖。
> - `{sessionsRoot}` 指 `~/.kimi-code/sessions/`，可用 `MEMORY_SESSIONS_ROOT` / `KIMI_CODE_HOME` 覆盖。
> - 图中 `.md` 文件是**真相来源**；`index.json`、`refined.sqlite` 均为**可重建缓存**。

---

## 1. 功能依赖

### 1.1 分层架构（依赖方向自上而下）

```mermaid
flowchart TD
  subgraph L4["L4 入口层"]
    SERVER["server.ts<br/>MCP stdio 入口"]
    VISCLI["vis-cli.ts<br/>仪表盘 CLI"]
    SETUPCLI["setup-cli.ts → setup.ts<br/>一键配置"]
  end

  subgraph L3["L3 协议适配层"]
    TOOLS["tools/<br/>22 个 MCP 工具"]
    PROMPTS["prompts/<br/>3 个 MCP Prompt"]
    RES["resources/<br/>memory/theme/essence URI"]
    VIS["vis/<br/>server · api · auto-start"]
  end

  subgraph L2["L2 领域管理层"]
    TM["ThemeManager<br/>theme → turns/memories"]
    RM["RefinedManager<br/>精炼轮次编排"]
  end

  subgraph L1["L1 数据访问层"]
    DAO["dao/index.ts (facade)<br/>+ memory-store.ts"]
    CTX["context/wire-context.ts<br/>wire.jsonl 解析/搜索"]
    REFINE["refine/<br/>store · extractor · adapter"]
  end

  subgraph L0["L0 基础设施层"]
    UTILS["utils/<br/>paths · validation · frontmatter ·<br/>file-helpers · search · date ·<br/>mutex · action-entities · headings · tools"]
  end

  EXT["外部依赖<br/>@modelcontextprotocol/sdk · better-sqlite3 · hono · open<br/>+ 文件系统 / Kimi Code wire.jsonl"]

  L4 --> L3 --> L2 --> L1 --> L0
  SERVER -.stdio.-> EXT
  VIS -.HTTP.-> EXT
  DAO --> EXT
  REFINE --> EXT
  CTX --> EXT
```

要点：

- 严格分层：上层只依赖下层，**不反向依赖**。`tools/` 不直接 `import` 具体存储细节，全部走 `Ctx` 注入的 `indexDao` / `memoryStore` / `themeManager` / `refinedManager`。
- `Ctx`（见 `src/types.ts`）是唯一的跨层上下文对象，由 `server.ts` 在启动期一次性装配，随后透传给 `createTools(ctx)` / `createResources(ctx)` / `vis`。
- `refined-manager` 与 `refine/` 是「门面 + 实现」关系：`RefinedManager` 保留对外 API 并持有写互斥锁，真正提取与持久化在 `refine/extractor.ts` 与 `refine/store.ts`。
- `dao/index.ts` 同样是 facade，内部拆成 `IndexStore` / `IndexReconciler` / `IndexCatalog` / `MemoryIndexTreeRenderer` 四个协作类（见 1.2）。

### 1.2 模块依赖关系（细化到文件 / 类）

```mermaid
graph LR
  SERVER["server.ts"]
  VISCLI["vis-cli.ts"]

  SERVER --> CFG["config.ts"]
  SERVER --> PATHS["utils/paths.ts"]
  SERVER --> IDX["dao/index.ts<br/>IndexDao"]
  SERVER --> MS["dao/memory-store.ts<br/>MemoryStore"]
  SERVER --> TM["theme-manager.ts"]
  SERVER --> RM["refined-manager.ts"]
  SERVER --> TI["tools/index.ts<br/>createTools"]
  SERVER --> PR["prompts/index.ts"]
  SERVER --> RS["resources/index.ts"]
  SERVER --> VA["vis/auto-start.ts"]

  VISCLI --> CFG
  VISCLI --> IDX
  VISCLI --> MS
  VISCLI --> TM
  VISCLI --> RM
  VISCLI --> VS["vis/server.ts"]

  TI --> MT["tools/memory-tools.ts"]
  TI --> CT["tools/context-tools.ts"]
  TI --> TT["tools/theme-tools.ts"]
  TI --> ST["tools/system-tools.ts"]

  MT --> MS
  MT --> IDX
  MT --> TM
  CT --> WIRE["context/wire-context.ts"]
  CT --> RM
  TT --> TM
  TT --> RM
  TT --> WIRE
  ST --> IDX
  ST --> CT
  ST --> WIRE
  ST --> VA

  subgraph DAO["dao/index.ts 内部（facade 组合）"]
    IS["IndexStore<br/>Mutex + 持久化 + v1→v3 迁移"]
    IR["IndexReconciler<br/>扫描重建 / structureHash"]
    IC["IndexCatalog<br/>查询 / 树数据"]
    IMR["MemoryIndexTreeRenderer<br/>渲染 [new] 标记"]
  end
  IDX --> IS
  IDX --> IR
  IDX --> IC
  IDX --> IMR

  subgraph RF["refine/ 内部"]
    RS2["store.ts<br/>better-sqlite3"]
    EX["extractor.ts<br/>提取实体/动作"]
    AD["adapter.ts<br/>row ↔ turn"]
  end
  RM --> RS2
  RM --> EX
  RS2 --> AD

  WIRE --> SEARCH["utils/search.ts<br/>scoreText / extractSnippet"]
  WIRE --> PATHS
  WIRE --> CFG
  RM -.type only.-> WIRE

  VA --> VS
  VS --> VAPI["vis/api.ts"]
  VAPI --> IDX
  VAPI --> TM
  VAPI --> RM
```

要点：

- `server.ts` 与 `vis-cli.ts` 都装配同一套 `Ctx`；区别只在传输层（stdio MCP vs. 独立 Hono HTTP）。
- `tools/system-tools.ts` 复用 `tools/context-tools.ts` 导出的 `buildWorkspaceContext`，避免 `bootstrap_workspace` 与 `load_workspace_context` 两份实现漂移。
- `dao/index.ts` 的所有写操作都通过 `IndexStore.runExclusive`（`utils/mutex.ts`）串行化，保证 `index.json` 读写互斥。
- `context/wire-context.ts` 仅在类型层面引用 `RefinedManager`（搜索时可合并已精炼结果），运行期由工具层注入实例，避免循环依赖。

### 1.3 MCP 工具 → 后端能力依赖

```mermaid
flowchart LR
  subgraph MEM["memory-tools"]
    M1["remember"]
    M2["recall"]
    M3["search"]
    M4["list / list_tags"]
    M5["delete / move"]
  end

  subgraph CTXT["context-tools"]
    C1["load_workspace_context"]
    C2["load_more_context"]
    C3["search_context"]
    C4["load_turn_context"]
    C5["list/delete_search_view"]
  end

  subgraph THM["theme-tools"]
    T1["tag_theme"]
    T2["trace_theme"]
    T3["list/delete_theme"]
    T4["refine_session_turns"]
  end

  subgraph SYS["system-tools"]
    S1["bootstrap_workspace"]
    S2["organize_memories"]
    S3["sync_workspace_index"]
    S4["get_current_workspace"]
    S5["open_memory_dashboard"]
  end

  MS["MemoryStore<br/>.md 读写"]
  IDX["IndexDao<br/>index.json 缓存"]
  TM["ThemeManager<br/>themes/*.json"]
  RM["RefinedManager<br/>refined.sqlite"]
  WIRE["wire-context<br/>sessions 只读来源"]
  VIS["vis/auto-start<br/>仪表盘"]

  M1 --> MS
  M1 --> IDX
  M1 --> TM
  M2 --> MS
  M2 --> IDX
  M3 --> IDX
  M3 --> MS
  M4 --> IDX
  M5 --> MS
  M5 --> IDX

  C1 --> WIRE
  C2 --> WIRE
  C3 --> WIRE
  C3 --> RM
  C4 --> WIRE
  C5 --> RM

  T1 --> WIRE
  T1 --> TM
  T1 --> MS
  T2 --> TM
  T2 --> RM
  T2 --> WIRE
  T3 --> TM
  T4 --> WIRE
  T4 --> RM

  S1 --> IDX
  S1 --> WIRE
  S1 --> MS
  S2 --> IDX
  S2 --> MS
  S3 --> IDX
  S5 --> VIS
```

每个工具的具体后端触点在 **第 2 节运行流程** 中展开；下表是速查（✓ = 直接读 / 写该组件）：

| 工具 | MemoryStore | IndexDao | ThemeManager | RefinedManager | wire-context | vis |
|------|:-----------:|:--------:|:------------:|:--------------:|:------------:|:---:|
| remember | ✓ 写 | ✓ 写 | ✓ 可选 | | | |
| recall | ✓ 读 | ✓ 写 | | | | |
| search | ✓ 读（兜底） | ✓ 读 | | | | |
| list / list_tags | | ✓ 读 | | | | |
| delete / move | ✓ 写 | ✓ 写 | | | | |
| load_workspace_context | | | | | ✓ 读 | |
| load_more_context | | | | | ✓ 读 | |
| search_context | | | | ✓ 读/写 | ✓ 读 | |
| load_turn_context | | | | | ✓ 读 | |
| list/delete_search_view | | | | ✓ 删（可选级联） | | |
| tag_theme | ✓ 读 | | ✓ 写 | | ✓ 读 | |
| trace_theme | | | ✓ 读 | ✓ 读 | ✓ 读 | |
| list/delete_theme | | | ✓ 读/写 | | | |
| refine_session_turns | | | | ✓ 写 | ✓ 读 | |
| bootstrap_workspace | ✓ 读 | ✓ 写 | | | ✓ 读 | |
| organize_memories | ✓ 读/写 | ✓ 写 | | | | |
| sync_workspace_index | | ✓ 写 | | | | |
| get_current_workspace | | | | | | |
| open_memory_dashboard | | | | | | ✓ |

### 1.4 存储布局与数据所有权

```mermaid
flowchart TD
  subgraph ROOT["{storeRoot}  =  ~/.kimi-code-memory/<workspaceId>/"]
    MEMD["memory/<folder>/<key>.md<br/>真相来源 · 人可读 · git 友好"]
    ESS["essence/essence.md<br/>工作区精要 ≤15KB"]
    NOTES["notes/*.md<br/>临时速记（不进 essence）"]
    IDXF["index.json (v3-kv)<br/>元数据缓存 · 可重建"]
    THD["themes/<theme>.json<br/>theme → turn/memory 引用"]
    SVD["searches/search-<md5>.json<br/>搜索视图 · 只存引用"]
    RFD["refined/<sessionId>.jsonl + refined.sqlite<br/>轮次级原子摘要"]
  end

  SRC["{sessionsRoot}/<ws>/<session>/wire.jsonl<br/>Kimi Code 会话线 · 只读来源"]

  MEMD -.重建.-> IDXF
  SRC -.解析/搜索.-> RFD
  SRC -.tag_theme 引用.-> THD
  MEMD -.remember themes.-> THD
  SRC -.search_context.-> SVD
  SVD -.级联删除(可选).-> RFD
  MEMD --> ESS
```

核心不变量：

- **`.md` 优先**：`index.json` 只是 `memory/`、`essence/`、`notes/` 的元数据缓存（title / tags / folder comment / structureHash）。任何不一致都可通过 `sync_workspace_index` 从文件系统重建。
- **`wire.jsonl` 只读**：本服务器从不改写 Kimi Code 的会话线（AGENTS.md 明令禁止）；`refined/`、`themes/`、`searches/` 只持有对 turn 的**引用**（`sessionId + turnId`），不复制正文。
- **主题与搜索视图只存引用**：删除 theme 或 search view 不会删除被引用的 memory / refined turn；`delete_search_view` 仅在显式 `deleteRefinedTurns=true` 时才级联清理精炼轮次。

---

## 2. 运行流程

### 2.1 服务器启动（`server.ts`）

```mermaid
sequenceDiagram
  autonumber
  participant CLI as Kimi Code CLI
  participant S as server 模块装载期
  participant M as main 函数
  participant MCP as MCP Server
  participant VIS as vis auto-start

  CLI ->> S: 以 stdio 启动进程
  Note over S: 模块顶层同步执行
  S ->> S: 计算 cwd 与 workspaceId
  S ->> S: 计算 storeRoot 路径
  S ->> S: 创建 memory notes essence themes refined 目录
  S ->> S: 实例化 IndexDao MemoryStore ThemeManager RefinedManager
  S ->> S: 装配 Ctx 并创建 tools 与 resources
  S ->> MCP: 创建 Server 并声明 tools prompts resources 能力
  S ->> MCP: 注册六个处理器 ListTools CallTool ListPrompts GetPrompt ListResources ReadResource

  CLI ->> M: 调用 main
  M ->> MCP: 连接 StdioServerTransport
  M ->> VIS: maybeStartVisServer
  alt KIMI_MEMORY_AUTO_VIS 为 1 且端口可用
    VIS -->> M: 返回已启动与 url
    M ->> M: 动态打开浏览器 并 stderr 打印 url
  else 未开启或失败
    VIS -->> M: 返回未启动或 error
  end
  Note over M: 注册 SIGINT 与 SIGTERM 以停止仪表盘并退出 main 抛错时写 stderr 并以 1 退出
```

要点：

- 所有**可能失败或耗时的装配**（目录创建、DAO 构造、工具注册）都在模块顶层同步完成；进入 `main()` 时只剩「连接传输层 + 可选仪表盘」。
- `workspaceId` 由 `computeWorkspaceId(cwd)` 派生，保证同一工作区跨会话落到同一 `{storeRoot}`。
- MCP 能力声明同时打开 `tools` / `prompts` / `resources`；`resources.subscribe` 关闭（静态列表）。

### 2.2 MCP 工具调用分发（通用骨架）

```mermaid
sequenceDiagram
  autonumber
  participant C as MCP Client
  participant H as CallTool 处理器
  participant D as tools dispatch
  participant HD as adaptHandler
  participant CTX as Ctx 上下文
  participant R as toolResult

  C ->> H: CallTool 请求 name 与 arguments
  H ->> D: dispatch name 与 arguments
  D ->> D: 按 name 查找 handler
  alt name 不存在
    D -->> H: 返回 Unknown tool 错误
  else 存在
    D ->> HD: 调用 handler
    HD ->> CTX: 读写 MemoryStore IndexDao ThemeManager RefinedManager wire-context
    CTX -->> HD: 返回数据
    HD ->> R: 包装为 toolResult
    R -->> D: 返回 content 与 isError
    alt handler 抛异常
      HD --x D: 抛出异常
      D ->> R: 捕获并返回 success false 错误
    end
    D -->> H: 返回 ToolResult
  end
  H -->> C: JSON 响应 任何异常都兜底为 isError 文本
```

要点：

- 双层兜底：`dispatch` 内 `try/catch` 把 handler 异常变成 `{success:false,error}`；`server.ts` 外层再 `try/catch`，确保**任何工具异常都不会拖垮 stdio 连接**。
- `adaptHandler` 统一把 `args` 校验/返回包装成 MCP `content` 形态；handler 内部只返回普通对象，由 `toolResult` 序列化为 `JSON.stringify(..., null, 2)`。

### 2.3 `remember` 写记忆

```mermaid
flowchart TD
  A["入参 key/folder/tags/themes/content"] --> B{"key 合法?"}
  B -- 否 --> E1["返回 isError: Missing key"]
  B -- 是 --> C["sanitizeFolder（默认 memory）<br/>sanitizeKey"]
  C --> D{"folder 合法?"}
  D -- 否 --> E2["返回 isError: Invalid folder"]
  D -- 是 --> F["memoryStore.write(folder,key,content,tags)<br/>生成/合并 frontmatter<br/>保留 createdAt，刷新 updatedAt<br/>atomicWriteFile 写 .md"]
  F --> G["indexDao.upsertEntry(filePath)<br/>runExclusive → 重建 entry →<br/>补齐各级 folder comment →<br/>meta.structureHash=null → saveIndex"]
  G --> H{"themes 非空?"}
  H -- 是 --> I["逐个 themeManager.addThemeAssociation<br/>（写 themes/&lt;theme&gt;.json）"]
  H -- 否 --> J["返回 success + filePath/folder/key/themes"]
  I --> J
```

要点：

- 重写已存在 key 时，`MemoryStore.write` 会**保留原 `createdAt` 与 `title`、合并 `tags`**，仅刷新 `updatedAt`，避免覆盖式丢失元数据。
- `upsertEntry` 通过 `IndexStore.runExclusive` 串行化，并顺手为路径上每一级目录写入 folder entry（无 comment 时用 `FALLBACK_FOLDER_COMMENTS`）。

### 2.4 `recall` / `search` / `list` 读取路径

```mermaid
flowchart TD
  subgraph RECALL["recall"]
    R1["sanitize 后 memoryStore.read"] --> R2{"命中?"}
    R2 -- 否 --> R3["found:false"]
    R2 -- 是 --> R4["indexDao.upsertEntry(读时顺手刷新缓存)"] --> R5["found:true + content/tags/时间戳"]
  end

  subgraph SEARCH["search（大小写不敏感）"]
    S1["indexDao.getIndex() 遍历 *.md entry"] --> S2{"title 或 key 含 query?"}
    S2 -- 是 --> S3["收录，matches=[title]"]
    S2 -- 否 --> S4["safeParseFile 读 body"] --> S5{"body 含 query?"}
    S5 -- 是 --> S6["取命中行前 3 条(≤200字) 收录"]
    S5 -- 否 --> S7["跳过"]
  end

  subgraph LIST["list / list_tags"]
    L1["遍历 index entry → folder/tag 过滤"] --> L2["fileStats 取 updatedAt/size，按 updatedAt 倒序"]
    L2 --> L3{"带 limit?"}
    L3 -- 是 --> L4["前 N 条追加 body 前 400 字 preview"]
    L3 -- 否 --> L5["返回全量 items"]
  end
```

要点：

- `search` 走「**索引优先、正文兜底**」：先用 `index.json` 的 title/key 命中，未命中才回源读 `.md` body，兼顾速度与召回。
- `recall` 在读取时**反向刷新索引**（`upsertEntry`），使手工编辑过的 `.md` 也能在下次读取后回到缓存。

### 2.5 `bootstrap_workspace` 会话启动恢复

```mermaid
sequenceDiagram
  autonumber
  participant H as handleBootstrapWorkspace
  participant IDX as IndexDao
  participant BC as buildWorkspaceContext
  participant W as wire-context
  participant FS as storeRoot

  H ->> IDX: reconcileIndex 启动即对齐索引与文件
  H ->> BC: buildWorkspaceContext 传入 detailed 与 summary 轮数
  BC ->> W: getCurrentSessionWirePath
  alt 找到当前 session wire
    BC ->> W: parseWireFile 得 turns 与 compactionSummaries
    BC ->> W: buildContextWindow 取详细轮与摘要轮
    BC -->> H: 返回 recentContext
  else 无 wire
    BC -->> H: recentContext 为 null
  end
  H ->> FS: 读取 essence 文件
  H ->> W: loadMcpConfig 取 recentChangeLimit
  Note over H: 若当前 session 已有轮次且未 force 则清空详细轮并标记 skipped 避免与宿主已注入上下文重复
  H ->> IDX: buildMemoryIndexTree 并标记 new
  H ->> IDX: listRefs notes
  H -->> H: 返回 workspace recentContext essence memoryIndexTree notesRefs 五件套
```

要点：

- 返回的「五件套」正好对应 AGENTS.md 启动协议要求内化的 `essence` / `memoryIndexTree` / `recentContext` / `notesRefs`。
- **去重保护**：当宿主（`kimi web` / `kimi -c`）已经把本会话轮次装进上下文时，`bootstrap_workspace` 默认不再回灌详细轮，除非 `force:true`。

### 2.6 `search_context` 跨会话搜索 + 聚簇 + 按需精炼（核心）

```mermaid
flowchart TD
  P0["解析参数<br/>cluster_gap=90s · max_cluster_size=15<br/>detail=normal · 预算≈6000 字符"] --> P1["searchWireContext(query)<br/>遍历 findAllWorkspaceSessions() 的每条 wire<br/>scoreText 打分 → date_from/to + limit 过滤<br/>→ matches + hits + skippedSessionIds"]

  P1 --> G["按 sessionId 分组 hits"]
  G --> SESS{"对每个命中 session"}
  SESS --> W1["parseWireFile(session wire)"]
  W1 --> W2["refinedManager.loadRefinedTurns → existingIds"]
  W2 --> W3["groupHitsIntoBlocks：相邻 turnId 合并为 block"]
  W3 --> BLK{"对每个 block"}
  BLK --> EXP["expandCluster<br/>从最左/最右命中按 ≤90s 时间窗<br/>向前后扩展；occupied 去重；≤max_cluster_size"]
  EXP --> MEM["簇内每个 member：若不在 existingIds，则加入 sessionToRefine"]
  MEM --> BLK
  BLK -- 完成 --> SESS
  SESS -- 全部 session 完成 --> RF["按 session 批量：refineTurn →<br/>refinedManager.saveRefinedTurns（Mutex→SQLite）<br/>累加 refinedCount"]
  RF --> SV["saveSearchView<br/>md5(归一化 query) → searches/search-&lt;hash&gt;.json<br/>只存 clusters 引用，不存正文"]
  SV --> OUT{"detail?"}
  OUT -- compact --> O1["仅返回 matches 引用 + clusters 计数（无正文/无 members）"]
  OUT -- normal --> O2["截断 user/agent 文本 + members →<br/>trimOutputToBudget：按分数从低丢 matches/clusters，<br/>仍超限则剥离 members"]
  OUT -- full --> O3["不裁剪，返回完整文本与全部 members"]
  O1 --> RET["返回 {query,totalMatches,refinedCount,<br/>clusterGapSeconds,maxClusterSize,<br/>skippedSessions, matches, clusters}"]
  O2 --> RET
  O3 --> RET
```

要点：

- **聚簇是 search_context 的灵魂**：相邻命中先并 block，再按时间窗（默认 90s）向两端扩张成「簇」，一簇代表一段连续讨论；`max_cluster_size`（默认 15）防止长讨论爆上下文。
- **按需精炼**：只精炼「簇内且尚未精炼」的 turn，并按 session 批量写库，避免反复保存；精炼结果后续可被 `trace_theme` / `load_turn_context` 复用。
- **预算保护**：normal 模式先把输出压到 `max_output_chars`（默认 6000），再不够就剥 members；`compact` 不返回正文，`full` 关闭预算。
- **搜索视图**以 query 的归一化 md5 命名，稳定可复用；它是后续 `tag_theme` 挂载候选集的来源（见 AGENTS.md 主题追溯流程）。

### 2.7 `tag_theme` / `trace_theme` 主题追溯

```mermaid
flowchart TD
  subgraph TAG["tag_theme"]
    A1["入参 theme + (sessionId+turnId | memoryKey)"] --> A2{"引用类型?"}
    A2 -- turn --> A3["findAllWorkspaceSessions 找 session →<br/>parseWireFile 验证 turnId 存在"]
    A2 -- memory --> A4["sanitizeFolder/Key → fs.existsSync(.md) →<br/>safeParseFile 取 title"]
    A3 --> A5{"验证通过?"}
    A4 --> A5
    A5 -- 否 --> AX["isError: Session/Turn/Memory not found"]
    A5 -- 是 --> A6["themeManager.addThemeAssociation<br/>Mutex 内：loadTheme（不存在则新建）→<br/>按 (sessionId,turnId) / (folder,key) 去重 push →<br/>tmp+rename 原子写 themes/&lt;theme&gt;.json"]
  end

  subgraph TRACE["trace_theme"]
    B1["themeManager.loadTheme"] --> B2{"存在?"}
    B2 -- 否 --> BX["found:false"]
    B2 -- 是 --> B3["turns/memories 按 timestamp 升序"]
    B3 --> B4{"includeTurnContent?"}
    B4 -- 否 --> B5["仅返回引用 + 计数"]
    B4 -- 是 --> B6["对每个 turn：<br/>refinedManager.loadRefinedTurns 取 refined，<br/>parseWireFile 取 content；单条失败降级为 error 字段"]
    B6 --> B5
  end
```

要点：

- `tag_theme` **强校验引用存在性**，杜绝把不存在的 turn/memory 挂进主题；AGENTS.md 进一步要求「内容 genuinely belongs to the theme」才挂载，禁止仅凭关键词。
- `trace_theme` 默认只返引用（轻量），需要正文时再 `includeTurnContent=true`，并优先用精炼摘要，缺失时回源 wire，单条失败不中断整体。

### 2.8 `refine_session_turns` 精炼轮次

```mermaid
flowchart TD
  R0["入参 sessionId? / turnIds? / limit?"] --> R1{"指定 sessionId?"}
  R1 -- 是 --> R2["findAllWorkspaceSessions 定位 session"]
  R1 -- 否 --> R3["getCurrentSessionWirePath() 取当前 session"]
  R2 --> R4{"找到?"}
  R3 --> R4
  R4 -- 否 --> RX["isError: Session/No wire not found"]
  R4 -- 是 --> R5["parseWireFile → turns"]
  R5 --> R6["按 turnIds 白名单过滤；再按 limit 取最近 N 条"]
  R6 --> R7["逐 turn → refinedManager.refineTurn<br/>（extractor 提取实体/动作/分类/摘要）"]
  R7 --> R8["refinedManager.saveRefinedTurns<br/>Mutex.runExclusive → RefinedStore(better-sqlite3) 批量写入"]
  R8 --> R9["返回 {success, sessionId, refinedCount,<br/>outputPath=refined.sqlite, sample 前 2 条}"]
```

要点：

- `RefinedManager` 仅做编排与加锁；真正抽取在 `refine/extractor.ts`（动作实体 `utils/action-entities.ts`、分类 `utils/headings.ts`），行列映射在 `refine/adapter.ts`。
- 写入走 `Mutex.runExclusive`，与 `search_context` 的批量精炼、删除级联共享同一把锁，保证 SQLite 写互斥。

### 2.9 `organize_memories` 两阶段整理精要

```mermaid
flowchart TD
  O0["调用 organize_memories"] --> O1{"带 content?"}
  O1 -- 否（prepare 阶段） --> P1["loadEssenceFile 读 essence/essence.md（若有）"]
  P1 --> P2["遍历 index 中 memory/* entry →<br/>safeParseFile 逐条取 title/tags/body/size"]
  P2 --> P3["返回 stage=prepare：<br/>existingEssence + pendingMemories[] +<br/>rules（整理规则）+ outputPath + maxRecommendedBytes"]
  O1 -- 是（store 阶段） --> S1["Buffer.byteLength(content) → withinLimit?"]
  S1 --> S2["stringifyFrontmatter + content →<br/>atomicWriteFile essence/essence.md"]
  S2 --> S3["indexDao.upsertEntry(essencePath)"]
  S3 --> S4["返回 stage=store：contentSize + sizeHint<br/>（&gt;15KB 仅提示不阻断）+ sources"]
```

要点：

- 工具本身**不生成精要内容**：prepare 阶段把「旧精要 + 全部 memory 正文 + 整理规则」交给 Agent，由 Agent 完成归类/去重/排序/剔除后，再以 `content` 回调 store 阶段落盘。
- 规则要求关键结论用 `> 来源：memory/<folder>/key` 在行内标注；超过 15KB 只给 `sizeHint`，不阻止保存。

### 2.10 `sync_workspace_index` / `reconcileIndex` 索引重建

```mermaid
flowchart TD
  Y0["sync_workspace_index / bootstrap / 启动"] --> Y1["IndexDao.reconcileIndex<br/>→ IndexStore.runExclusive 串行化"]
  Y1 --> Y2["IndexReconciler 扫描文件系统全部 .md"]
  Y2 --> Y3["逐文件 buildEntryValueFromFile<br/>（解析 frontmatter → title/tags）"]
  Y3 --> Y4["与 index.json 对比：新增 / 更新 / 删除 / folder comment"]
  Y4 --> Y5["重建 index + 重算 structureHash + saveIndex"]
  Y5 --> Y6["返回 ReconcileResult（增删改统计）"]
  Y6 --> Y7["扫描 index 中目录 entry，列出 foldersNeedingComment"]
```

要点：

- `index.json` 是**可重建缓存**：真相永远在 `.md`。`reconcileIndex` 用 `structureHash` 快速判断结构是否变化，写操作（remember/move/delete/upsertEntry）会把 `structureHash` 置 `null` 触发下次重算。
- `folderComments` 入参可批量设置目录说明；缺失 comment 的目录会出现在 `foldersNeedingComment` 中提醒补齐。

### 2.11 可视化仪表盘启动

```mermaid
flowchart TD
  subgraph A["路径 A：随 MCP 启动"]
    A1["server main()"] --> A2{"KIMI_MEMORY_AUTO_VIS=1?"}
    A2 -- 是 --> A3["maybeStartVisServer(ctx) →<br/>startVisServer(hono) 监听 127.0.0.1"]
    A3 --> A4{"启动成功?"}
    A4 -- 是 --> A5["stderr 打印 url + 动态 import('open') 开浏览器"]
    A4 -- 否 --> A6["stderr 打印失败原因（不影响 MCP）"]
  end

  subgraph B["路径 B：会话中按需"]
    B1["工具 open_memory_dashboard"] --> B2{"getVisUrl() 已有?"}
    B2 -- 是 --> B3["复用既有 url"]
    B2 -- 否 --> B4["maybeStartVisServer(ctx)"]
    B4 --> B5{"成功?"}
    B5 -- 否 --> B6["isError: Failed to start dashboard"]
    B5 -- 是 --> B3
    B3 --> B7["动态 import('open')(url) → 返回 success+url"]
  end

  subgraph C["独立 CLI"]
    C1["vis-cli.ts / npx kimi-memory-vis"] --> C2["装配同一 Ctx"] --> C3["startVisServer(server.ts) 常驻"]
  end

  A5 -.信号.-> D["SIGINT/SIGTERM → stopVisServer() → exit(0)"]
  A6 -.信号.-> D
```

要点：

- 三条入口（随 MCP 自启 / 会话内工具 / 独立 CLI）共用 `vis/server.ts`（Hono）+ `vis/api.ts`（数据装配），读取同一 `{storeRoot}`。
- 仪表盘进程**与 MCP 进程解耦**：自启失败只写 stderr，不影响 stdio 工具通道；`open` 动态导入，无图形环境时静默忽略。

---

## 3. 速查：模块职责一句话

| 层 | 模块 | 职责 |
|----|------|------|
| L4 | `server.ts` | 装配 `Ctx`、注册 6 个 MCP handler、连接 stdio、可选自启仪表盘 |
| L4 | `vis-cli.ts` / `vis/server.ts` / `vis/api.ts` | 独立 Hono 仪表盘，复用 `Ctx` 读取 `{storeRoot}` |
| L4 | `setup.ts` / `setup-cli.ts` | 向 `~/.kimi-code` 注入 AGENTS.md 协议、Skill、`mcp.json` |
| L3 | `tools/*` | 22 个工具的 schema + handler + dispatch |
| L3 | `prompts/index.ts` | 3 个 MCP Prompt（决策检查 / 主题追溯 / 会话总结） |
| L3 | `resources/index.ts` | `memory://`、`theme://`、`essence://` 资源读取 |
| L2 | `theme-manager.ts` | `themes/<theme>.json` 关联存储（Mutex + 原子写） |
| L2 | `refined-manager.ts` | 精炼轮次编排 + 写互斥；门面 |
| L1 | `dao/index.ts` + 4 协作类 | `index.json` v3-kv 缓存的持久化/重建/查询/渲染 |
| L1 | `dao/memory-store.ts` | Markdown + frontmatter 读写移（safeResolve + atomicWriteFile） |
| L1 | `context/wire-context.ts` | 发现/解析/搜索 Kimi Code `wire.jsonl`，构建上下文窗口 |
| L1 | `refine/store.ts` / `extractor.ts` / `adapter.ts` | 精炼轮次的 SQLite 持久化、实体动作抽取、行列映射 |
| L0 | `utils/*` | 路径/校验/frontmatter/文件/搜索/日期/互斥锁等纯函数与工具 |

> 维护提示：新增工具时，在对应 `tools/*-tools.ts` 增加 `ToolDefinition` 即可被 `tools/index.ts` 自动聚合；新增持久化只读来源时优先复用 `wire-context` / `dao`，新增可变状态务必走现有 `Mutex` / `runExclusive` 路径，避免与 `index.json`、`refined.sqlite`、`themes/*.json` 的并发写冲突。
