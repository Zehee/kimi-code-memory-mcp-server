# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- add changelog generator script and populate Unreleased ([3914e63](https://github.com/Zehee/kimi-code-memory-mcp-server/commit/3914e63fc2fa87cf506c5bed7c44e91fc72ad332))

### Fixed
- **server**: shut down dashboard when stdio pipe closes ([805d300](https://github.com/Zehee/kimi-code-memory-mcp-server/commit/805d300a8b1a0ec5dd4f05096420a507927eb73a))

## [0.3.1] - 2026-07-18

### Fixed
- Dashboard now auto-reconciles `index.json` before every read endpoint, so memories written by the MCP server (or another process) appear immediately without a manual `/api/sync`.

## [0.3.0] - 2026-07-18

### Added
- GitHub Actions workflow to publish to npm on `v*` tag push.
- Improved integration-test cleanup: orphaned `node.exe` processes are killed and temporary directories are removed more reliably.

### Changed
- **BREAKING** Dashboard now auto-starts when the MCP server starts by default. Set `KIMI_MEMORY_AUTO_VIS=0` or `false` to disable.
- README sections updated with dashboard usage, environment variables, and manual launch commands.

### Removed
- **BREAKING** MCP tool `load_workspace_context` removed. Context resumption is now handled entirely by `bootstrap_workspace`.

### Changed
- **BREAKING** `bootstrap_workspace` resumes context from the most recent previous session only when the current session is brand new (turn count <= 1). On continued sessions (`kimi -c`, `kimi web`) it returns no conversation context to avoid duplicating host-loaded history; `essence`, `memoryIndexTree`, and `notesRefs` are always returned.

## [0.2.0] - 2026-06-25

### Added
- MCP tools: `delete_theme` and `delete_search_view` (with optional `deleteRefinedTurns` cascade).
- Visual dashboard: delete actions for themes and search views, read-only default for Markdown editors, Edit/Delete buttons in composer headers, scrollable Markdown preview, dynamic page title using workspace folder name, lightweight Markdown rendering.
- Frontend refactor: dashboard `app.js` split into ES modules (`state.js`, `api.js`, `utils/helpers.js`, `utils/markdown.js`).

### Changed
- Markdown documents in the dashboard now render in read-only mode by default; editing requires clicking the Edit button.
- Breadcrumbs root label now shows the actual workspace folder name.

## [0.1.2] - 2026-06-25

### Added
- MCP Prompts support: `memory-decision-check`, `memory-theme-trace`, `memory-session-summary`.
- MCP Resources support: `memory://<folder>/<key>`, `theme://<theme>`, `essence://essence`.
- LobeHub badge and green npm version badge in README.
- README sections documenting prompts and resources.

### Changed
- Code refactor: split tools/refine/DAO layers, shared utils, and unit tests.
- `search_context` output-size controls (`compact`/`normal`/`full`, `max_output_chars`).

## [0.1.0] - 2026-06-24

### Added
- Initial release of Kimi Code Memory MCP Server.
- Modular source structure (`src/tools`, `src/dao`, `src/context`, `src/utils`).
- Memory CRUD tools: `remember`, `recall`, `recall_recent`, `search`, `list`, `list_tags`, `delete`, `move`.
- Context recovery tools: `bootstrap_workspace`, `load_workspace_context`, `load_more_context`, `search_context`, `load_turn_context`.
- Theme tracing tools: `tag_theme`, `trace_theme`, `list_themes`, `refine_session_turns`.
- System tools: `organize_memories`, `sync_workspace_index`, `get_current_workspace`.
- Markdown + YAML frontmatter storage with rebuildable `index.json` v3-kv cache.
- ESLint + Prettier configuration.
- Basic integration tests.
- English and Chinese READMEs.
- GitHub issue and PR templates.
- CI workflow running tests and lint on pull requests.
- MCP server versioning rules: SemVer for repository version, runtime version synced from `package.json`, and a release workflow that includes real-instance validation.

## [0.1.1] - 2026-06-25

### Added
- `kimi-memory-setup` command for one-click Kimi Code CLI integration.
- `assets/user-agents.md` template injected into `~/.kimi-code/AGENTS.md` with a prominent bootstrap rule.
- Automatic skill installation to `~/.kimi-code/skills/memory-manage`.
- Automatic `kimi-memory` MCP server entry in `~/.kimi-code/mcp.json`.
- `--dry-run` and `--undo` options for the setup command.

### Changed
- `search_context` now returns refined summaries directly when the original `wire.jsonl` is missing.
- Improved `scripts/session-search-verify.mjs` with CLI/env args, safer parsing, and cleanup.
- Updated READMEs to reflect npm-published status and setup command.

[Unreleased]: https://github.com/Zehee/kimi-code-memory-mcp-server/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.3.1
[0.3.0]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.3.0
[0.2.0]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.2.0
[0.1.2]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.1.2
[0.1.1]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.1.1
[0.1.0]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.1.0
