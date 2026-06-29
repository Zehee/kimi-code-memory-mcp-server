/**
 * index.json v3-kv DAO.
 *
 * File layer is the source of truth; index.json is a rebuildable cache of
 * metadata (title, tags, folder comments).
 *
 * IndexDao is a thin facade over IndexStore, IndexReconciler, IndexCatalog, and
 * MemoryIndexTreeRenderer.
 */

import path from 'path';
import { relativeStorePath } from '../utils/paths.js';
import type { IndexData, IndexEntry, ReconcileOptions, ReconcileResult } from './constants.js';
import { FALLBACK_FOLDER_COMMENTS } from './constants.js';
import { IndexStore } from './index-store.js';
import { IndexReconciler } from './index-reconciler.js';
import { IndexCatalog } from './index-catalog.js';
import { MemoryIndexTreeRenderer } from './memory-tree-renderer.js';

export * from './constants.js';
export type { TreeNode } from './memory-tree-renderer.js';

export class IndexDao {
  storeRoot: string;
  backupRoot: string;
  indexCache: IndexData | null;
  private store: IndexStore;
  private reconciler: IndexReconciler;
  private catalog: IndexCatalog;
  private renderer: MemoryIndexTreeRenderer;

  constructor(storeRoot: string, options: { backupRoot?: string } = {}) {
    this.storeRoot = storeRoot;
    this.backupRoot = options.backupRoot || path.join(storeRoot, '..', 'backup');
    this.indexCache = null;
    this.store = new IndexStore(storeRoot, options);
    this.reconciler = new IndexReconciler(storeRoot, this.store);
    this.catalog = new IndexCatalog(storeRoot, this.store);
    this.renderer = new MemoryIndexTreeRenderer();
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

  buildEntryValueFromFile(filePath: string): IndexEntry {
    return this.reconciler.buildEntryValueFromFile(filePath);
  }

  async reconcileIndex(options: ReconcileOptions = {}): Promise<ReconcileResult> {
    return this.store.runExclusive(() => this.reconciler.reconcileIndex(options));
  }

  async upsertEntry(filePath: string): Promise<void> {
    return this.store.runExclusive(() => {
      const relativePath = relativeStorePath(this.storeRoot, filePath);
      if (!relativePath.endsWith('.md')) return;

      const index = this.store.getIndex();
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
    });
  }

  async deleteEntryByPath(relativePath: string): Promise<void> {
    return this.store.runExclusive(() => {
      const index = this.store.getIndex();
      delete index.index[relativePath];
      index.meta.structureHash = null;
      this.store.saveIndex(index);
    });
  }

  async moveEntry(oldRelativePath: string, newRelativePath: string): Promise<void> {
    return this.store.runExclusive(() => {
      const index = this.store.getIndex();
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
    });
  }

  async setFolderComment(folderPath: string, comment: string): Promise<void> {
    return this.store.runExclusive(() => {
      let normalizedPath = folderPath;
      if (!normalizedPath.endsWith('/')) normalizedPath += '/';
      const index = this.store.getIndex();
      index.index[normalizedPath] = { comment };
      this.store.saveIndex(index);
    });
  }

  listRefs(folder?: string): { key: string; folder: string; title: string; tags: string[] }[] {
    return this.catalog.listRefs(folder);
  }

  buildMemoryIndexTree(recentLimit = 5): string {
    const tree = this.catalog.buildMemoryTreeData();
    return this.renderer.render(tree, recentLimit);
  }
}
