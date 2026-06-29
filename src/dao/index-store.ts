/**
 * Low-level index.json storage: load, save, in-memory cache, backup, migration.
 */

import fs from 'fs';
import path from 'path';
import { Mutex } from '../utils/mutex.js';
import { toTitle } from '../utils/validation.js';
import type { IndexData } from './constants.js';
import { FALLBACK_FOLDER_COMMENTS } from './constants.js';

function createEmptyIndex(): IndexData {
  return {
    version: '3-kv',
    meta: { lastSyncAt: null, structureHash: null },
    index: {},
  };
}

export class IndexStore {
  storeRoot: string;
  backupRoot: string;
  private indexCache: IndexData | null;
  private mutex: Mutex;

  constructor(storeRoot: string, options: { backupRoot?: string } = {}) {
    this.storeRoot = storeRoot;
    this.backupRoot = options.backupRoot || path.join(storeRoot, '..', 'backup');
    this.indexCache = null;
    this.mutex = new Mutex();
  }

  get indexPath(): string {
    return path.join(this.storeRoot, 'index.json');
  }

  loadIndex(): IndexData {
    if (this.indexCache) return this.indexCache;

    if (!fs.existsSync(this.indexPath)) {
      this.indexCache = createEmptyIndex();
      return this.indexCache;
    }

    try {
      const text = fs.readFileSync(this.indexPath, 'utf8');
      const parsed: unknown = JSON.parse(text);

      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { version?: unknown }).version === '3-kv' &&
        typeof (parsed as { index?: unknown }).index === 'object'
      ) {
        this.indexCache = parsed as IndexData;
        return this.indexCache;
      }

      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { version?: unknown }).version === 1 &&
        typeof (parsed as { entries?: unknown }).entries === 'object'
      ) {
        const backupId = this.getBackupId();
        this.backupIndex(backupId);
        this.indexCache = this.migrateV1ToV3(
          parsed as {
            entries: Record<
              string,
              { folder: string; key: string; title?: string; tags?: string[] }
            >;
          },
        );
        this.saveIndex(this.indexCache);
        return this.indexCache;
      }
    } catch {
      // Corrupt index: fall through to empty index.
    }

    this.indexCache = createEmptyIndex();
    return this.indexCache;
  }

  saveIndex(index: IndexData): void {
    index.meta.lastSyncAt = new Date().toISOString();
    const tmpPath = this.indexPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.indexPath);
    this.indexCache = index;
  }

  getIndex(): IndexData {
    return this.loadIndex();
  }

  getBackupId(): string {
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

  backupIndex(backupId: string): { backedUp: boolean; backupPath?: string } {
    if (!fs.existsSync(this.indexPath)) return { backedUp: false };
    const backupPath = path.join(this.backupRoot, backupId);
    fs.mkdirSync(backupPath, { recursive: true });
    const dest = path.join(backupPath, 'index.json');
    fs.copyFileSync(this.indexPath, dest);
    return { backedUp: true, backupPath: dest };
  }

  migrateV1ToV3(v1: {
    entries?: Record<string, { folder?: string; key?: string; title?: string; tags?: string[] }>;
  }): IndexData {
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

  async runExclusive<T>(fn: () => T): Promise<T> {
    return this.mutex.runExclusive(fn);
  }
}
