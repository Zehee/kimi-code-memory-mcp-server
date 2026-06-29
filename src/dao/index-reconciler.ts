/**
 * Index reconciler: directory scanning, structure hashing, and full rebuild.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { safeParseFile } from '../utils/file-helpers.js';
import { toTitle } from '../utils/validation.js';
import type { IndexEntry, ReconcileOptions, ReconcileReport, ReconcileResult } from './constants.js';
import { FALLBACK_FOLDER_COMMENTS } from './constants.js';
import type { IndexStore } from './index-store.js';

export class IndexReconciler {
  storeRoot: string;
  private store: IndexStore;

  constructor(storeRoot: string, store: IndexStore) {
    this.storeRoot = storeRoot;
    this.store = store;
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

  buildEntryValueFromFile(filePath: string): IndexEntry {
    const parsed = safeParseFile(filePath);
    const key = path.basename(filePath, '.md');
    const title = String(parsed?.frontmatter?.title || toTitle(key));
    const tags = Array.isArray(parsed?.frontmatter?.tags)
      ? (parsed.frontmatter.tags as string[])
      : [];
    return { title, tags };
  }

  reconcileIndex(options: ReconcileOptions = {}): ReconcileResult {
    const index = this.store.getIndex();
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
        this.store.saveIndex(index);
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

    const report: ReconcileReport = {
      scannedFiles: 0,
      addedEntries: 0,
      removedEntries: 0,
      updatedEntries: 0,
      addedFolders: 0,
    };

    const diskFiles = new Set<string>();

    const scanDir = (dir: string, relativePrefix: string): void => {
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
    this.store.saveIndex(index);

    return { synced: true, skipped: false, structureHash: currentHash, report };
  }
}
