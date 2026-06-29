/**
 * Memory CRUD tools: remember, recall, search, list, list_tags, delete, move.
 */

import fs from 'fs';
import path from 'path';
import type {
  Ctx,
  RememberArgs,
  RecallArgs,
  ListArgs,
  SearchArgs,
  DeleteArgs,
  MoveArgs,
} from '../types.js';
import type { ToolDefinition } from './types.js';
import { adaptHandler } from './types.js';
import { sanitizeFolder, sanitizeKey, toTitle } from '../utils/validation.js';
import { toolResult } from '../utils/tools.js';
import { safeParseFile, fileStats } from '../utils/file-helpers.js';

export function createMemoryTools(ctx: Ctx): ToolDefinition[] {
  const { storeRoot, indexDao, themeManager, memoryStore } = ctx;

  function resolveFilePath(folder: string, key: string) {
    return path.join(storeRoot, folder, `${sanitizeKey(key)}.md`);
  }

  async function handleRemember(args: RememberArgs) {
    const key = args.key;
    if (!key || typeof key !== 'string') {
      return toolResult({ success: false, error: 'Missing or invalid "key"' }, true);
    }

    const folderRaw = typeof args.folder === 'string' ? args.folder : 'memory';
    const folder = sanitizeFolder(folderRaw);
    if (!folder) {
      return toolResult({ success: false, error: 'Invalid folder path' }, true);
    }
    const content = typeof args.content === 'string' ? args.content : '';
    const tags = Array.isArray(args.tags) ? args.tags.filter((t) => typeof t === 'string') : [];
    const themes = Array.isArray(args.themes)
      ? args.themes.filter((t) => typeof t === 'string')
      : [];

    const filePath = memoryStore.write(folder, key, content, tags);
    await indexDao.upsertEntry(filePath);

    const sanitizedKey = sanitizeKey(key);
    const readBack = memoryStore.read(folder, key);
    const title = typeof readBack?.title === 'string' ? readBack.title : toTitle(key);
    for (const theme of themes) {
      await themeManager.addThemeAssociation(theme, {
        memoryKey: sanitizedKey,
        folder,
        title,
      });
    }

    return toolResult({ success: true, filePath, folder, key, themes });
  }

  async function handleRecall(args: RecallArgs) {
    const key = args.key;
    if (!key || typeof key !== 'string') {
      return toolResult({ found: false, error: 'Missing or invalid "key"' }, true);
    }

    const folderRaw = typeof args.folder === 'string' ? args.folder : 'memory';
    const folder = sanitizeFolder(folderRaw);
    if (!folder) {
      return toolResult({ found: false, error: 'Invalid folder path', key }, true);
    }

    const readResult = memoryStore.read(folder, key);
    if (!readResult) {
      return toolResult({ found: false, key, folder });
    }

    await indexDao.upsertEntry(readResult.filePath);

    return toolResult({
      found: true,
      key,
      folder,
      content: readResult.content,
      tags: Array.isArray(readResult.tags) ? readResult.tags : [],
      createdAt: readResult.createdAt || null,
      updatedAt: readResult.updatedAt || null,
    });
  }

  function handleSearch(args: SearchArgs) {
    const query = args.query;
    if (!query || typeof query !== 'string') {
      return toolResult({ items: [], error: 'Missing or invalid "query"' }, true);
    }
    const needle = query.toLowerCase();
    const folderFilterRaw = typeof args.folder === 'string' ? args.folder : null;
    const folderFilter = folderFilterRaw ? sanitizeFolder(folderFilterRaw) : null;
    if (folderFilterRaw && !folderFilter) {
      return toolResult({ items: [], error: 'Invalid folder path' }, true);
    }

    const index = indexDao.getIndex();
    const items = [];
    for (const key of Object.keys(index.index)) {
      if (!key.endsWith('.md')) continue;
      const value = index.index[key];
      const folder = path.dirname(key);
      const entryKey = path.basename(key, '.md');

      if (folderFilter && folder !== folderFilter) continue;

      const title = value.title || toTitle(entryKey);
      const haystack = `${title}\n${entryKey}`.toLowerCase();

      if (!haystack.includes(needle)) {
        const filePath = path.join(storeRoot, key);
        const parsed = safeParseFile(filePath);
        const body = parsed?.body || '';
        if (!body.toLowerCase().includes(needle)) continue;

        const matches = [];
        const lines = body.split(/\r?\n/);
        for (const line of lines) {
          if (line.toLowerCase().includes(needle)) {
            matches.push(line.trim().slice(0, 200));
            if (matches.length >= 3) break;
          }
        }
        items.push({ key: entryKey, folder, title, matches });
        continue;
      }

      items.push({ key: entryKey, folder, title, matches: [`title: ${title}`] });
    }

    return toolResult({ items });
  }

  function handleListTags() {
    const index = indexDao.getIndex();
    const tagSet = new Set();
    for (const key of Object.keys(index.index)) {
      if (!key.endsWith('.md')) continue;
      const value = index.index[key];
      if (Array.isArray(value.tags)) {
        for (const tag of value.tags) tagSet.add(tag);
      }
    }
    return toolResult({ tags: Array.from(tagSet).sort() });
  }

  function handleList(args: ListArgs) {
    const folderFilterRaw = typeof args.folder === 'string' ? args.folder : null;
    const folderFilter = folderFilterRaw ? sanitizeFolder(folderFilterRaw) : null;
    if (folderFilterRaw && !folderFilter) {
      return toolResult({ items: [], error: 'Invalid folder path' }, true);
    }
    const tagFilter = typeof args.tag === 'string' ? args.tag : null;
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : null;
    const index = indexDao.getIndex();

    const items = [];
    for (const key of Object.keys(index.index)) {
      if (!key.endsWith('.md')) continue;
      const value = index.index[key];
      const folder = path.dirname(key);
      if (folderFilter && folder !== folderFilter) continue;
      if (tagFilter && (!Array.isArray(value.tags) || !value.tags.includes(tagFilter))) continue;

      const filePath = path.join(storeRoot, key);
      const stats = fileStats(filePath);
      items.push({
        key: path.basename(key, '.md'),
        folder,
        title: value.title || toTitle(path.basename(key, '.md')),
        tags: Array.isArray(value.tags) ? value.tags : [],
        updatedAt: stats ? stats.modifiedAt : new Date().toISOString(),
        size: stats ? stats.size : 0,
      });
    }

    items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    if (limit !== null) {
      return toolResult({
        items: items.slice(0, limit).map((item) => {
          const filePath = resolveFilePath(item.folder, item.key);
          const parsed = safeParseFile(filePath);
          return {
            ...item,
            preview: (parsed?.body || '').slice(0, 400),
          };
        }),
      });
    }

    return toolResult({ items });
  }

  async function handleDelete(args: DeleteArgs) {
    const key = args.key;
    if (!key || typeof key !== 'string') {
      return toolResult({ success: false, error: 'Missing or invalid "key"' }, true);
    }

    const folderRaw = typeof args.folder === 'string' ? args.folder : 'memory';
    const folder = sanitizeFolder(folderRaw);
    if (!folder) {
      return toolResult({ success: false, error: 'Invalid folder path', key }, true);
    }

    const filePath = memoryStore.resolveFilePath(folder, key);
    const relativePath = path.relative(storeRoot, filePath).replace(/\\/g, '/');
    const deleted = memoryStore.delete(folder, key);
    if (!deleted) {
      return toolResult({ success: false, key, folder, error: 'Memory not found' }, true);
    }

    await indexDao.deleteEntryByPath(relativePath);

    return toolResult({ success: true, key, folder });
  }

  async function handleMove(args: MoveArgs) {
    const key = args.key;
    if (!key || typeof key !== 'string') {
      return toolResult({ success: false, error: 'Missing or invalid "key"' }, true);
    }

    const folderRaw = typeof args.folder === 'string' ? args.folder : 'memory';
    const folder = sanitizeFolder(folderRaw);
    if (!folder) {
      return toolResult({ success: false, error: 'Invalid folder path', key }, true);
    }

    const toFolderRaw = typeof args.toFolder === 'string' ? args.toFolder : null;
    if (!toFolderRaw) {
      return toolResult({ success: false, error: 'Missing "toFolder"' }, true);
    }
    const toFolder = sanitizeFolder(toFolderRaw);
    if (!toFolder) {
      return toolResult({ success: false, error: 'Invalid toFolder path', key }, true);
    }

    const newKeyRaw = typeof args.newKey === 'string' ? args.newKey : key;
    const newKey = sanitizeKey(newKeyRaw);

    const srcPath = memoryStore.resolveFilePath(folder, key);
    const destPath = memoryStore.resolveFilePath(toFolder, newKey);

    if (!fs.existsSync(srcPath)) {
      return toolResult({ success: false, key, folder, error: 'Memory not found' }, true);
    }

    if (fs.existsSync(destPath)) {
      return toolResult(
        {
          success: false,
          key,
          folder,
          toFolder,
          newKey,
          error: 'Destination already exists',
        },
        true,
      );
    }

    const oldRelativePath = path.relative(storeRoot, srcPath).replace(/\\/g, '/');
    const newRelativePath = path.relative(storeRoot, destPath).replace(/\\/g, '/');

    memoryStore.move(folder, key, toFolder, newKeyRaw);

    await indexDao.moveEntry(oldRelativePath, newRelativePath);

    return toolResult({ success: true, key, newKey, fromFolder: folder, toFolder });
  }

  const tools: ToolDefinition[] = [
    {
      name: 'remember',
      description: 'Write or overwrite a memory entry as a Markdown file with YAML frontmatter.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Unique identifier used as filename base' },
          content: {
            type: 'string',
            description:
              'Markdown body content. For decisions include rationale, impact, and related files. ' +
              'For rules include scope and consequence. For knowledge include scenario and related files/interfaces. ' +
              'For references include URL and relevance. Example decision: "# Use SQLite\\n\\n## Rationale\\n- Single-file deployment\\n- No extra service\\n\\n## Impact\\nAll cache reads/writes go through src/cache.js.\\n\\n## Related files\\nsrc/cache.js, docs/cache.md"',
          },
          folder: {
            type: 'string',
            description: 'Subfolder under the workspace (default: memory)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags stored in YAML frontmatter',
          },
          themes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional theme names to associate with this memory',
          },
        },
        required: ['key'],
      },
      handler: adaptHandler(handleRemember),
    },
    {
      name: 'recall',
      description: 'Read a memory entry by key and folder.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key' },
          folder: { type: 'string', description: 'Subfolder (default: memory)' },
        },
        required: ['key'],
      },
      handler: adaptHandler(handleRecall),
    },
    {
      name: 'search',
      description: 'Case-insensitive keyword search across memory titles and contents.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword to search' },
          folder: { type: 'string', description: 'Limit search to a subfolder' },
        },
        required: ['query'],
      },
      handler: adaptHandler(handleSearch),
    },
    {
      name: 'list_tags',
      description: 'List all tags used in the current workspace.',
      inputSchema: { type: 'object', properties: {} },
      handler: adaptHandler(handleListTags),
    },
    {
      name: 'list',
      description: 'List memory entries in the workspace, sorted by most recently updated.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Filter to a specific subfolder' },
          limit: { type: 'number', description: 'Maximum number of entries to return (default: all)' },
          tag: { type: 'string', description: 'Filter to entries containing this tag' },
        },
      },
      handler: adaptHandler(handleList),
    },
    {
      name: 'delete',
      description: 'Delete a memory entry by key and folder.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key' },
          folder: { type: 'string', description: 'Subfolder (default: memory)' },
        },
        required: ['key'],
      },
      handler: adaptHandler(handleDelete),
    },
    {
      name: 'move',
      description: 'Move a memory entry to another folder, optionally renaming it.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key' },
          folder: { type: 'string', description: 'Source subfolder (default: memory)' },
          toFolder: { type: 'string', description: 'Destination subfolder' },
          newKey: { type: 'string', description: 'Optional new key to rename the memory' },
        },
        required: ['key', 'toFolder'],
      },
      handler: adaptHandler(handleMove),
    },
  ];

  return tools;
}
