/**
 * Memory CRUD tools: remember, recall, recall_recent, search, list, list_tags, delete, move.
 */

import fs from 'fs';
import path from 'path';
import { sanitizeFolder, sanitizeKey, toTitle } from '../utils/validation.js';
import { parseFrontmatter } from '../utils/frontmatter.js';

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

export function createMemoryTools(ctx) {
  const { storeRoot, indexDao, themeManager } = ctx;

  function resolveFilePath(folder, key) {
    return path.join(storeRoot, folder, `${sanitizeKey(key)}.md`);
  }

  function handleRemember(args) {
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

    const folderPath = path.join(storeRoot, folder);
    fs.mkdirSync(folderPath, { recursive: true });

    const fileName = `${sanitizeKey(key)}.md`;
    const filePath = path.join(folderPath, fileName);

    let createdAt = new Date().toISOString();
    let title = toTitle(key);

    if (fs.existsSync(filePath)) {
      const parsed = safeParseFile(filePath);
      if (parsed && parsed.frontmatter) {
        if (parsed.frontmatter.createdAt) createdAt = parsed.frontmatter.createdAt;
        if (parsed.frontmatter.title) title = parsed.frontmatter.title;
      }
    }

    const updatedAt = new Date().toISOString();
    const frontmatter = { key, title, tags, createdAt, updatedAt };
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

    fs.writeFileSync(filePath, fileContent, 'utf8');
    indexDao.upsertEntry(filePath);

    const sanitizedKey = sanitizeKey(key);
    for (const theme of themes) {
      themeManager.addThemeAssociation(theme, {
        memoryKey: sanitizedKey,
        folder,
        title,
      });
    }

    return toolResult({ success: true, filePath, folder, key, themes });
  }

  function handleRecall(args) {
    const key = args.key;
    if (!key || typeof key !== 'string') {
      return toolResult({ found: false, error: 'Missing or invalid "key"' }, true);
    }

    const folderRaw = typeof args.folder === 'string' ? args.folder : 'memory';
    const folder = sanitizeFolder(folderRaw);
    if (!folder) {
      return toolResult({ found: false, error: 'Invalid folder path', key }, true);
    }
    const filePath = resolveFilePath(folder, key);

    if (!fs.existsSync(filePath)) {
      return toolResult({ found: false, key, folder });
    }

    const parsed = safeParseFile(filePath);
    if (!parsed) {
      return toolResult({ found: false, key, folder, error: 'Failed to read file' }, true);
    }

    indexDao.upsertEntry(filePath);

    return toolResult({
      found: true,
      key,
      folder,
      content: parsed.body,
      tags: Array.isArray(parsed.frontmatter.tags) ? parsed.frontmatter.tags : [],
      createdAt: parsed.frontmatter.createdAt || null,
      updatedAt: parsed.frontmatter.updatedAt || null,
    });
  }

  function handleRecallRecent(args) {
    const n = typeof args.n === 'number' ? Math.max(1, Math.floor(args.n)) : 10;
    const folderFilterRaw = typeof args.folder === 'string' ? args.folder : null;
    const folderFilter = folderFilterRaw ? sanitizeFolder(folderFilterRaw) : null;
    if (folderFilterRaw && !folderFilter) {
      return toolResult({ items: [], error: 'Invalid folder path' }, true);
    }
    const tagFilter = typeof args.tag === 'string' ? args.tag : null;

    const index = indexDao.getIndex();
    const items = [];
    for (const key of Object.keys(index.index)) {
      if (!key.endsWith('.md')) continue;
      const value = index.index[key];
      const folder = path.dirname(key);
      const entryKey = path.basename(key, '.md');

      if (folderFilter && folder !== folderFilter) continue;
      if (tagFilter && (!Array.isArray(value.tags) || !value.tags.includes(tagFilter))) continue;

      const filePath = path.join(storeRoot, key);
      const stats = fileStats(filePath);
      items.push({
        key: entryKey,
        folder,
        title: value.title || toTitle(entryKey),
        tags: Array.isArray(value.tags) ? value.tags : [],
        updatedAt: stats ? stats.mtime.toISOString() : new Date().toISOString(),
        preview: '',
      });
    }

    items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    return toolResult({
      items: items.slice(0, n).map((item) => {
        const filePath = resolveFilePath(item.folder, item.key);
        const parsed = safeParseFile(filePath);
        return {
          ...item,
          preview: (parsed?.body || '').slice(0, 400),
        };
      }),
    });
  }

  function handleSearch(args) {
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

  function handleList(args) {
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
      if (folderFilter && folder !== folderFilter) continue;

      const filePath = path.join(storeRoot, key);
      const stats = fileStats(filePath);
      items.push({
        key: path.basename(key, '.md'),
        folder,
        title: value.title || toTitle(path.basename(key, '.md')),
        tags: Array.isArray(value.tags) ? value.tags : [],
        updatedAt: stats ? stats.mtime.toISOString() : new Date().toISOString(),
        size: stats ? stats.size : 0,
      });
    }

    items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    return toolResult({ items });
  }

  function handleDelete(args) {
    const key = args.key;
    if (!key || typeof key !== 'string') {
      return toolResult({ success: false, error: 'Missing or invalid "key"' }, true);
    }

    const folderRaw = typeof args.folder === 'string' ? args.folder : 'memory';
    const folder = sanitizeFolder(folderRaw);
    if (!folder) {
      return toolResult({ success: false, error: 'Invalid folder path', key }, true);
    }
    const filePath = resolveFilePath(folder, key);

    if (!fs.existsSync(filePath)) {
      return toolResult({ success: false, key, folder, error: 'Memory not found' }, true);
    }

    const relativePath = path.relative(storeRoot, filePath).replace(/\\/g, '/');
    fs.unlinkSync(filePath);
    indexDao.deleteEntryByPath(relativePath);

    return toolResult({ success: true, key, folder });
  }

  function handleMove(args) {
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

    const srcPath = resolveFilePath(folder, key);
    if (!fs.existsSync(srcPath)) {
      return toolResult({ success: false, key, folder, error: 'Memory not found' }, true);
    }

    const destFolderPath = path.join(storeRoot, toFolder);
    fs.mkdirSync(destFolderPath, { recursive: true });
    const destPath = path.join(destFolderPath, `${newKey}.md`);

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

    fs.renameSync(srcPath, destPath);

    if (newKey !== sanitizeKey(key)) {
      const parsed = safeParseFile(destPath);
      if (parsed && parsed.frontmatter) {
        parsed.frontmatter.key = newKeyRaw;
        const updatedContent =
          '---\n' +
          Object.entries(parsed.frontmatter)
            .map(([k, v]) => {
              if (Array.isArray(v)) {
                return `${k}:\n${v.map((item) => `  - ${item}`).join('\n')}`;
              }
              return `${k}: '${String(v).replace(/'/g, "''")}'`;
            })
            .join('\n') +
          '\n---\n\n' +
          parsed.body;
        fs.writeFileSync(destPath, updatedContent, 'utf8');
      }
    }

    indexDao.moveEntry(oldRelativePath, newRelativePath);

    return toolResult({ success: true, key, newKey, fromFolder: folder, toFolder });
  }

  return {
    handleRemember,
    handleRecall,
    handleRecallRecent,
    handleSearch,
    handleListTags,
    handleList,
    handleDelete,
    handleMove,
  };
}
