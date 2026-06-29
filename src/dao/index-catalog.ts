/**
 * Read-only index catalog: lookups, refs, and tree data construction.
 */

import path from 'path';
import { safeParseFile } from '../utils/file-helpers.js';
import { toTitle } from '../utils/validation.js';
import type { IndexEntry } from './constants.js';
import type { IndexStore } from './index-store.js';
import type { TreeFile, TreeNode } from './memory-tree-renderer.js';

export class IndexCatalog {
  storeRoot: string;
  private store: IndexStore;

  constructor(storeRoot: string, store: IndexStore) {
    this.storeRoot = storeRoot;
    this.store = store;
  }

  listRefs(folder?: string): { key: string; folder: string; title: string; tags: string[] }[] {
    const index = this.store.getIndex().index;
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

  lookupByPath(relativePath: string): IndexEntry | undefined {
    return this.store.getIndex().index[relativePath];
  }

  buildMemoryTreeData(): TreeNode {
    const index = this.store.getIndex().index;

    const root: TreeNode = {
      name: 'memory',
      children: new Map(),
      files: [],
      comment: index['memory/']?.comment || '',
    };

    for (const key of Object.keys(index)) {
      if (!key.startsWith('memory/')) continue;

      if (key.endsWith('/')) {
        if (key === 'memory/') continue;
        const relativeFolder = key.slice(7, -1);
        const parts = relativeFolder ? relativeFolder.split('/') : [];
        let current = root;
        for (const part of parts) {
          let child = current.children.get(part);
          if (!child) {
            child = { name: part, children: new Map(), files: [], comment: '' };
            current.children.set(part, child);
          }
          current = child;
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
          let child = current.children.get(part);
          if (!child) {
            child = { name: part, children: new Map(), files: [], comment: '' };
            current.children.set(part, child);
          }
          current = child;
        }

        const filePath = path.join(this.storeRoot, key);
        const parsed = safeParseFile(filePath);
        const file: TreeFile = {
          key: fileName,
          title: value.title || toTitle(fileName),
          tags: Array.isArray(value.tags) ? value.tags : [],
          updatedAt: String(parsed?.frontmatter?.updatedAt || ''),
          createdAt: String(parsed?.frontmatter?.createdAt || ''),
        };
        current.files.push(file);
      }
    }

    return root;
  }
}
