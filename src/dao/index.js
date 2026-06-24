/**
 * index.json v3-kv DAO.
 *
 * File layer is the source of truth; index.json is a rebuildable cache of
 * metadata (title, tags, folder comments).
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { relativeStorePath } from '../utils/paths.js';
import { toTitle } from '../utils/validation.js';

const FALLBACK_FOLDER_COMMENTS = {
  memory: '完整记忆索引（按领域分组）',
  decisions: '关键产品/架构决策',
  rules: '协作规则与编码红线',
  knowledge: '项目知识',
  architecture: '架构与数据模型',
  frontend: '前端与渲染',
  product: '产品与版型',
  engineering: '工程实践',
  reference: '参考文档',
  notes: '日常速记',
  essence: '整理后的工作区精要',
};

function createEmptyIndex() {
  return {
    version: '3-kv',
    meta: { lastSyncAt: null, structureHash: null },
    index: {},
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

export class IndexDao {
  constructor(storeRoot, options = {}) {
    this.storeRoot = storeRoot;
    this.backupRoot = options.backupRoot || path.join(storeRoot, '..', 'backup');
    this.indexCache = null;
  }

  get indexPath() {
    return path.join(this.storeRoot, 'index.json');
  }

  loadIndex() {
    if (this.indexCache) return this.indexCache;

    if (!fs.existsSync(this.indexPath)) {
      this.indexCache = createEmptyIndex();
      return this.indexCache;
    }

    try {
      const text = fs.readFileSync(this.indexPath, 'utf8');
      const parsed = JSON.parse(text);

      if (parsed && parsed.version === '3-kv' && typeof parsed.index === 'object') {
        this.indexCache = parsed;
        return this.indexCache;
      }

      if (parsed && parsed.version === 1 && typeof parsed.entries === 'object') {
        const backupId = this.getBackupId();
        this.backupIndex(backupId);
        this.indexCache = this.migrateV1ToV3(parsed);
        this.saveIndex(this.indexCache);
        return this.indexCache;
      }
    } catch {
      // Corrupt index: fall through to empty index.
    }

    this.indexCache = createEmptyIndex();
    return this.indexCache;
  }

  saveIndex(index) {
    index.meta.lastSyncAt = new Date().toISOString();
    const tmpPath = this.indexPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.indexPath);
    this.indexCache = index;
  }

  getIndex() {
    return this.loadIndex();
  }

  getBackupId() {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const yymmdd = `${yy}${mm}${dd}`;
    let seq = 1;
    while (fs.existsSync(path.join(this.backupRoot, `${yymmdd}_${String(seq).padStart(2, '0')}`))) {
      seq++;
    }
    return `${yymmdd}_${String(seq).padStart(2, '0')}`;
  }

  backupIndex(backupId) {
    if (!fs.existsSync(this.indexPath)) return { backedUp: false };
    const backupPath = path.join(this.backupRoot, backupId);
    fs.mkdirSync(backupPath, { recursive: true });
    const dest = path.join(backupPath, 'index.json');
    fs.copyFileSync(this.indexPath, dest);
    return { backedUp: true, backupPath: dest };
  }

  migrateV1ToV3(v1) {
    const v3 = createEmptyIndex();
    const entries = v1.entries || {};
    for (const id of Object.keys(entries)) {
      const e = entries[id];
      if (!e || !e.folder || !e.key) continue;
      const relativePath = `${e.folder}/${e.key}.md`;
      v3.index[relativePath] = {
        title: e.title || toTitle(e.key),
        tags: Array.isArray(e.tags) ? e.tags : [],
      };
    }
    for (const key of Object.keys(v3.index)) {
      if (!key.endsWith('.md')) continue;
      const dir = path.dirname(key);
      const parts = dir.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        const folderPath = `${current}/`;
        if (!v3.index[folderPath]) {
          v3.index[folderPath] = { comment: FALLBACK_FOLDER_COMMENTS[part] || '' };
        }
      }
    }
    return v3;
  }

  computeStructureHash() {
    const paths = [];

    const scan = (dir, relativePrefix) => {
      if (!fs.existsSync(dir)) return false;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let hasContent = false;

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          const childHasContent = scan(path.join(dir, entry.name), relativePath);
          if (childHasContent) hasContent = true;
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const fullPath = path.join(dir, entry.name);
          const stats = fs.statSync(fullPath);
          paths.push(`${relativePath}:${stats.mtime.toISOString()}`);
          hasContent = true;
        }
      }

      if (!hasContent && relativePrefix) {
        paths.push(`${relativePrefix}/`);
      }

      return hasContent;
    };

    scan(path.join(this.storeRoot, 'memory'), 'memory');
    scan(path.join(this.storeRoot, 'notes'), 'notes');
    scan(path.join(this.storeRoot, 'essence'), 'essence');

    paths.sort();
    const content = paths.join('\n');
    return content ? crypto.createHash('md5').update(content).digest('hex') : '';
  }

  buildEntryValueFromFile(filePath) {
    const parsed = safeParseFile(filePath);
    const key = path.basename(filePath, '.md');
    const title = parsed?.frontmatter?.title || toTitle(key);
    const tags = Array.isArray(parsed?.frontmatter?.tags) ? parsed.frontmatter.tags : [];
    return { title, tags };
  }

  reconcileIndex(options = {}) {
    const index = this.getIndex();
    const currentHash = this.computeStructureHash();

    if (
      currentHash &&
      currentHash === index.meta.structureHash &&
      Object.keys(index.index).length > 0
    ) {
      let patched = false;
      if (options.folderComments) {
        for (let folderPath of Object.keys(options.folderComments)) {
          const comment = options.folderComments[folderPath];
          if (!folderPath.endsWith('/')) folderPath += '/';
          index.index[folderPath] = { comment };
          patched = true;
        }
      }
      if (patched) {
        this.saveIndex(index);
      }
      return {
        synced: true,
        skipped: true,
        structureHash: currentHash,
        report: {
          scannedFiles: 0,
          addedEntries: 0,
          removedEntries: 0,
          updatedEntries: 0,
          addedFolders: 0,
        },
      };
    }

    const report = {
      scannedFiles: 0,
      addedEntries: 0,
      removedEntries: 0,
      updatedEntries: 0,
      addedFolders: 0,
    };

    const diskFiles = new Set();

    const scanDir = (dir, relativePrefix) => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          scanDir(path.join(dir, entry.name), relativePath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          diskFiles.add(relativePath);
          report.scannedFiles++;

          const value = this.buildEntryValueFromFile(path.join(this.storeRoot, relativePath));
          const existing = index.index[relativePath];

          if (!existing) {
            index.index[relativePath] = value;
            report.addedEntries++;
          } else if (
            existing.title !== value.title ||
            JSON.stringify(existing.tags) !== JSON.stringify(value.tags)
          ) {
            index.index[relativePath] = value;
            report.updatedEntries++;
          }

          const dirPath = path.dirname(relativePath);
          const parts = dirPath.split('/').filter(Boolean);
          let current = '';
          for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            const folderPath = `${current}/`;
            if (!(folderPath in index.index)) {
              index.index[folderPath] = { comment: FALLBACK_FOLDER_COMMENTS[part] || '' };
              report.addedFolders++;
            }
          }
        }
      }
    };

    scanDir(path.join(this.storeRoot, 'memory'), 'memory');
    scanDir(path.join(this.storeRoot, 'notes'), 'notes');
    scanDir(path.join(this.storeRoot, 'essence'), 'essence');

    for (const key of Object.keys(index.index)) {
      if (key.endsWith('.md') && !diskFiles.has(key)) {
        delete index.index[key];
        report.removedEntries++;
      }
    }

    if (options.folderComments) {
      for (let folderPath of Object.keys(options.folderComments)) {
        const comment = options.folderComments[folderPath];
        if (!folderPath.endsWith('/')) folderPath += '/';
        index.index[folderPath] = { comment };
      }
    }

    index.meta.structureHash = currentHash;
    this.saveIndex(index);

    return { synced: true, skipped: false, structureHash: currentHash, report };
  }

  upsertEntry(filePath) {
    const relativePath = relativeStorePath(this.storeRoot, filePath);
    if (!relativePath.endsWith('.md')) return;

    const index = this.getIndex();
    index.index[relativePath] = this.buildEntryValueFromFile(filePath);

    const dirPath = path.dirname(relativePath);
    const parts = dirPath.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const folderPath = `${current}/`;
      if (!(folderPath in index.index)) {
        index.index[folderPath] = { comment: FALLBACK_FOLDER_COMMENTS[part] || '' };
      }
    }

    index.meta.structureHash = null;
    this.saveIndex(index);
  }

  deleteEntryByPath(relativePath) {
    const index = this.getIndex();
    delete index.index[relativePath];
    index.meta.structureHash = null;
    this.saveIndex(index);
  }

  moveEntry(oldRelativePath, newRelativePath) {
    const index = this.getIndex();
    if (index.index[oldRelativePath]) {
      index.index[newRelativePath] = index.index[oldRelativePath];
      delete index.index[oldRelativePath];

      const dirPath = path.dirname(newRelativePath);
      const parts = dirPath.split('/').filter(Boolean);
      let current = '';
      for (const part of parts) {
        current = current ? `${current}/${part}` : part;
        const folderPath = `${current}/`;
        if (!(folderPath in index.index)) {
          index.index[folderPath] = { comment: FALLBACK_FOLDER_COMMENTS[part] || '' };
        }
      }
    }
    index.meta.structureHash = null;
    this.saveIndex(index);
  }

  setFolderComment(folderPath, comment) {
    if (!folderPath.endsWith('/')) folderPath += '/';
    const index = this.getIndex();
    index.index[folderPath] = { comment };
    this.saveIndex(index);
  }

  listRefs(folder) {
    const index = this.getIndex().index;
    const prefix = folder ? (folder.endsWith('/') ? folder : `${folder}/`) : '';
    const keys = Object.keys(index).filter((k) => {
      if (!k.endsWith('.md')) return false;
      return !prefix || k.startsWith(prefix);
    });

    return keys
      .map((k) => {
        const value = index[k];
        return {
          key: path.basename(k, '.md'),
          folder: path.dirname(k),
          title: value.title || toTitle(path.basename(k, '.md')),
          tags: Array.isArray(value.tags) ? value.tags : [],
        };
      })
      .sort((a, b) => a.folder.localeCompare(b.folder) || a.key.localeCompare(b.key));
  }

  buildMemoryIndexTree(recentLimit = 5) {
    const index = this.getIndex().index;

    const root = {
      name: 'memory',
      children: new Map(),
      files: [],
      comment: index['memory/']?.comment || '',
    };

    const timeEntries = [];

    for (const key of Object.keys(index)) {
      if (!key.startsWith('memory/')) continue;

      if (key.endsWith('/')) {
        if (key === 'memory/') continue;
        const relativeFolder = key.slice(7, -1);
        const parts = relativeFolder ? relativeFolder.split('/') : [];
        let current = root;
        for (const part of parts) {
          if (!current.children.has(part)) {
            current.children.set(part, { name: part, children: new Map(), files: [], comment: '' });
          }
          current = current.children.get(part);
        }
        current.comment = index[key].comment || '';
      } else if (key.endsWith('.md')) {
        const relativePath = key.slice(7);
        const dirPart = path.dirname(relativePath);
        const parts = dirPart === '.' ? [] : dirPart.split('/');
        const fileName = path.basename(key, '.md');
        const value = index[key];
        let current = root;
        for (const part of parts) {
          if (!current.children.has(part)) {
            current.children.set(part, { name: part, children: new Map(), files: [], comment: '' });
          }
          current = current.children.get(part);
        }
        current.files.push({
          key: fileName,
          title: value.title || toTitle(fileName),
          tags: Array.isArray(value.tags) ? value.tags : [],
        });

        const filePath = path.join(this.storeRoot, key);
        const parsed = safeParseFile(filePath);
        const updatedAt = parsed?.frontmatter?.updatedAt || '';
        const createdAt = parsed?.frontmatter?.createdAt || '';
        timeEntries.push({
          fullPath: key.slice(0, -3),
          updatedAt,
          createdAt,
        });
      }
    }

    const recentKeys = new Set(
      timeEntries
        .sort((a, b) => {
          const aUpdated = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bUpdated = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          if (bUpdated !== aUpdated) return bUpdated - aUpdated;
          const aCreated = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bCreated = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return bCreated - aCreated;
        })
        .slice(0, recentLimit)
        .map((e) => e.fullPath),
    );

    const renderNode = (node, nodePath, prefix = '', isLast = true, isRoot = false) => {
      const lines = [];
      const comment = node.comment;
      if (isRoot) {
        lines.push(`${node.name}/${comment ? ` — ${comment}` : ''}`);
      } else {
        const connector = prefix === '' ? '' : isLast ? '└── ' : '├── ';
        lines.push(`${prefix}${connector}${node.name}/${comment ? ` — ${comment}` : ''}`);
      }

      const childEntries = Array.from(node.children.entries()).sort((a, b) =>
        a[0].localeCompare(b[0]),
      );
      const allFiles = [...node.files].sort((a, b) => a.key.localeCompare(b.key));
      const items = [
        ...childEntries.map(([name, childNode]) => ({ type: 'folder', name, data: childNode })),
        ...allFiles.map((file) => ({ type: 'file', name: file.key, data: file })),
      ];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const isLastItem = i === items.length - 1;
        const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
        if (item.type === 'folder') {
          lines.push(
            ...renderNode(item.data, `${nodePath}/${item.name}`, childPrefix, isLastItem, false),
          );
        } else {
          const file = item.data;
          const fileConnector = isLastItem ? '└── ' : '├── ';
          const tagStr = file.tags.length > 0 ? ` [${file.tags.join(', ')}]` : '';
          const newMark = recentKeys.has(`${nodePath}/${file.key}`) ? ' [new]' : '';
          lines.push(
            `${childPrefix}${fileConnector}${file.key} — ${file.title}${tagStr}${newMark}`,
          );
        }
      }

      return lines;
    };

    return renderNode(root, 'memory', '', true, true).join('\n');
  }
}
