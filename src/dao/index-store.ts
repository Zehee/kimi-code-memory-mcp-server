/**
 * Low-level index.json storage: load, save, in-memory cache, backup, migration.
 *
 * The index is a rebuildable cache of the Markdown files. Every write goes
 * through an atomic replace so a crashed write can never leave a half written
 * index behind, and the schema is validated on load so corrupt data is
 * reported instead of silently ignored.
 */

import fs from 'fs';
import path from 'path';
import { Mutex } from '../utils/mutex.js';
import { atomicWriteFile } from '../utils/paths.js';
import { toTitle } from '../utils/validation.js';
import { workspaceLockRoot } from '../utils/workspace-lock.js';
import type { IndexData, IndexEntry } from './constants.js';
import { FALLBACK_FOLDER_COMMENTS } from './constants.js';

/** Index entry with the optional identity fields of a memory file. */
export interface IndexEntryValue extends IndexEntry {
  id?: string;
  revision?: number;
  contentHash?: string;
}

export interface IndexValidationResult {
  valid: boolean;
  errors: string[];
}

export type IndexState = 'empty' | 'fresh' | 'stale' | 'rebuilding' | 'corrupt';

function createEmptyIndex(): IndexData {
  return {
    version: '3-kv',
    meta: { lastSyncAt: null, structureHash: null },
    index: {},
  };
}

/**
 * Validate the complete schema of an index document.
 */
export function validateIndexData(value: unknown): IndexValidationResult {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { valid: false, errors: ['index root must be an object'] };
  }

  const root = value as Record<string, unknown>;
  if (root.version !== '3-kv') {
    errors.push(`unsupported index version: ${String(root.version)}`);
  }

  if (!root.meta || typeof root.meta !== 'object' || Array.isArray(root.meta)) {
    errors.push('meta must be an object');
  } else {
    const meta = root.meta as Record<string, unknown>;
    if (meta.lastSyncAt !== null && typeof meta.lastSyncAt !== 'string') {
      errors.push('meta.lastSyncAt must be a string or null');
    }
    if (meta.structureHash !== null && typeof meta.structureHash !== 'string') {
      errors.push('meta.structureHash must be a string or null');
    }
  }

  if (!root.index || typeof root.index !== 'object' || Array.isArray(root.index)) {
    errors.push('index must be an object');
  } else {
    for (const [key, entry] of Object.entries(root.index as Record<string, unknown>)) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`index entry "${key}" must be an object`);
        continue;
      }
      const value2 = entry as Record<string, unknown>;
      if (value2.title !== undefined && typeof value2.title !== 'string') {
        errors.push(`index entry "${key}".title must be a string`);
      }
      if (value2.comment !== undefined && typeof value2.comment !== 'string') {
        errors.push(`index entry "${key}".comment must be a string`);
      }
      if (value2.tags !== undefined) {
        if (!Array.isArray(value2.tags)) {
          errors.push(`index entry "${key}".tags must be an array`);
        } else if (value2.tags.some((tag) => typeof tag !== 'string')) {
          errors.push(`index entry "${key}".tags must only contain strings`);
        }
      }
      if (value2.id !== undefined && typeof value2.id !== 'string') {
        errors.push(`index entry "${key}".id must be a string`);
      }
      if (value2.revision !== undefined && typeof value2.revision !== 'number') {
        errors.push(`index entry "${key}".revision must be a number`);
      }
      if (value2.contentHash !== undefined && typeof value2.contentHash !== 'string') {
        errors.push(`index entry "${key}".contentHash must be a string`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export class IndexStore {
  storeRoot: string;
  backupRoot: string;
  lockRoot: string;
  private indexCache: IndexData | null;
  private indexCacheMtimeMs: number | null;
  private indexState: IndexState;
  private lastError: string | null;
  private mutex: Mutex;

  constructor(storeRoot: string, options: { backupRoot?: string; lockRoot?: string } = {}) {
    this.storeRoot = storeRoot;
    this.backupRoot = options.backupRoot || path.join(storeRoot, '..', 'backup');
    this.lockRoot = options.lockRoot ?? workspaceLockRoot(storeRoot);
    this.indexCache = null;
    this.indexCacheMtimeMs = null;
    this.indexState = 'empty';
    this.lastError = null;
    this.mutex = new Mutex();
  }

  get indexPath(): string {
    return path.join(this.storeRoot, 'index.json');
  }

  private currentMtimeMs(): number | null {
    try {
      return fs.statSync(this.indexPath).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Load the index from disk.
   *
   * The cached copy is reused while the file on disk is unchanged. Pass
   * `force` to re-read the file even when the cache looks fresh (used inside
   * the workspace lock before writing).
   */
  loadIndex(force = false): IndexData {
    if (!force && this.indexCache) {
      const mtime = this.currentMtimeMs();
      if (mtime === this.indexCacheMtimeMs) return this.indexCache;
    }

    if (!fs.existsSync(this.indexPath)) {
      this.indexCache = createEmptyIndex();
      this.indexCacheMtimeMs = null;
      this.indexState = 'empty';
      return this.indexCache;
    }

    try {
      const text = fs.readFileSync(this.indexPath, 'utf8');
      const parsed: unknown = JSON.parse(text);

      if (
        parsed &&
        typeof parsed === 'object' &&
        (parsed as { version?: unknown }).version === 1 &&
        typeof (parsed as { entries?: unknown }).entries === 'object'
      ) {
        // Legacy index format: back it up and migrate it in place.
        const backupId = this.getBackupId();
        this.backupIndex(backupId);
        const migrated = this.migrateV1ToV3(
          parsed as {
            entries: Record<
              string,
              { folder: string; key: string; title?: string; tags?: string[] }
            >;
          },
        );
        this.saveIndex(migrated);
        return migrated;
      }

      const validation = validateIndexData(parsed);

      if (validation.valid) {
        this.indexCache = parsed as IndexData;
        this.indexCacheMtimeMs = this.currentMtimeMs();
        this.indexState = 'fresh';
        this.lastError = null;
        return this.indexCache;
      }

      this.lastError = validation.errors.join('; ');
      this.indexState = 'corrupt';
      this.backupIndex(`corrupt-${this.getBackupId()}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.indexState = 'corrupt';
      this.backupIndex(`corrupt-${this.getBackupId()}`);
    }

    this.indexCache = createEmptyIndex();
    this.indexCacheMtimeMs = null;
    return this.indexCache;
  }

  /** Re-read the index from disk, discarding the cached copy. */
  reloadIndex(): IndexData {
    return this.loadIndex(true);
  }

  saveIndex(index: IndexData): void {
    index.meta.lastSyncAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.indexPath), { recursive: true });
    atomicWriteFile(this.indexPath, JSON.stringify(index, null, 2), 'utf8');
    this.indexCache = index;
    this.indexCacheMtimeMs = this.currentMtimeMs();
    this.indexState = 'fresh';
  }

  getIndex(): IndexData {
    return this.loadIndex();
  }

  /** Mark a reconcile as currently running (drives the `rebuilding` state). */
  markRebuilding(running: boolean): void {
    if (running) {
      this.indexState = 'rebuilding';
    } else if (this.indexState === 'rebuilding') {
      this.indexState = 'fresh';
    }
  }

  /** Freshness information about the cached index. */
  getIndexState(): { state: IndexState; lastError: string | null; lastSyncAt: string | null } {    const index = this.loadIndex();
    return {
      state: this.indexState,
      lastError: this.lastError,
      lastSyncAt: index.meta.lastSyncAt ?? null,
    };
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
