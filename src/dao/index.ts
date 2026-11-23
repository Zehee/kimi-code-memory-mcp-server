/**
 * index.json v3-kv DAO.
 *
 * File layer is the source of truth; index.json is a rebuildable cache of
 * metadata (title, tags, folder comments).
 *
 * IndexDao is a thin facade over IndexStore, IndexReconciler, IndexCatalog, and
 * MemoryIndexTreeRenderer. Every mutating operation runs inside the
 * workspace lock and re-reads the index from disk, so a concurrent process
 * cannot be overwritten with a stale cache.
 */

import path from 'path';
import { relativeStorePath } from '../utils/paths.js';
import { metrics } from '../utils/metrics.js';
import { WorkspaceLock, WORKSPACE_LOCK_KEY, workspaceLockRoot } from '../utils/workspace-lock.js';
import type { IndexData, ReconcileOptions } from './constants.js';
import { FALLBACK_FOLDER_COMMENTS } from './constants.js';
import { IndexStore } from './index-store.js';
import type { IndexEntryValue } from './index-store.js';
import { IndexReconciler } from './index-reconciler.js';
import type { ReconcileOutcome } from './index-reconciler.js';
import { IndexCatalog } from './index-catalog.js';
import { MemoryIndexTreeRenderer, type TreeNode } from './memory-tree-renderer.js';

export * from './constants.js';
export type { TreeNode } from './memory-tree-renderer.js';
export type { IndexEntryValue } from './index-store.js';
export type { ReconcileOutcome } from './index-reconciler.js';

/** How often the memoized freshness probe may re-run (ms). */
const CHECK_TTL_MS = 2_000;

export class IndexDao {
  storeRoot: string;
  backupRoot: string;
  lockRoot: string;
  indexCache: IndexData | null;
  private store: IndexStore;
  private reconciler: IndexReconciler;
  private catalog: IndexCatalog;
  private renderer: MemoryIndexTreeRenderer;
  private lock: WorkspaceLock;
  private freshnessCheck: { checkedAt: number; result: 'fresh' | 'stale' } | null = null;

  constructor(storeRoot: string, options: { backupRoot?: string; lockRoot?: string } = {}) {
    this.storeRoot = storeRoot;
    this.backupRoot = options.backupRoot || path.join(storeRoot, '..', 'backup');
    this.lockRoot = options.lockRoot ?? workspaceLockRoot(storeRoot);
    this.indexCache = null;
    this.store = new IndexStore(storeRoot, { ...options, lockRoot: this.lockRoot });
    this.reconciler = new IndexReconciler(storeRoot, this.store);
    this.catalog = new IndexCatalog(storeRoot, this.store);
    this.renderer = new MemoryIndexTreeRenderer();
    this.lock = new WorkspaceLock(this.lockRoot);
  }

  get indexPath(): string {
    return this.store.indexPath;
  }

  loadIndex(): IndexData {
    return this.store.loadIndex();
  }

  saveIndex(index: IndexData): void {
    this.store.saveIndex(index);
  }

  getIndex(): IndexData {
    return this.store.getIndex();
  }

  /** Freshness information about the index cache. */
  getIndexState(): { state: string; lastError: string | null; lastSyncAt: string | null } {
    const base = this.store.getIndexState();
    if (base.state === 'rebuilding') return base;
    // Low-cost freshness probe: a memoized structure-hash comparison (TTL
    // 2s) tells ordinary reads whether the Markdown authority drifted ahead
    // of the index. A drifted index is still served, but marked `stale` so
    // callers can decide to `sync_workspace_index`.
    if (base.state === 'fresh') {
      const current = this.checkFreshness();
      if (current === 'stale') {
        metrics.increment('index_state_stale_reads');
        return { ...base, state: 'stale' };
      }
    }
    return base;
  }

  /**
   * Memoized structure-hash comparison. Returns `stale` when the disk
   * structure differs from the hash recorded at the last reconcile, `fresh`
   * otherwise. The check itself runs at most once per `CHECK_TTL_MS`.
   */
  checkFreshness(): 'fresh' | 'stale' {
    const now = Date.now();
    if (this.freshnessCheck && now - this.freshnessCheck.checkedAt < CHECK_TTL_MS) {
      return this.freshnessCheck.result;
    }
    const index = this.store.getIndex();
    const recorded = index.meta.structureHash;
    let result: 'fresh' | 'stale' = 'fresh';
    if (Object.keys(index.index).length > 0) {
      if (!recorded) {
        // Entries exist but no structure hash was recorded (e.g. after a
        // single-entry upsert): the index cannot prove it matches the disk.
        result = 'stale';
      } else {
        const current = this.reconciler.computeStructureHash();
        result = current === recorded ? 'fresh' : 'stale';
      }
    }
    this.freshnessCheck = { checkedAt: now, result };
    return result;
  }

  /** Invalidate the memoized freshness probe (callers that just wrote). */
  invalidateFreshness(): void {
    this.freshnessCheck = null;
  }

  getBackupId(): string {
    return this.store.getBackupId();
  }

  backupIndex(backupId: string): { backedUp: boolean; backupPath?: string } {
    return this.store.backupIndex(backupId);
  }

  migrateV1ToV3(v1: {
    entries?: Record<string, { folder?: string; key?: string; title?: string; tags?: string[] }>;
  }): IndexData {
    return this.store.migrateV1ToV3(v1);
  }

  computeStructureHash(): string {
    return this.reconciler.computeStructureHash();
  }

  buildEntryValueFromFile(filePath: string): IndexEntryValue {
    return this.reconciler.buildEntryValueFromFile(filePath);
  }

  async reconcileIndex(options: ReconcileOptions = {}): Promise<ReconcileOutcome> {
    this.store.markRebuilding(true);
    try {
      return await this.lock.withLock(WORKSPACE_LOCK_KEY, async () => {
        const outcome = await metrics.timed('index_reconcile', () =>
          this.store.runExclusive(() => this.reconciler.reconcileIndex(options)),
        );
        metrics.increment('index_reconciles');
        if (outcome.corruptFiles.length > 0) {
          metrics.increment('corrupt_files_quarantined', outcome.corruptFiles.length);
        }
        this.freshnessCheck = null;
        return outcome;
      });
    } finally {
      this.store.markRebuilding(false);
    }
  }

  async upsertEntry(filePath: string): Promise<void> {
    return this.lock.withLock(WORKSPACE_LOCK_KEY, () =>
      this.store.runExclusive(() => {
        const relativePath = relativeStorePath(this.storeRoot, filePath);
        if (!relativePath.endsWith('.md')) return;

        const index = this.store.reloadIndex();
        index.index[relativePath] = this.reconciler.buildEntryValueFromFile(filePath);

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
        this.store.saveIndex(index);
      }),
    );
  }

  async deleteEntryByPath(relativePath: string): Promise<void> {
    return this.lock.withLock(WORKSPACE_LOCK_KEY, () =>
      this.store.runExclusive(() => {
        const index = this.store.reloadIndex();
        delete index.index[relativePath];
        index.meta.structureHash = null;
        this.store.saveIndex(index);
      }),
    );
  }

  async moveEntry(oldRelativePath: string, newRelativePath: string): Promise<void> {
    return this.lock.withLock(WORKSPACE_LOCK_KEY, () =>
      this.store.runExclusive(() => {
        const index = this.store.reloadIndex();
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
        this.store.saveIndex(index);
      }),
    );
  }

  async setFolderComment(folderPath: string, comment: string): Promise<void> {
    return this.lock.withLock(WORKSPACE_LOCK_KEY, () =>
      this.store.runExclusive(() => {
        let normalizedPath = folderPath;
        if (!normalizedPath.endsWith('/')) normalizedPath += '/';
        const index = this.store.reloadIndex();
        index.index[normalizedPath] = { comment };
        this.store.saveIndex(index);
      }),
    );
  }

  listRefs(folder?: string): { key: string; folder: string; title: string; tags: string[] }[] {
    return this.catalog.listRefs(folder);
  }

  buildMemoryTreeData(): TreeNode {
    return this.catalog.buildMemoryTreeData();
  }

  buildMemoryIndexTree(recentLimit = 5): string {
    const tree = this.catalog.buildMemoryTreeData();
    return this.renderer.render(tree, recentLimit);
  }
}
