# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- prepare v0.6.0 ([749a83e](https://github.com/Zehee/kimi-code-memory-mcp-server/commit/749a83e4de7bd65ed5a243e3a0ee35d7dc54c56e))

## [0.6.0] - 2026-11-24

Implements the remediation plan from `docs/architecture-audit-and-remediation.zh-CN.md` (phases 0–2).

### Added
- **security**: authenticated dashboard — every `/api/*` route requires a bearer token (constant-time compare), Host/Origin validation against DNS rebinding and CSRF, 1 MiB body limit, unified 401/403/413/415 errors, loopback-only bind; the token reaches the browser only via a URL fragment and is persisted solely in a `0600` per-workspace runtime file that sibling MCP processes use for authenticated reuse (`SEC-01`)
- **security**: strict search-view key parser (`search-<12hex>` legacy read/delete, `search-v2-<32hex>` for new views), symlink/realpath escape rejection and shared delete service with reference counting across views and themes (`SEC-02`, `REF-01`)
- **search**: merged refined/raw retrieval — refined hits no longer hide unrefined wire matches; unified AND semantics, date filters, scoring and stable ordering; limit applied after merge; `totalMatches` only on complete scans; partial scans report `isComplete`/`truncationReason`/`nextCursor`; `source: 'refined-only'` marking; single session discovery per request (`RET-01`/`RET-02`)
- **concurrency**: cross-process workspace file lock (lease + heartbeat + stale reclaim + re-entrancy) around every read-modify-write flow (remember/delete/move/restore, index mutations, themes, essence, search views, dashboard writes) (`CON-01`)
- **concurrency**: write journal (`<store>/.journal`) with prepared/committed states, startup recovery and fault-injection hooks (`KIMI_MEMORY_FAULT`) for crash-recovery tests (`CON-02`)
- **memory**: soft delete — entries move into `trash/` with `deletedAt`/`deletedFrom` provenance; new `restore_memory` tool and `POST /api/restore` endpoint preserve the stable id/revision and reactivate theme references
- **memory**: stable ids, revisions and body hashes maintained across external Markdown edits (reconcile bumps the revision so CAS cannot be bypassed); `expectedRevision` optimistic concurrency on `remember` and the dashboard
- **memory**: frontmatter `schemaVersion`; NFC key normalization; control characters rejected instead of silently replaced
- **organize_memories**: prepare/store with `prepareToken` — conflicts when the essence or memories changed after prepare; per-store revision, `generatedAt`, `generator` and encoded source references persisted; previous essence versions archived under `essence/history/` (last 10)
- **sessions**: host-compatible workspace discovery covering `wd_*` and `wm_*` workspaces via `projects.json`/`session_index.jsonl`; `identityAssumed`/`identitySource` surfaced in bootstrap output with an explicit warning for mtime-guessed sessions
- **lifecycle**: dashboard lease/heartbeat with authenticated reuse probes, stale takeover and owner-exit safety (`LIFE-01`)
- **refine**: SQLite WAL + busy timeout, `user_version` migrations, per-row UPSERT, transactions, corrupt-row reporting and graceful shutdown (`CON-02`)
- **privacy**: `KIMI_MEMORY_REDACT_PATTERNS` best-effort redaction applied before refined turns are persisted; `kimi-memory-setup --purge-derived-data` removes themes/search views/refined SQLite/essence history/trash/journal/runtime with a report that counts the untouched host wires (`PRIV-01`)
- **observability**: content-free metrics registry wired into HTTP/mcp/lock/wire/SQLite subsystems; authenticated `/api/health` (ok/degraded/rebuilding/corrupt + index state) and `/api/metrics`; HTTP request timeouts (read 10s / write 30s, 504 on overrun)
- **cancellation**: MCP request abort signals propagate into `search_context` — a cancelled scan returns a partial result (`truncationReason: 'request-cancelled'`) and skips refinement side effects
- **background**: incremental wire indexer drains the refined lag in bounded, cancellable ticks (`refined_lag_turns` gauge; disable with `KIMI_MEMORY_BG_INDEX=0`)
- **governance**: `remember` accepts `sourceRefs` / `supersedes` / `sensitivity` (public|workspace|private) recorded in frontmatter; memory bodies hard-capped at 1 MiB
- **maintenance**: new `rollback_essence` tool + `POST /api/essence/rollback` (history-aware, revision-monotonic); setup CLI gains `--doctor` (dry-run migration report), `--export-data`, `--backup-data`, `--prune-data --older-than <days>`
- **hardening**: unified storage error taxonomy (`not_found` / `permission_denied` / `corrupt_data` / `unsupported_version`) with errno mapping and stable HTTP codes; Windows reserved device names rejected; index structure hash upgraded to nanosecond mtimes; `indexState` reports `stale` (2s memoized freshness probe) and `rebuilding`; theme files stamped with `schemaVersion`
- **consistency**: dashboard write endpoints share the same write journal as the MCP tools (`runJournaled` helper — remember/delete/restore/essence all journaled from both surfaces); dashboard essence saves gain revision + history parity with `organize_memories`; `POST /api/sync` reconciles the write journal like `sync_workspace_index`
- **isolation**: the background indexer uses the workspace-scoped session discovery (it can no longer refine another workspace's sessions); reconcile scans and structure hashes skip symbolic links instead of following them; memory reads refuse symlink escapes; theme files written by a newer schema version are never read or overwritten by an older binary
- **setup**: install manifest with ownership hashes, full pre-modify backups, conflict detection, rollback on failure and scoped installs (`--scope workspace` writes the protocol into the project's own `AGENTS.md`) (`SETUP-01`, `HOST-01`)
- **protocol**: `assets/user-agents.md` rewritten — fail-open fallback when the MCP server is unavailable, `save_view: false` for high-frequency guard checks, deletion/restore and prepare-token guidance
- **frontend**: Markdown URL scheme whitelist (http/https/mailto/relative) and CSP headers; dashboard JS added to lint scope (`WEB-01`)
- **tests**: security (per-route 401 sweep, token-leak checks), concurrency (cross-process CAS, SQLite contention), crash recovery (journal fault injection), migration (v0.5.1 legacy fixtures), frontmatter round-trips and a baseline benchmark (`npm run bench`)
- **tests**: functional-audit regressions for exact essence bodies, essence CAS and source preservation, overlapping exports, invalid wire timestamps, frontmatter-only revisions, malformed themes and workspace-scoped session counts
- **ci**: Windows + Linux matrix on Node 22/24 (`TEST-01`)

### Changed
- **release**: clean-tree check includes untracked files, lockfile/version consistency gate, `npm pack --dry-run` content check (`REL-01`); the release helper accepts an already-bumped current version when its tag does not exist yet
- **ci**: add the Dashboard security suite and real built-instance MCP verification to both release gates and CI, closing the previous verification-coverage gap
- **dependencies**: upgrade production dependencies and transitive packages to resolve all reported production vulnerabilities, including `@modelcontextprotocol/sdk` 1.32.2, `hono` 4.13.19 and `@hono/node-server` 2.1.9
- **dependencies**: remove the unused `ts-migrate` development dependency and refresh vulnerable development-only transitive dependencies
- **docs**: search logic, architecture and flow charts aligned with the implemented behavior (`DOC-01`)
- **background indexing**: reuse discovered session descriptors, persist size/mtime/extractor checkpoints and refresh rows from per-turn source hashes so unchanged wires are skipped without freezing completed or rewritten turns
- **lag metrics**: reuse one read-only SQLite connection per lag measurement instead of opening a connection for every session
- **dashboard reads**: limit automatic index reconciliation to index-backed routes; health, metrics and refined-only endpoints no longer scan the Markdown corpus

### Fixed
- search view keys could previously delete JSON files outside `searches/`
- `saveEssence` now awaits the index update and reports `degraded: index_stale` instead of premature success (`API-02`)
- search view saves/deletes and refined cascades run under the workspace lock
- theme references no longer stay valid after a memory is deleted; legacy path-only references are backfilled with the stable id

### Fixed (initial review round, `reviews/2026-11-19-v0.6.0-remediation-code-review.zh-CN.md`)
- **R-01 — identity backfill locking**: read-path identity backfill no longer writes outside the workspace lock; backfills are deferred and re-read under the lock, and persistence failures are counted (`identity_persist_failed`)
- **R-02 — partial-search cursor**: stop at the budget boundary so resume pages do not duplicate sessions; permanently skip sessions larger than the whole budget so the cursor cannot stall
- **R-03 — deleted theme references**: theme timelines no longer render a reused path's new content for a deleted reference; non-active references and id mismatches render as missing placeholders
- **R-04 — recursive folder deletion**: soft-delete every memory into the trash instead of permanently hard-deleting it, making recursive deletion restorable
- **R-05 — move source-removal failure**: retry source removal and roll back the destination on failure instead of silently creating two authoritative files with one id; fault-injection coverage verifies rollback and clean retry
- **R-06 — Dashboard claim race**: run the Dashboard claim sequence under a dedicated cross-process lock and verify runtime-file ownership before removal
- **R-07 — Dashboard creation CAS**: send `expectedRevision: 0` for brand-new files so concurrent creations conflict visibly instead of overwriting
- **R-08 — Dashboard essence journal**: journal Dashboard essence saves exactly like the MCP `organize_memories` flow, including revision and history
- **R-09 — purge host-wire count**: use workspace-scoped session discovery instead of a directory-name guess when reporting remaining host wires
- **restore route ambiguity**: move the unreachable `/restore` suffix route, which was swallowed by the greedy folder capture and could create a bogus file, to dedicated `POST /api/restore`
- **built-instance verification**: add `tests/verify-built-instance.mts` to exercise built `dist/server.js` as a real MCP process (handshake, CAS conflict, trash/restore and search)
- **Kimi Code cold start**: mark the generated MCP entry as `deferred` and teach the startup protocol to load `bootstrap_workspace` through `select_tools`, so memory bootstrap is not lost when the initial tool snapshot omits MCP tools

### Fixed (follow-up review rounds)
- **R-06 standalone lifecycle**: put standalone Dashboard discovery, claim and runtime writes under the same `vis-runtime-claim` lock as auto-start; reject a second live standalone owner and remove the lock-free stale-runtime deletion
- **R-06 runtime-removal TOCTOU**: perform ownership verification and runtime deletion atomically under the claim lock on every close path; skip removal while another claim is in progress or the recorded owner differs
- **R-06 heartbeat TOCTOU**: refresh runtime heartbeats under the claim lock only after PID and token verification, preventing an old owner from overwriting or stealing a replacement owner's record
- **R-06 close cleanup**: make runtime cleanup best-effort and always close the HTTP listener in `finally`, so lock I/O failures cannot leave the Dashboard port occupied
- **restore trash-removal failure**: roll back an already restored destination when its trash copy cannot be removed, preserving a valid retry instead of leaving duplicate ids and a permanently failing restore
- **move crash recovery**: reconcile theme reference locations by stable memory id, so recovery after an interrupted move updates folder/key/title and clears stale orphaned state
- **corrupt journal reporting**: distinguish invalid JSON, unsupported schema versions and unknown states; retain corrupt files and expose them through recovery results, `sync_workspace_index` and `POST /api/sync`
- **corrupt journal consumers**: report each corrupt journal entry on server startup and in `--doctor`, including file/reason details and a pending manual-inspection action
- **live lock-owner leases**: never reclaim a lock solely because its lease expired while the owner process remains alive; waiting callers fail safely with `LockTimeoutError`, while dead-owner and metadata-free stale locks remain recoverable
- **duplicate memory ids**: report both conflicting paths, return `synced: false`, exclude duplicate ids from automatic location updates and leave theme references unchanged instead of silently retargeting them
- **journal retention**: prune only committed journal entries by age; retain prepared and failed entries as recovery signals regardless of age
- **force reinstall backups**: when setup is about to overwrite user-modified MCP or skill content, back up the current state and update the manifest so `--undo` restores that version rather than the original installation backup
- **failed essence rollback**: discard journal entries for validation failures that performed no mutation instead of marking them committed
- **delete confirmation text**: update English and Chinese confirmations to describe recoverable soft deletion and state that non-memory files remain in place during recursive deletion
- **duplicate-id clean checkpoint**: do not persist a clean structure hash after duplicate-id or other scan errors, forcing subsequent reconciles to rescan and report the conflict until resolved
- **unsuccessful journal reconcile**: treat a callback result of `synced: false` as recovery failure; mark entries failed and retain them for retry on MCP sync, HTTP sync and server startup instead of deleting them
- **theme-update clean checkpoint**: perform orphaned-reference marking and theme-location updates before saving the clean structure hash, so a failed derived update is reported and retried on the next reconcile
- **concurrent stale-lock reclaim**: serialize stale-owner inspection and removal with a dedicated reclaim mutex, preventing concurrent waiters from deleting a replacement lock and entering overlapping critical sections
- **corrupt Markdown checkpoint**: include corrupt files in reconcile errors and withhold the clean structure hash, so every later reconcile reports them until the files are fixed or removed
- **bootstrap index issues**: return `indexIssues { state, errors, corruptFiles, revisionsBumped }` from `bootstrap_workspace` instead of discarding reconcile failures

### Fixed (adversarial self-review)
- **D1 — worker-thread move retry**: tolerate `Atomics.wait` being unavailable in worker threads without bypassing destination rollback or leaving source/destination duplicates
- **D2 — non-memory folder contents**: after recursively soft-deleting Markdown memories, remove only empty directories; preserve attachments and all non-Markdown files instead of recursively deleting them
- **D3 — essence rollback journal**: wrap `rollback_essence` file, history and index mutations in the same prepared/committed journal protocol as other essence writes
- **D4 — essence history pruning**: sort history by numeric revision rather than lexicographic filename, preventing revision 10+ from causing newer versions to be pruned before older ones
- **D5 — internal response fields**: strip internal journal markers from Dashboard delete/restore responses instead of exposing implementation-only fields
- **D6 — theme memory counts**: exclude deleted references from Dashboard `memoryCount` so the count reflects active associations
- **D7 — SQLite busy retries**: retry refined-turn saves and deletes after busy timeouts with two bounded exponential-backoff attempts and retry/exhaustion metrics, instead of surfacing transient cross-process contention as an unhandled failure

### Fixed (final storage and concurrency hardening)
- **storage symlink escapes**: reject file and intermediate-directory symlink escapes before soft deletion
- **repeated deletion**: retain a distinct trash copy for each deletion of the same key and restore the newest copy first
- **stale-lock claims**: guard claims against live replacement owners and recover orphaned claims without deleting newly created locks
- **atomic heartbeat replacement**: prevent lock-heartbeat renewal from replacing or corrupting a newer owner's claim
- **purge claim safety**: include active lock claims in purge safety checks so cleanup cannot invalidate an in-progress claim

### Fixed (full functional audit)
- **essence response body**: the workspace endpoint now returns only the Markdown body and a separate `essenceRevision`; Dashboard edits no longer nest the previous frontmatter into the next saved body
- **essence CAS**: Dashboard saves send `expectedRevision`, stale editors receive HTTP 409, and the on-disk essence remains unchanged after a rejected write
- **essence provenance**: Dashboard edits preserve existing `sources` frontmatter instead of dropping organize-time source references
- **export overlap**: reject export destinations that equal or overlap a source tree, preventing recursive `export/export/...` copying; store-root self-export is also rejected
- **wire timestamp robustness**: invalid event timestamps degrade to missing metadata instead of throwing an uncaught `RangeError` from the readline callback
- **frontmatter-only external edits**: persist a `metadataHash` alongside the body hash so title, tags and other metadata changes bump revision and remain visible to CAS
- **theme structure validation**: malformed but syntactically valid theme JSON raises `corrupt_data` and cannot be silently replaced by a blank association
- **workspace session statistics**: Dashboard counts sessions discovered for the current workspace rather than top-level directories belonging to every workspace
- **background checkpoint precision**: persist nanosecond mtimes as exact strings and read SQLite integers explicitly as BigInt, preventing `ERR_OUT_OF_RANGE` from disabling unchanged-wire progress checks

### Fixed (release readiness audit)
- **in-flight turn freshness**: store a per-turn source hash and refresh an existing refined row when the agent answer, tool calls or other source content arrive after the first indexing pass
- **wire rewind and rewrite recovery**: compare the current turn set and source hashes, update changed rows and delete orphaned rows after a complete stable snapshot instead of leaving vanished content searchable
- **extractor upgrades**: rebuild rows whose extractor version differs from the current version instead of stamping the session checkpoint with a version that its rows do not have
- **index state read failures**: stop converting a failed refined-state query into an empty turn set, preventing unintended full-session rewrites and surfacing the error through background metrics
- **append-only incremental parsing**: persist complete-line byte offsets and parse only newly appended turns when safe; updates to existing turns, shrinkage and incomplete state fall back to a full snapshot
- **wire event validation**: skip null, scalar, array and malformed event shapes, including non-array `turn.prompt.input`, instead of crashing the MCP process from a readline callback
- **memory write normalization**: normalize CRLF and leading blank lines before hashing and writing memory bodies so an immediate `expectedRevision` follow-up write no longer conflicts with the revision just returned
- **folder containment**: map bare folder names under `memory/` at both the tool and storage boundaries so new entries cannot bypass indexing, export or backup
- **SQLite event-loop responsiveness**: reduce the busy timeout and retry window from roughly 29 seconds to about 2.5 seconds under sustained contention, with typed retryable errors
- **checkpoint busy handling**: route session-progress writes through the same mutex and busy retry as refined rows, and normalize `BEGIN IMMEDIATE` busy errors for retry
- **exact lag measurement**: count actual wire turns instead of estimating with lines or bytes, reuse valid checkpoints and parse uncached wires asynchronously instead of synchronously reading whole files
- **refined deletion semantics**: document that `deleteRefinedTurns` invalidates the current cache and that the background indexer rebuilds missing rows, rather than claiming a permanent purge
- **theme list resilience**: isolate a malformed theme as a corrupt list item with a visible Dashboard badge instead of failing the entire theme list
- **export mirror consistency**: remove stale destination entries on re-export, including categories whose source disappeared
- **export link safety**: skip source links and remove destination links instead of following them, preventing junction failures and accidental copying or overwriting outside the export trees
- **revision metrics**: count `revisionsBumped` only when the revision actually increases, excluding identity and metadata backfill
- **Dashboard essence retention**: prune Dashboard-save history to the newest ten revisions, matching organize and rollback behavior
- **Dashboard conflict presentation**: show a localized, actionable message for HTTP 409 essence conflicts instead of only the raw response string
- **release verification ordering**: pull and rebase before the final gates so newly synchronized changes are verified before the tag is created
- **current-version release date**: refresh the CHANGELOG heading date when releasing an already-bumped current version
- **architecture documentation**: document the new background, journal, maintenance and metrics modules, index-backed Dashboard reads, real freshness/offset behavior and export link rules

### Fixed (independent deep re-audit)
- **incremental prefix integrity**: store a SHA-256 hash of the raw wire prefix in each checkpoint and verify it before append-only parsing; an early-turn rewrite followed by an append now falls back to a full snapshot instead of freezing the old row behind a fresh checkpoint, and legacy checkpoints without a prefix hash are revalidated instead of trusted
- **export root-link containment**: reject linked destination roots and linked nearest existing ancestors (including nonexistent targets beneath a linked parent), skip source category-root links and never follow linked `index.json` sources or destinations, closing the remaining export escape paths without rejecting normal system path aliases
- **stale-row lag accounting**: count missing rows, changed source hashes and outdated extractor versions as lag, and use the zero-lag checkpoint shortcut only when all rows are fresh
- **alias-aware export overlap**: resolve source and destination real paths through existing ancestors before copying, preventing a path alias from hiding source/destination overlap and recursing into the export itself
- **manual refinement provenance**: `refine_session_turns` now records the current wire size, nanosecond mtime and per-turn source hash, so a manual refresh no longer forces an unnecessary background rewrite

## [0.5.1] - 2026-11-18

### Added
- **vis**: Chinese/English UI switching for dashboard ([6c29dba](https://github.com/Zehee/kimi-code-memory-mcp-server/commit/6c29dba2322d786c833acabfff6eb82d85735862))

### Changed
- **readme**: refresh badges, quickstart, dashboard singleton docs, project structure and stale references ([480fa7b](https://github.com/Zehee/kimi-code-memory-mcp-server/commit/480fa7ba2ef2cef8b559b6be8c5317b40a3bd147))
- **readme**: centered header with banner, quickstart and demo section ([33c2a4d](https://github.com/Zehee/kimi-code-memory-mcp-server/commit/33c2a4d36cb075866b7a8d43a68588fc29968e2f))

### Fixed
- **vis**: reuse a per-workspace dashboard singleton so startup opens only one browser window ([00cb28a](https://github.com/Zehee/kimi-code-memory-mcp-server/commit/00cb28ae7aad1cc6304f2b73c388ba2eaef22835))

## [0.5.0] - 2026-09-15

### Added
- **dashboard**: Chinese/English UI switching — one-click toggle in the topbar and a language selector in Settings; follows the browser language by default, persisted in localStorage
- **docs**: add an Upgrading section to README/README.en (`npm i -g …@latest` + `kimi-memory-setup --force` + restart `kimi web`)

## [0.4.2] - 2026-08-18

### Changed
- add troubleshooting section and align manual mcp.json examples ([7277a5d](https://github.com/Zehee/kimi-code-memory-mcp-server/commit/7277a5d1b2a6bafbeae0e7f2de6c681c48b23859))

## [0.4.1] - 2026-08-18

### Changed
- **dashboard**: render GFM pipe tables (header/separator/body, `:--`/`--:`/`:-:` alignment, inline formatting inside cells) in essence and memory content
- **dashboard**: the sidebar menu item and page title now show the real workspace directory name (derived from `cwd`) instead of the generic "Workspace" label
- test on Node 22/24, drop 18/20 (node:sqlite requires >= 22.13) ([1b19e7f](https://github.com/Zehee/kimi-code-memory-mcp-server/commit/1b19e7f453fdcbfec2d21f318bf477e36579ca39))

### Fixed
- **setup**: generate the `mcp.json` entry with the absolute path of the running Node binary and the package's `dist/server.js` instead of `npx -y kimi-code-memory-mcp-server`, which failed with `spawn npx ENOENT` under clients whose process environment lacks npm's bin dir (e.g. the native Windows `kimi` binary)
- **server**: the vis dashboard now binds its port directly and retries the next port on `EADDRINUSE` instead of probe-then-bind, and late server errors are caught — a port race between multiple workspaces' MCP instances no longer crashes the whole stdio server
- **setup**: add `startupTimeoutMs: 120000` to the generated `mcp.json` entry ([fe46e85](https://github.com/Zehee/kimi-code-memory-mcp-server/commit/fe46e85))

## [0.4.0] - 2026-08-12

### Changed
- **BREAKING** Migrated refined-turn storage from `better-sqlite3` to Node's built-in `node:sqlite`. Minimum Node.js version is now 22.13; installs no longer require native compilation.
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


[0.3.1]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.3.1
[0.3.0]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.3.0
[0.2.0]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.2.0
[0.1.2]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.1.2
[0.1.1]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.1.1
[0.1.0]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.1.0

[0.4.0]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.4.0

[0.4.1]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.4.1

[0.4.2]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.4.2

[0.5.0]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.5.0
[Unreleased]: https://github.com/Zehee/kimi-code-memory-mcp-server/compare/v0.5.1...HEAD
[0.6.0]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.6.0
[0.5.1]: https://github.com/Zehee/kimi-code-memory-mcp-server/releases/tag/v0.5.1
