/**
 * System tools: get_current_workspace, organize_memories, sync_workspace_index, bootstrap_workspace.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Ctx, OrganizeArgs, SyncWorkspaceIndexArgs } from '../types.js';
import type { ToolDefinition } from './types.js';
import { adaptHandler } from './types.js';
import { ESSENCE_SIZE_LIMIT } from '../config.js';
import { getCurrentSessionWirePath, loadMcpConfig, parseWireFile } from '../context/wire-context.js';
import { buildWorkspaceContext } from './context-tools.js';
import type { ReconcileOutcome } from '../dao/index-reconciler.js';
import { RevisionConflictError } from '../dao/memory-store.js';
import { stringifyFrontmatter, parseFrontmatter, type Frontmatter } from '../utils/frontmatter.js';
import { atomicWriteFile } from '../utils/paths.js';
import { WorkspaceJournal, runJournaled } from '../utils/workspace-journal.js';
import { faultPoint } from '../utils/fault-injection.js';
import { toTitle } from '../utils/validation.js';
import { toolResult } from '../utils/tools.js';
import { safeParseFile, fileStats } from '../utils/file-helpers.js';
import { ensureVisServer } from '../vis/auto-start.js';

/** How many historical essence versions are kept for diff/rollback. */
const ESSENCE_HISTORY_LIMIT = 10;

function pruneEssenceHistory(historyDir: string, limit: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(historyDir);
  } catch {
    return;
  }
  const files = entries
    .filter((name) => name.startsWith('essence-') && name.endsWith('.md'))
    .map((name) => {
      const match = /^essence-v(\d+)-/.exec(name);
      return { name, revision: match ? Number(match[1]) : -1 };
    })
    .sort((a, b) => (a.revision !== b.revision ? a.revision - b.revision : a.name < b.name ? -1 : 1))
    .map((entry) => entry.name)
    .reverse();
  for (const stale of files.slice(limit)) {
    try {
      fs.unlinkSync(path.join(historyDir, stale));
    } catch {
      // Best effort; a stuck history file must not block the store.
    }
  }
}

const ESSENCE = {
  folder: 'essence',
  key: 'essence',
  maxRecommendedBytes: ESSENCE_SIZE_LIMIT,
  rules: [
    '输入源：现有 essence/essence.md + memory/ 下所有条目；notes/ 不参与。',
    '输出目标：固定单个文件 essence/essence.md，覆盖写入。',
    '核心任务：重新结构化内容——归类、按重要度排序、去重合并。',
    '语言要求：精炼、无歧义、不改变语义；可适当压缩格式，不必考虑人类可读性。',
    '信息保留：尽量不丢失信息；如需舍弃某 memory 源内容，Agent 自行决定并处理。',
    '来源标注：关键章节/结论在正文内用 `> 来源：memory/<folder>/key` 标注；frontmatter sources 由工具自动记录用于追溯与回滚。',
    '不强制模板：Agent 自行决定最终结构和章节。',
    '大小提示：工具校验并提示是否超过 15KB，但不阻止保存。',
    '工具不碰 memory/ 源文件：Agent 整理后如需清理或重写源记忆，自行调用 delete / remember。',
    '剔除过时内容：整理时识别并移除已被后续决策覆盖、已失效或仅具临时价值的记忆。',
    '生成精要后，你可以重新组织 memory/ 区的文件内容和目录结构（重命名、移动、合并、拆分），并自行调用 remember / move / delete 等工具执行。',
  ].join('\n'),
};

export function createSystemTools(ctx: Ctx): ToolDefinition[] {
  const { cwd, workspaceId, storeRoot, indexDao } = ctx;

  function loadEssenceFile() {
    const essencePath = path.join(storeRoot, 'essence', 'essence.md');
    if (!fs.existsSync(essencePath)) return null;
    const parsed = safeParseFile(essencePath);
    if (!parsed) return null;
    const stats = fileStats(essencePath);
    return {
      key: 'essence',
      folder: 'essence',
      filePath: essencePath,
      frontmatter: parsed.frontmatter || {},
      content: parsed.body || '',
      size: stats ? stats.size : 0,
    };
  }

  function handleGetCurrentWorkspace() {
    return toolResult({
      cwd,
      workspaceId,
      storePath: storeRoot,
    });
  }

  /** Hash of raw file content — used for prepare-token drift detection. */
  function hashRawContent(content: string): string {
    return `sha256:${crypto.createHash('sha256').update(content, 'utf8').digest('hex')}`;
  }

  /** Identity of one memory file, resolved from frontmatter when present. */
  interface MemorySourceState {
    path: string;
    key: string;
    folder: string;
    id: string | null;
    revision: number | null;
    contentHash: string | null;
    /** Hash of the raw file; detects external edits between prepare and store. */
    rawHash: string;
  }

  /**
   * Snapshot of everything the essence depends on: the current essence file
   * (raw hash) and every memory entry with its identity fields.
   */
  function collectEssenceInputs(): { essenceRawHash: string | null; memories: MemorySourceState[] } {
    const essencePath = path.join(storeRoot, ESSENCE.folder, `${ESSENCE.key}.md`);
    let essenceRawHash: string | null = null;
    try {
      essenceRawHash = hashRawContent(fs.readFileSync(essencePath, 'utf8'));
    } catch {
      essenceRawHash = null;
    }

    const memories: MemorySourceState[] = [];
    const index = indexDao.getIndex();
    for (const key of Object.keys(index.index)) {
      if (!key.endsWith('.md')) continue;
      if (!key.startsWith('memory/')) continue;
      const filePath = path.join(storeRoot, key);
      let raw = '';
      try {
        raw = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      // Parse from the bytes we already hold: one disk read per file.
      let fm: Frontmatter = {};
      try {
        fm = parseFrontmatter(raw)?.frontmatter ?? {};
      } catch {
        fm = {};
      }
      const frontmatterRevision = typeof fm.revision === 'number' ? fm.revision : null;
      const frontmatterHash = typeof fm.contentHash === 'string' ? fm.contentHash : null;
      memories.push({
        path: key,
        key: path.basename(key, '.md'),
        folder: path.dirname(key),
        id: typeof fm.id === 'string' && fm.id ? fm.id : null,
        revision: frontmatterRevision,
        contentHash: frontmatterHash,
        rawHash: hashRawContent(raw),
      });
    }
    memories.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { essenceRawHash, memories };
  }

  /**
   * Deterministic token covering the essence file and every memory entry.
   * The store stage recomputes it under the workspace lock: a mismatch means
   * the sources changed between prepare and store.
   */
  function computePrepareToken(inputs: {
    essenceRawHash: string | null;
    memories: MemorySourceState[];
  }): string {
    const payload = {
      essenceHash: inputs.essenceRawHash,
      memories: inputs.memories.map((m) => ({ path: m.path, rawHash: m.rawHash })),
    };
    const digest = crypto.createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
    return `prep-${digest}`;
  }

  /** Compact, frontmatter-encodable source reference (`<path> rev=<n> hash=<hash>`). */
  function encodeSourceRef(state: MemorySourceState | null, ref: string): string {
    if (!state) return ref;
    return `${state.path} rev=${state.revision ?? 0} hash=${state.contentHash ?? 'unknown'}`;
  }

  /** Resolve a caller-provided source ref (path, path without extension or bare key). */
  function resolveSourceRef(ref: string, memories: MemorySourceState[]): MemorySourceState | null {
    const clean = ref.trim();
    if (!clean) return null;
    const candidates = [
      clean,
      clean.endsWith('.md') ? clean : `${clean}.md`,
      `memory/${clean.endsWith('.md') ? clean : `${clean}.md`}`,
    ];
    for (const candidate of candidates) {
      const found = memories.find((m) => m.path === candidate);
      if (found) return found;
    }
    // Bare key match anywhere under memory/.
    const base = path.basename(clean.replace(/\.md$/, ''));
    return memories.find((m) => m.key === base) ?? null;
  }

  /**
   * Restore a previous essence version from `essence/history/`.
   *
   * The restored content keeps its body verbatim; the revision is set to
   * `current + 1` so the revision history stays monotonic and concurrent
   * writers cannot be overwritten silently. The current version is archived
   * first, so a rollback is itself rollbackable.
   */
  async function handleRollbackEssence(args: { revision?: number } = {}) {
    const essencePath = path.join(storeRoot, ESSENCE.folder, `${ESSENCE.key}.md`);
    const historyDir = path.join(storeRoot, ESSENCE.folder, 'history');

    if (!fs.existsSync(essencePath)) {
      return toolResult({ success: false, error: 'No essence file to roll back from' }, true);
    }

    const outcome = await ctx.memoryStore.withWorkspaceLock(() =>
      // Rollback is a multi-storage write too (essence file + index): it is
      // journaled like organize/store so a mid-rollback crash leaves a
      // recovery record instead of a silent half state.
      runJournaled(
        new WorkspaceJournal(storeRoot),
        'essence',
        { targetPath: `${ESSENCE.folder}/${ESSENCE.key}.md` },
        async () => {
      const currentParsed = safeParseFile(essencePath);
      const currentRevision =
        typeof currentParsed?.frontmatter.revision === 'number'
          ? currentParsed.frontmatter.revision
          : 0;

      const available = fs.existsSync(historyDir)
        ? fs
            .readdirSync(historyDir)
            .filter((name) => name.startsWith('essence-v') && name.endsWith('.md'))
            .map((name) => {
              const match = /^essence-v(\d+)-/.exec(name);
              return match ? { revision: Number(match[1]), file: name } : null;
            })
            .filter((entry): entry is { revision: number; file: string } => entry !== null)
            .sort((a, b) => b.revision - a.revision)
        : [];

      if (available.length === 0) {
        return { error: 'No history copies exist; nothing to roll back to' } as const;
      }

      const target = args.revision
        ? available.find((entry) => entry.revision === args.revision)
        : available[0];
      if (!target) {
        return {
          error: `No history copy for revision ${args.revision}`,
          availableRevisions: available.map((entry) => entry.revision),
        } as const;
      }
      if (target.revision >= currentRevision && currentRevision > 0) {
        return {
          error: `Cannot roll back to revision ${target.revision} (current is ${currentRevision})`,
          availableRevisions: available.map((entry) => entry.revision),
        } as const;
      }

      const targetText = fs.readFileSync(path.join(historyDir, target.file), 'utf8');
      const targetParsed = safeParseFile(path.join(historyDir, target.file));
      const nowIso = new Date().toISOString();
      const nextRevision = currentRevision + 1;

      // Archive the current version before overwriting it.
      fs.mkdirSync(historyDir, { recursive: true });
      fs.copyFileSync(
        essencePath,
        path.join(historyDir, `essence-v${currentRevision}-${nowIso.replace(/[:.]/g, '-')}.md`),
      );
      pruneEssenceHistory(historyDir, ESSENCE_HISTORY_LIMIT);

      const restoredFm = {
        ...(targetParsed?.frontmatter ?? {}),
        key: ESSENCE.key,
        title: 'Workspace Essence',
        schemaVersion: 1,
        revision: nextRevision,
        generatedAt: typeof targetParsed?.frontmatter.generatedAt === 'string' ? targetParsed.frontmatter.generatedAt : nowIso,
        generator: 'rollback',
        updatedAt: nowIso,
      };
      const restoredBody = targetParsed?.body ?? targetText;
      atomicWriteFile(essencePath, stringifyFrontmatter(restoredFm) + restoredBody, 'utf8');
      await indexDao.upsertEntry(essencePath);

      return {
        fromRevision: currentRevision,
        toRevision: nextRevision,
        restoredFrom: target.revision,
      } as const;
        },
        {
          // Validation failures (no history copy, stale revision, refused
          // overwrite) mutate nothing: the journal entry is dropped instead
          // of being committed as if a rollback had happened (review
          // follow-up #2).
          dropResult: (result) => 'error' in result,
        },
      ),
    );

    if ('error' in outcome) {
      return toolResult({ success: false, error: outcome.error, ...outcome }, true);
    }
    return toolResult({ success: true, stage: 'rollback', ...outcome });
  }

  async function handleOrganize(args: OrganizeArgs) {
    if (typeof args.content !== 'string') {
      const existingEssence = loadEssenceFile();

      // One pass over the corpus: identities and bodies come from the same
      // read (see collectEssenceInputs).
      const inputs = collectEssenceInputs();
      const prepareToken = computePrepareToken(inputs);
      const index = indexDao.getIndex();
      const pendingMemories = inputs.memories.map((state) => {
        const value = index.index[state.path] ?? {};
        const parsed = safeParseFile(path.join(storeRoot, state.path));
        const filePath = path.join(storeRoot, state.path);
        return {
          key: state.key,
          folder: state.folder,
          title: typeof value.title === 'string' && value.title ? value.title : toTitle(state.key),
          tags: Array.isArray(value.tags) ? value.tags.map((t) => String(t)) : [],
          size: fileStats(filePath)?.size || 0,
          content: parsed?.body || '',
          id: state.id,
          revision: state.revision,
          contentHash: state.contentHash,
        };
      });

      const fm = existingEssence?.frontmatter ?? {};
      const essenceState = existingEssence
        ? {
            found: true,
            revision:
              typeof fm.revision === 'number' && Number.isFinite(fm.revision) ? fm.revision : 0,
            generatedAt: typeof fm.generatedAt === 'string' ? fm.generatedAt : null,
            size: existingEssence.size,
          }
        : { found: false, revision: 0, generatedAt: null, size: 0 };

      return toolResult({
        stage: 'prepare',
        existingEssence: existingEssence
          ? {
              found: true,
              key: existingEssence.key,
              folder: existingEssence.folder,
              size: existingEssence.size,
              content: existingEssence.content,
            }
          : { found: false },
        essenceState,
        pendingMemories,
        prepareToken,
        rules: ESSENCE.rules,
        outputPath: `${ESSENCE.folder}/${ESSENCE.key}.md`,
        maxRecommendedBytes: ESSENCE.maxRecommendedBytes,
        message:
          'Prepare ready. Generate the organized essence content and call organize_memories with content and prepareToken to store.',
      });
    }

    const content = args.content;
    const sourcesRaw = Array.isArray(args.sources)
      ? args.sources.filter((s) => typeof s === 'string')
      : [];
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const withinLimit = contentBytes <= ESSENCE.maxRecommendedBytes;
    const preparedToken = typeof args.prepareToken === 'string' ? args.prepareToken.trim() : '';

    const essenceDir = path.join(storeRoot, ESSENCE.folder);
    const essencePath = path.join(essenceDir, `${ESSENCE.key}.md`);

    // The whole read-check-write-index flow runs under the workspace lock so
    // a concurrent memory write cannot slip between the token check and the
    // snapshot the token was computed from.
    const outcome = await ctx.memoryStore.withWorkspaceLock(async () => {
      const journal = new WorkspaceJournal(storeRoot);
      const entry = journal.prepare('essence', {
        targetPath: `${ESSENCE.folder}/${ESSENCE.key}.md`,
      });

      try {
        const current = collectEssenceInputs();
        const currentToken = computePrepareToken(current);

        if (preparedToken && preparedToken !== currentToken) {
          journal.remove(entry.operationId);
          return {
            conflict: true as const,
            currentToken,
            memoryCount: current.memories.length,
          };
        }

        const prevEssence = loadEssenceFile();
        const prevFm = prevEssence?.frontmatter ?? {};
        const prevRevision =
          typeof prevFm.revision === 'number' && Number.isFinite(prevFm.revision)
            ? prevFm.revision
            : 0;
        const nextRevision = prevRevision + 1;
        const nowIso = new Date().toISOString();

        // Keep the previous version for diff/rollback before overwriting.
        if (fs.existsSync(essencePath)) {
          const historyDir = path.join(essenceDir, 'history');
          fs.mkdirSync(historyDir, { recursive: true });
          const stamp = nowIso.replace(/[:.]/g, '-');
          try {
            fs.copyFileSync(
              essencePath,
              path.join(historyDir, `essence-v${prevRevision}-${stamp}.md`),
            );
            pruneEssenceHistory(historyDir, ESSENCE_HISTORY_LIMIT);
          } catch {
            // A failed history copy must not block storing the new essence.
          }
        }

        const sources = sourcesRaw.map((ref) =>
          encodeSourceRef(resolveSourceRef(ref, current.memories), ref),
        );
        const frontmatter = {
          key: ESSENCE.key,
          title: 'Workspace Essence',
          tags: ['essence', 'workspace-memory'],
          schemaVersion: 1,
          revision: nextRevision,
          generatedAt: nowIso,
          generator: 'agent',
          sources,
          updatedAt: nowIso,
        };

        atomicWriteFile(essencePath, stringifyFrontmatter(frontmatter) + content, 'utf8');
        faultPoint('essence.after-file-write');
        await indexDao.upsertEntry(essencePath);
        journal.commit(entry.operationId);

        return {
          conflict: false as const,
          revision: nextRevision,
          contentHash: `sha256:${crypto.createHash('sha256').update(content, 'utf8').digest('hex')}`,
        };
      } catch (err) {
        journal.fail(entry.operationId, err instanceof Error ? err.message : String(err));
        throw err;
      }
    });

    if (outcome.conflict) {
      return toolResult(
        {
          success: false,
          stage: 'conflict',
          reason: 'workspace-state-changed',
          detail:
            'The essence or one of the memory files changed after prepare. Re-run organize_memories (empty call) to get a fresh prepareToken, then store again.',
          expectedPrepareToken: preparedToken || null,
          currentPrepareToken: outcome.currentToken,
          memoryCount: outcome.memoryCount,
        },
        true,
      );
    }

    return toolResult({
      success: true,
      stage: 'store',
      filePath: essencePath,
      contentSize: contentBytes,
      recommendedMax: ESSENCE.maxRecommendedBytes,
      revision: outcome.revision,
      contentHash: outcome.contentHash,
      sizeHint: withinLimit
        ? 'within recommended limit'
        : `exceeds ${ESSENCE.maxRecommendedBytes} bytes, consider compressing next time`,
      sources: sourcesRaw,
    });
  }

  async function handleSyncWorkspaceIndex(args: SyncWorkspaceIndexArgs) {
    // The reconcile runs first and its outcome feeds the journal recovery:
    // a `synced: false` result keeps every prepared entry on disk instead of
    // dropping the only recovery clue.
    let syncOutcome: ReconcileOutcome | null = null;
    const journal = new WorkspaceJournal(storeRoot);
    const recovery = await journal.recover(async () => {
      syncOutcome = await indexDao.reconcileIndex({
        folderComments: args.folderComments,
      });
      return syncOutcome;
    });

    const index = indexDao.getIndex();
    const foldersNeedingComment = [];
    for (const key of Object.keys(index.index)) {
      if (!key.endsWith('/')) continue;
      const value = index.index[key];
      if (!value.comment) {
        foldersNeedingComment.push(key);
      }
    }

    return toolResult({
      ...(syncOutcome as unknown as object),
      indexState: indexDao.getIndexState(),
      foldersNeedingComment,
      journalRecovered: recovery.recovered,
      journalFailed: recovery.failed,
      journalCorrupt: recovery.corrupt,
    });
  }

  async function handleBootstrapWorkspace(args: {
    detailed_rounds?: number;
    summary_rounds?: number;
    force?: boolean;
  }) {
    const reconcileOutcome = await indexDao.reconcileIndex();

    const existingEssence = loadEssenceFile();
    const config = loadMcpConfig();

    // Resume context only for a brand-new session (turn count <= 1). When the
    // host has already continued the session (`kimi web`, `kimi -c`) the
    // current session holds multiple turns and the host has loaded that
    // history, so we leave recentContext empty to avoid duplicating it.
    // `force` bypasses this guard and resumes from the previous session
    // regardless. essence / memoryIndexTree / notesRefs are always returned.
    let recentContext = null;
    let currentTurnCount = 0;
    const currentSession = getCurrentSessionWirePath();
    if (currentSession) {
      const { turns } = await parseWireFile(currentSession.wire);
      currentTurnCount = turns.length;
    }
    if (args.force === true || currentTurnCount <= 1) {
      const contextData = await buildWorkspaceContext(ctx, args);
      recentContext = contextData.recentContext;
    }

    const sessionIdentity = currentSession
      ? {
          sessionId: currentSession.sessionId,
          identityAssumed: currentSession.identityAssumed === true,
          identitySource: currentSession.identitySource ?? (currentSession.identityAssumed ? 'guess' : 'explicit'),
        }
      : null;

    return toolResult({
      workspace: { cwd, workspaceId, storePath: storeRoot },
      sessionIdentity,
      // An mtime-guessed current session is only a low-confidence candidate:
      // resumed context may belong to a parallel session in the same workspace.
      identityWarning:
        sessionIdentity?.identityAssumed && recentContext
          ? 'The current session was identified by mtime guessing (no explicit session id). The resumed context may belong to a parallel session; do not rely on it for destructive operations.'
          : undefined,
      recentContext,
      essence: existingEssence
        ? {
            found: true,
            key: existingEssence.key,
            folder: existingEssence.folder,
            size: existingEssence.size,
            content: existingEssence.content,
          }
        : { found: false },
      memoryIndexTree: indexDao.buildMemoryIndexTree(config.recentChangeLimit),
      notesRefs: indexDao.listRefs('notes'),
      // Surface reconcile problems on the bootstrap consumer path: corrupt
      // files and other errors must never be silently swallowed here
      // (review P2, round 6 #2 follow-up).
      indexIssues: {
        state: indexDao.getIndexState().state,
        errors: reconcileOutcome.errors,
        corruptFiles: reconcileOutcome.corruptFiles,
        revisionsBumped: reconcileOutcome.revisionsBumped,
      },
    });
  }

  async function handleOpenDashboard() {
    // Every call re-validates the running instance (authenticated probe) and
    // restarts or takes over the dashboard when it is gone. The bootstrap
    // token never leaves this function.
    const result = await ensureVisServer(ctx);
    if (!result.started || !result.url || !result.browserUrl) {
      return toolResult(
        { success: false, error: result.error || 'Failed to start dashboard' },
        true,
      );
    }

    const { default: openBrowser } = await import('open');
    await openBrowser(result.browserUrl);

    return toolResult({ success: true, url: result.url, reused: result.reused === true });
  }

  const tools: ToolDefinition[] = [
    {
      name: 'get_current_workspace',
      description: 'Return the current cwd, workspace id and store path.',
      inputSchema: { type: 'object', properties: {} },
      handler: adaptHandler(handleGetCurrentWorkspace),
    },
    {
      name: 'open_memory_dashboard',
      description:
        'Opens the memory dashboard in the default browser. Starts the dashboard server if it is not already running.',
      inputSchema: { type: 'object', properties: {} },
      handler: adaptHandler(handleOpenDashboard),
    },
    {
      name: 'organize_memories',
      description:
        'Two-stage workspace memory organizer. Empty call returns existing essence + pending memory files + rules. Call with content to store the organized essence.md.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description:
              'Organized essence Markdown body. Key facts should cite sources inline using `> 来源：memory/<folder>/key`.',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional list of memory/ keys incorporated into the essence, returned in the tool result for tracking.',
          },
          prepareToken: {
            type: 'string',
            description:
              'Token returned by the prepare stage. Store rejects with a conflict when the essence or memory files changed since prepare.',
          },
        },
      },
      handler: adaptHandler(handleOrganize),
    },
    {
      name: 'rollback_essence',
      description:
        'Restore a previous essence version from essence/history/. Without arguments restores the newest archive; pass revision to pick one. The current version is archived first, so a rollback is itself rollbackable.',
      inputSchema: {
        type: 'object',
        properties: {
          revision: {
            type: 'number',
            description: 'Specific essence revision to restore (defaults to the newest archive).',
          },
        },
      },
      handler: adaptHandler(handleRollbackEssence),
    },
    {
      name: 'sync_workspace_index',
      description:
        'Reconciles index.json with the filesystem. Empty call scans and reports mismatches. Call with folderComments to set folder descriptions.',
      inputSchema: {
        type: 'object',
        properties: {
          folderComments: {
            type: 'object',
            description: 'Optional map of folder paths to comments.',
          },
        },
      },
      handler: adaptHandler(handleSyncWorkspaceIndex),
    },
    {
      name: 'bootstrap_workspace',
      description:
        'Session bootstrap: loads workspace context, essence, notes refs, and a memory index tree with recent changes marked [new].',
      inputSchema: {
        type: 'object',
        properties: {
          detailed_rounds: {
            type: 'number',
            description: 'Number of most recent rounds to return in full detail.',
          },
          summary_rounds: {
            type: 'number',
            description: 'Number of preceding rounds to return as summaries.',
          },
          force: {
            type: 'boolean',
            description:
              'If true, return recent context even when the current session already has turns.',
          },
        },
      },
      handler: adaptHandler(handleBootstrapWorkspace),
    },
  ];

  return tools;
}

/**
 * Standalone essence rollback for the HTTP API: reuses the MCP tool handler
 * so the dashboard and the agent cannot drift apart.
 */
export async function rollbackEssence(
  ctx: Ctx,
  revision?: number,
): Promise<{ success: boolean; error?: string; [key: string]: unknown }> {
  const tools = createSystemTools(ctx);
  const tool = tools.find((t) => t.name === 'rollback_essence');
  if (!tool) {
    return { success: false, error: 'rollback_essence tool is not registered' };
  }
  const result = await tool.handler({ revision });
  const text = result.content[0]?.text ?? '{}';
  return JSON.parse(text) as { success: boolean; error?: string; [key: string]: unknown };
}

/**
 * Store essence content with the same contract as `organize_memories`:
 * revision bump, history archive and awaited index update. Shared by the
 * dashboard so both entry points produce comparable essence files.
 */
export async function storeEssenceContent(
  ctx: Ctx,
  content: string,
  options: { generator?: string; expectedRevision?: number } = {},
): Promise<{ ok: boolean; degraded?: string; revision: number }> {
  return ctx.memoryStore.withWorkspaceLock(() =>
    runJournaled(
      new WorkspaceJournal(ctx.storeRoot),
      'essence',
      { targetPath: 'essence/essence.md' },
      async () => {
        const essenceDir = path.join(ctx.storeRoot, 'essence');
        const essencePath = path.join(essenceDir, 'essence.md');
        const historyDir = path.join(essenceDir, 'history');
        const prevParsed = safeParseFile(essencePath);
        const prevRevision =
          typeof prevParsed?.frontmatter.revision === 'number' && Number.isFinite(prevParsed.frontmatter.revision)
            ? prevParsed.frontmatter.revision
            : 0;
        if (
          options.expectedRevision !== undefined &&
          options.expectedRevision !== prevRevision
        ) {
          throw new RevisionConflictError({
            expectedRevision: options.expectedRevision,
            currentRevision: prevRevision,
            currentContentHash:
              typeof prevParsed?.frontmatter.contentHash === 'string'
                ? prevParsed.frontmatter.contentHash
                : '',
            key: 'essence',
            folder: 'essence',
          });
        }
        const nowIso = new Date().toISOString();

        if (fs.existsSync(essencePath)) {
          fs.mkdirSync(historyDir, { recursive: true });
          try {
            fs.copyFileSync(
              essencePath,
              path.join(historyDir, `essence-v${prevRevision}-${nowIso.replace(/[:.]/g, '-')}.md`),
            );
            pruneEssenceHistory(historyDir, ESSENCE_HISTORY_LIMIT);
          } catch {
            // A failed archive must not block the save.
          }
        }

        const fm = {
          key: 'essence',
          title: 'Workspace Essence',
          tags: ['essence', 'workspace-memory'],
          schemaVersion: 1,
          revision: prevRevision + 1,
          generatedAt:
            typeof prevParsed?.frontmatter.generatedAt === 'string'
              ? prevParsed.frontmatter.generatedAt
              : nowIso,
          generator: options.generator ?? 'dashboard',
          ...(Array.isArray(prevParsed?.frontmatter.sources)
            ? { sources: prevParsed.frontmatter.sources }
            : {}),
          updatedAt: nowIso,
        };
        atomicWriteFile(essencePath, stringifyFrontmatter(fm) + content, 'utf8');

        let degraded: string | undefined;
        try {
          await ctx.indexDao.upsertEntry(essencePath);
        } catch {
          degraded = 'index_stale';
        }
        return { ok: true as const, degraded, revision: prevRevision + 1 };
      },
      { benign: (err) => err instanceof RevisionConflictError },
    ),
  );
}
