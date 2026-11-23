# 贡献指南

感谢你对 Kimi Code Memory MCP Server 的兴趣！

## 开发环境

```bash
git clone https://github.com/Zehee/kimi-code-memory-mcp-server.git
cd kimi-code-memory-mcp-server
npm install
```

## 脚本

| 脚本                                | 用途                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                 | 类型检查源码与测试                                                                                |
| `npm run lint`                      | 运行 ESLint                                                                                       |
| `npm run lint:fix`                  | 自动修复 ESLint 问题                                                                              |
| `npm run test:unit`                 | 运行单元测试                                                                                      |
| `npm test`                          | 运行 MCP、检索、存储、安装与仪表盘集成测试                                                        |
| `npm run build`                     | 同步版本号、编译到 `dist/` 并复制仪表盘静态资源                                                   |
| `npm run format`                    | 用 Prettier 格式化代码                                                                            |
| `npm start`                         | 启动 MCP 服务器                                                                                   |
| `npx tsx tests/setup.test.ts`       | 只运行安装 / 卸载测试（也已纳入 `npm test`）                                                      |
| `node scripts/release.mjs --verify` | 运行完整发布门禁（工作区清洁、版本一致、typecheck、lint、单元、集成、构建、`npm pack --dry-run`） |

## 提交 Pull Request 前

按下面的顺序执行检查——这与发布门禁使用的顺序一致：

1. **类型检查**

   ```bash
   npm run typecheck
   ```

2. **运行 lint**

   ```bash
   npm run lint
   ```

3. **单元测试**

   ```bash
   npm run test:unit
   ```

4. **集成测试**

   ```bash
   npm test
   ```

5. **构建**

   ```bash
   npm run build
   ```

6. **格式化代码**

   ```bash
   npm run format
   ```

7. **更新文档**（如果你的改动影响用户可见行为）

8. **更新 `CHANGELOG.md`**（在 `Unreleased` 区域添加条目）

> 发布流程要求工作区完全干净：`git status --porcelain` 必须为空——未暂存、已暂存和未跟踪的文件都会阻止发布。

## 代码风格

- 使用 ESLint 和 Prettier。提交前运行 `npm run format`。
- 公共函数使用 JSDoc 注释。
- 保持函数小而聚焦。
- 优先给出明确的错误信息，而不是静默失败。

## 提交信息

使用清晰、描述性的提交信息，英文或中文均可。例如：

```text
feat: add search_context tool test
docs: update README quick start example
fix: handle missing frontmatter in recall
```

## 报告 Bug

使用 [Bug 报告 issue 模板](../.github/ISSUE_TEMPLATE/bug_report.md)。

请包含：

- Node.js 版本
- 操作系统
- 复现步骤
- 预期行为 vs 实际行为
- 相关日志或错误信息

## 提议新功能

使用 [功能请求 issue 模板](../.github/ISSUE_TEMPLATE/feature_request.md)。

请说明：

- 想解决什么问题
- 你的方案
- 为什么它符合项目的设计原则

## 许可证

通过贡献代码，你同意你的贡献采用 MIT 许可证。
