/**
 * System tools: get_current_workspace, organize_memories, sync_workspace_index, bootstrap_workspace.
 */

import fs from 'fs';
import path from 'path';
import { ESSENCE_SIZE_LIMIT } from '../config.js';
import { loadMcpConfig } from '../context/wire-context.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { toTitle } from '../utils/validation.js';

function toolResult(data, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

function safeParseFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return parseFrontmatter(text) || { frontmatter: {}, body: text };
  } catch {
    return null;
  }
}

function fileStats(filePath) {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
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
    '来源标注：关键章节/结论在正文内用 `> 来源：memory/<folder>/key` 标注；不写入 frontmatter sources。',
    '不强制模板：Agent 自行决定最终结构和章节。',
    '大小提示：工具校验并提示是否超过 15KB，但不阻止保存。',
    '工具不碰 memory/ 源文件：Agent 整理后如需清理或重写源记忆，自行调用 delete / remember。',
  ].join('\n'),
};

export function createSystemTools(ctx) {
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

  function handleOrganize(args) {
    const hasContent = typeof args.content === 'string';

    if (!hasContent) {
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

    const fileContent =
      '---\n' +
      Object.entries(frontmatter)
        .map(([k, v]) => {
          if (Array.isArray(v)) {
            return `${k}:\n${v.map((item) => `  - ${item}`).join('\n')}`;
          }
          return `${k}: '${String(v).replace(/'/g, "''")}'`;
        })
        .join('\n') +
      '\n---\n\n' +
      content;

    fs.writeFileSync(essencePath, fileContent, 'utf8');
    indexDao.upsertEntry(essencePath);

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

  function handleSyncWorkspaceIndex(args) {
    const result = indexDao.reconcileIndex({
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

  async function handleBootstrapWorkspace(args) {
    indexDao.reconcileIndex();

    const { buildWorkspaceContext } = await import('./context-tools.js').then((m) =>
      m.createContextTools(ctx),
    );
    const contextData = await buildWorkspaceContext(args);
    const existingEssence = loadEssenceFile();
    const config = loadMcpConfig();

    return toolResult({
      workspace: contextData.workspace,
      recentContext: contextData.recentContext,
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

  return {
    handleGetCurrentWorkspace,
    handleOrganize,
    handleSyncWorkspaceIndex,
    handleBootstrapWorkspace,
  };
}
