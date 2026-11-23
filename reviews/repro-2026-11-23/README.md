# 复现脚本（2026-11-23 v0.6.0 源码审核）

对应文档：`reviews/2026-11-23-v0.6.0-source-review.zh-CN.md`。

在仓库根目录运行：`npx tsx reviews/repro-2026-11-23/<脚本>`（`.mjs` 用 `node`）。
脚本里的 `REPO` 是本机绝对路径，换机器要改。所有脚本都把 `MEMORY_STORE_ROOT` / `MEMORY_SESSIONS_ROOT`
指到临时目录，不读写任何真实存储。

## 证据来源

- **A 仓库源码**：直接驱动仓库 `src`，或用仓库 `dist/` 配临时存储隔离启动。只有这一类能作为源码结论的证据。
- **B host 的 wire**：只读 `~/.kimi-code/sessions/` 下由 Kimi Code CLI 写入的文件，只取结构元数据（事件类型、行数、时间戳），
  不输出任何对话内容。只用来量化 A 的结论在真实输入下的命中率。

| 脚本 | 来源 | 验证什么 |
| --- | --- | --- |
| `ws1-bg.mts` | A | U-01 在途 turn 冻结、U-04 删除的行复活、U-09 读取失败被吞、U-10 检查点写入遇锁、U-08 夹具形状 |
| `ws1-lock.mts` | A | U-07 busy 重试把主线程阻塞约 29 秒；U-10 检查点写入无重试 |
| `ws1-freshness.mts` | A | U-02 wire 变小不重建、U-03 extractor 版本变化不重建 |
| `ws2-meta.mts` | A | `metadataHash` 在 6 条写入路径上稳定；外部仅元数据修改可见于 CAS；U-13 `revisionsBumped` 口径 |
| `ws3-essence.mts` | A | essence 响应体、连续保存不嵌套 frontmatter、`sources` 保留、409 |
| `ws4-theme-api.mts` | A | U-11 一个畸形主题文件让主题列表整体失败 |
| `ws5-export.mts` | A | 导出重叠判定；U-12 旧目标不清理、junction 使导出中止 |
| `ws6-run.mjs` + `ws6-child.mts` | A | U-05 坏行让解析进程崩溃（每例一个子进程） |
| `selfaudit-built-crash.mts` | A | U-05 在仓库 `dist/server.js` 上的表现（需先 `npm run build`）；参数 `none` / `null` / `input-string` |
| `selfaudit-remember.mts` | A | U-16 正文以换行开头或含 CRLF 时 revision 立刻失效 |
| `selfaudit-barefolder.mts` | A | U-17 裸文件夹被接受，条目不进索引和导出 |
| `selfaudit-refined-migrate.mts` | A | 升级路径：合成的 v0.5.1 形态 refined 库被仓库代码迁移（schema 0→2、旧行保留并标记 unknown、损坏行仍被报告） |
| `selfaudit-discovery.mts` | B | 索引器能看到哪些 wire（19 个主 agent，8 个子 agent 不在列表） |
| `selfaudit-stats.mts` | B | U-01 的 turn 时长分布、U-06 的 lag 读数与同步读取成本（19 个主 agent wire） |
| `probe-wire3.mjs` | B | host wire 的事件形状（`turnId` 在 `event` 内且是字符串） |
| `probe-wire4.mjs` | B | `turn.prompt` 先于 `turn.ended` 落盘 |

参数化：`ws6-run.mjs` 无参数；`selfaudit-built-crash.mts` 见上；`selfaudit-stats.mts` 依赖本机是否存在 host wire，
没有时 `wiresSeenByIndexer` 为 0，此时数字无意义。
