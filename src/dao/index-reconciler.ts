/**
 * Index reconciler: directory scanning, structure hashing, and full rebuild.
 *
 * The reconciler runs inside the workspace lock and always re-reads the
 * Markdown files from disk. When the body of a memory file changed outside of
 * this service (for example a manual edit) the revision of that memory is
 * bumped so that optimistic concurrency checks cannot be bypassed.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { toTitle } from '../utils/validation.js';
import type { ReconcileOptions, ReconcileReport, ReconcileResult } from './constants.js';
import { FALLBACK_FOLDER_COMMENTS } from './constants.js';
import type { IndexStore } from './index-store.js';
import type { IndexEntryValue } from './index-store.js';
import { MemoryStore, type MemoryIdentity } from './memory-store.js';
import { ThemeManager } from '../theme-manager.js';
import { faultPoint } from '../utils/fault-injection.js';

export interface ReconcileOutcome extends ReconcileResult {
  /** Files whose content changed outside of this service. */
  revisionsBumped: number;
  /** Files that could not be parsed. */
  corruptFiles: string[];
  /** Errors that happened while a file was processed. */
  errors: string[];
}

export class IndexReconciler {
  storeRoot: string;
  private store: IndexStore;
  private memoryStore: MemoryStore;
  private themeManager: ThemeManager;

  constructor(storeRoot: string, store: IndexStore) {
    this.storeRoot = storeRoot;
    this.store = store;
    this.memoryStore = new MemoryStore(storeRoot);
    this.themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
  }

  computeStructureHash(): string {
    const paths: string[] = [];

    const scan = (dir: string, relativePrefix: string): boolean => {
      if (!fs.existsSync(dir)) return false;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let hasContent = false;

      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          // Essence history copies are retained backups, not index content.
          if (relativePrefix === 'essence' && entry.name === 'history') continue;
          const childHasContent = scan(path.join(dir, entry.name), relativePath);
          if (childHasContent) hasContent = true;
        } else if (entry.isSymbolicLink()) {
          // Linked entries may point outside the store: never followed.
          continue;
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          const fullPath = path.join(dir, entry.name);
          // bigint stat exposes nanosecond mtimes, catching rewrites that
          // land inside the same millisecond.
          const stats = fs.statSync(fullPath, { bigint: true });
          // Size catches rewrites that land inside the same mtime tick.
          paths.push(`${relativePath}:${stats.size}:${stats.mtimeNs}`);
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

  buildEntryValueFromFile(filePath: string): IndexEntryValue {
    const inspection = this.memoryStore.inspectFile(filePath);
    return this.toEntryValue(filePath, inspection);
  }

  private toEntryValue(
    filePath: string,
    inspection: { frontmatter: Record<string, unknown>; identity: MemoryIdentity } | null,
  ): IndexEntryValue {
    const key = path.basename(filePath, '.md');
    const frontmatter = inspection?.frontmatter as
      | { title?: unknown; tags?: unknown }
      | undefined;
    const title = String(frontmatter?.title || toTitle(key));
    const tags = Array.isArray(frontmatter?.tags)
      ? frontmatter.tags.map((tag) => String(tag))
      : [];
    const value: IndexEntryValue = { title, tags };
    if (inspection) {
      value.id = inspection.identity.id;
      value.revision = inspection.identity.revision;
      value.contentHash = inspection.identity.contentHash;
    }
    return value;
  }

  async reconcileIndex(options: ReconcileOptions = {}): Promise<ReconcileOutcome> {
    // Always work on the version that is currently on disk.
    const index = this.store.reloadIndex();
    const currentHash = this.computeStructureHash();

    const report: ReconcileReport = {
      scannedFiles: 0,
      addedEntries: 0,
      removedEntries: 0,
      updatedEntries: 0,
      addedFolders: 0,
    };
    const corruptFiles: string[] = [];
    const errors: string[] = [];
    const existingIds = new Set<string>();
    const existingLocations = new Map<
      string,
      { folder: string; key: string; title?: string; revision?: number; contentHash?: string }
    >();
    /** First path seen per stable id — used to detect duplicates. */
    const idSeenPaths = new Map<string, string>();
    /** Ids that appear on more than one file: never auto-merged or re-pointed. */
    const duplicateIds = new Set<string>();
    let revisionsBumped = 0;

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
        this.store.saveIndex(index);
      }
      return {
        synced: true,
        skipped: true,
        structureHash: currentHash,
        report,
        revisionsBumped: 0,
        corruptFiles,
        errors,
      };
    }

    const diskFiles = new Set<string>();

    const scanDir = (dir: string, relativePrefix: string): void => {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const relativePath = relativePrefix ? `${relativePrefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
          // Essence history copies are retained backups, not index content.
          if (relativePrefix === 'essence' && entry.name === 'history') continue;
          scanDir(path.join(dir, entry.name), relativePath);
        } else if (entry.isSymbolicLink()) {
          // Linked entries may point outside the store: never followed, and
          // reported so the skip is visible instead of silent.
          errors.push(`symlink skipped (not followed): ${relativePath}`);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          diskFiles.add(relativePath);
          report.scannedFiles++;

          const fullPath = path.join(this.storeRoot, relativePath);
          const isMemory = relativePath.startsWith('memory/') || relativePath.startsWith('notes/');
          const inspection = this.memoryStore.inspectFile(fullPath, {
            assignIdentity: isMemory,
          });
          const value = this.toEntryValue(fullPath, inspection);
          if (!inspection) {
            corruptFiles.push(relativePath);
          } else if (isMemory) {
            if (inspection.identity.id) {
              const stableId = inspection.identity.id;
              existingIds.add(stableId);
              const firstPath = idSeenPaths.get(stableId);
              if (firstPath) {
                // The migration contract: duplicate ids are never merged and
                // never silently re-pointed — report and leave the references
                // untouched (review P1 #2).
                duplicateIds.add(stableId);
                errors.push(
                  `duplicate memory id ${stableId} in ${firstPath} and ${relativePath} — not merged, reported`,
                );
              } else {
                idSeenPaths.set(stableId, relativePath);
              }
              if (!duplicateIds.has(stableId)) {
                // Record the actual location so theme references left stale by
                // a crash (e.g. between a move and its theme update) can be
                // aligned by stable id.
                existingLocations.set(stableId, {
                  folder: relativePath.slice(0, relativePath.lastIndexOf('/')),
                  key: path.basename(relativePath, '.md'),
                  title: value.title,
                  revision: value.revision,
                  contentHash: value.contentHash,
                });
              }
            }
            if (inspection.revisionBumped) revisionsBumped++;
          }

          const existing = index.index[relativePath];

          if (!existing) {
            index.index[relativePath] = value;
            report.addedEntries++;
          } else if (
            existing.title !== value.title ||
            JSON.stringify(existing.tags) !== JSON.stringify(value.tags) ||
            (value.id !== undefined && (existing as IndexEntryValue).id !== value.id) ||
            (value.revision !== undefined &&
              (existing as IndexEntryValue).revision !== value.revision) ||
            (value.contentHash !== undefined &&
              (existing as IndexEntryValue).contentHash !== value.contentHash)
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

    // Derived updates (theme references) run BEFORE the clean checkpoint is
    // committed: a failure here lands in `errors`, which keeps the
    // structureHash unset so the next reconcile re-runs in full and retries
    // the update instead of hiding it behind a skipped/synced:true
    // short-circuit (review P2, round 6 follow-up).
    try {
      faultPoint('reconcile.mark-orphaned');
      await this.themeManager.markOrphanedReferences(existingIds);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    // Duplicate ids must never be auto-merged or re-pointed: drop their
    // locations so the alignment below leaves every reference untouched.
    for (const duplicate of duplicateIds) {
      existingLocations.delete(duplicate);
    }

    // References whose memory still exists but moved (crash between the file
    // move and the theme update) are aligned by stable id.
    try {
      faultPoint('reconcile.theme-locations');
      await this.themeManager.updateMemoryReferenceLocations(existingLocations);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    // Corrupt files are unresolved problems: they must block the clean
    // checkpoint (structureHash stays unset) so every subsequent reconcile
    // re-scans and keeps reporting them instead of hiding them behind a
    // skipped/synced:true short-circuit (review P2, round 6 #1 follow-up).
    for (const corruptPath of corruptFiles) {
      errors.push(
        `corrupt memory file (kept on disk, reported every reconcile): ${corruptPath}`,
      );
    }

    // The structure hash is a CLEAN checkpoint: only record it when the
    // reconcile found no errors. With unresolved problems (duplicate ids,
    // corrupt files, failed theme updates, …) the hash stays unset so the
    // next reconcile re-runs in full and re-reports them instead of
    // short-circuiting to a fake `synced: true` (review P2, round 6 #1).
    if (errors.length === 0) {
      index.meta.structureHash = currentHash;
    } else {
      index.meta.structureHash = null;
    }

    try {
      this.store.saveIndex(index);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    return {
      synced: errors.length === 0,
      skipped: false,
      structureHash: currentHash,
      report,
      revisionsBumped,
      corruptFiles,
      errors,
    };
  }
}
