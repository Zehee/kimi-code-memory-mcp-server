# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/Zehee/kimi-code-memory-mcp-server/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.1.1
[0.1.0]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.1.0
