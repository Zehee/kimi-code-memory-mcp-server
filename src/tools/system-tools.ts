/**
 * System tools: get_current_workspace, organize_memories, sync_workspace_index, bootstrap_workspace.
 */

import fs from 'fs';
import path from 'path';
import type { Ctx, OrganizeArgs, SyncWorkspaceIndexArgs } from '../types.js';
import type { ToolDefinition } from './types.js';
import { adaptHandler } from './types.js';
import { ESSENCE_SIZE_LIMIT } from '../config.js';
import { loadMcpConfig } from '../context/wire-context.js';
import { buildWorkspaceContext } from './context-tools.js';
import { stringifyFrontmatter } from '../utils/frontmatter.js';
import { atomicWriteFile } from '../utils/paths.js';
import { toTitle } from '../utils/validation.js';
import { toolResult } from '../utils/tools.js';
import { safeParseFile, fileStats } from '../utils/file-helpers.js';
import { maybeStartVisServer, getVisUrl } from '../vis/auto-start.js';

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
    '来源标注：关键章节/结论在正文内用 `> 来源：memory/<folder>/key` 标注；不写入 frontmatter sources。',
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

  async function handleOrganize(args: OrganizeArgs) {
    if (typeof args.content !== 'string') {
      const existingEssence = loadEssenceFile();

      const pendingMemories = [];
      const index = indexDao.getIndex();
      for (const key of Object.keys(index.index)) {
        if (!key.endsWith('.md')) continue;
        if (!key.startsWith('memory/')) continue;
        const value = index.index[key];
        const filePath = path.join(storeRoot, key);
        const parsed = safeParseFile(filePath);
        pendingMemories.push({
          key: path.basename(key, '.md'),
          folder: path.dirname(key),
          title: value.title || toTitle(path.basename(key, '.md')),
          tags: Array.isArray(value.tags) ? value.tags : [],
          size: fileStats(filePath)?.size || 0,
          content: parsed?.body || '',
        });
      }

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
        pendingMemories,
        rules: ESSENCE.rules,
        outputPath: `${ESSENCE.folder}/${ESSENCE.key}.md`,
        maxRecommendedBytes: ESSENCE.maxRecommendedBytes,
        message:
          'Prepare ready. Generate the organized essence content and call organize_memories with content to store.',
      });
    }

    const content = args.content;
    const sources = Array.isArray(args.sources)
      ? args.sources.filter((s) => typeof s === 'string')
      : [];
    const contentBytes = Buffer.byteLength(content, 'utf8');
    const withinLimit = contentBytes <= ESSENCE.maxRecommendedBytes;

    const essenceDir = path.join(storeRoot, ESSENCE.folder);
    fs.mkdirSync(essenceDir, { recursive: true });
    const essencePath = path.join(essenceDir, `${ESSENCE.key}.md`);
    const nowIso = new Date().toISOString();

    const frontmatter = {
      key: ESSENCE.key,
      title: 'Workspace Essence',
      tags: ['essence', 'workspace-memory'],
      updatedAt: nowIso,
    };

    const fileContent = stringifyFrontmatter(frontmatter) + content;

    atomicWriteFile(essencePath, fileContent, 'utf8');
    await indexDao.upsertEntry(essencePath);

    return toolResult({
      success: true,
      stage: 'store',
      filePath: essencePath,
      contentSize: contentBytes,
      recommendedMax: ESSENCE.maxRecommendedBytes,
      sizeHint: withinLimit
        ? 'within recommended limit'
        : `exceeds ${ESSENCE.maxRecommendedBytes} bytes, consider compressing next time`,
      sources,
    });
  }

  async function handleSyncWorkspaceIndex(args: SyncWorkspaceIndexArgs) {
    const result = await indexDao.reconcileIndex({
      folderComments: args.folderComments,
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
      ...result,
      foldersNeedingComment,
    });
  }

  async function handleBootstrapWorkspace(args: {
    detailed_rounds?: number;
    summary_rounds?: number;
    force?: boolean;
  }) {
    await indexDao.reconcileIndex();

    const contextData = await buildWorkspaceContext(ctx, args);
    const existingEssence = loadEssenceFile();
    const config = loadMcpConfig();

    // Defensive: if the host already loaded this session's turns (e.g. `kimi web`
    // or `kimi -c`), skip returning them again to avoid context duplication.
    let recentContext:
      | (typeof contextData.recentContext & {
          skipped?: boolean;
          reason?: string;
        })
      | null = contextData.recentContext;
    if (
      recentContext &&
      args.force !== true &&
      (recentContext.totalTurns > 0 ||
        recentContext.detailedRounds.length > 0 ||
        recentContext.summaryRounds.length > 0)
    ) {
      recentContext = {
        ...recentContext,
        detailedRounds: [],
        summaryRounds: [],
        compactionSummaries: [],
        skipped: true,
        reason:
          'Session already has turns; skipping detailed/summary rounds to avoid duplicating host-loaded context.',
      };
    }

    return toolResult({
      workspace: contextData.workspace,
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
    });
  }

  async function handleOpenDashboard() {
    let url = getVisUrl();
    if (!url) {
      const result = await maybeStartVisServer(ctx);
      if (!result.started || !result.url) {
        return toolResult(
          { success: false, error: result.error || 'Failed to start dashboard' },
          true,
        );
      }
      url = result.url;
    }

    const { default: openBrowser } = await import('open');
    await openBrowser(url);

    return toolResult({ success: true, url });
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
        },
      },
      handler: adaptHandler(handleOrganize),
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
