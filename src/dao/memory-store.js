/**
 * Markdown memory file operations.
 */

import fs from 'fs';
import path from 'path';
import { parseFrontmatter, stringifyFrontmatter } from '../utils/frontmatter.js';

function safeParseFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return parseFrontmatter(text) || { frontmatter: {}, body: text };
  } catch {
    return null;
  }
}

export class MemoryStore {
  constructor(storeRoot) {
    this.storeRoot = storeRoot;
  }

  resolveFilePath(folder, key) {
    return path.join(this.storeRoot, folder, `${key}.md`);
  }

  exists(folder, key) {
    return fs.existsSync(this.resolveFilePath(folder, key));
  }

  read(folder, key) {
    const filePath = this.resolveFilePath(folder, key);
    const parsed = safeParseFile(filePath);
    if (!parsed) return null;
    return {
      ...parsed.frontmatter,
      content: parsed.body,
      filePath,
    };
  }

  write(folder, key, content, tags = [], options = {}) {
    const filePath = this.resolveFilePath(folder, key);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const existing = this.exists(folder, key) ? safeParseFile(filePath) : null;
    const now = new Date().toISOString();

    const frontmatter = {
      key,
      title: options.title || existing?.frontmatter?.title || this.toTitle(key),
      tags: tags.length > 0 ? tags : existing?.frontmatter?.tags || [],
      createdAt: existing?.frontmatter?.createdAt || now,
      updatedAt: now,
    };

    fs.writeFileSync(filePath, stringifyFrontmatter(frontmatter) + content, 'utf8');
    return filePath;
  }

  delete(folder, key) {
    const filePath = this.resolveFilePath(folder, key);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  move(oldFolder, oldKey, toFolder, newKey) {
    const oldPath = this.resolveFilePath(oldFolder, oldKey);
    const finalKey = newKey || oldKey;
    const newPath = this.resolveFilePath(toFolder, finalKey);

    if (!fs.existsSync(oldPath)) {
      throw new Error(`Source memory not found: ${oldFolder}/${oldKey}`);
    }
    if (fs.existsSync(newPath)) {
      throw new Error(`Destination already exists: ${toFolder}/${finalKey}`);
    }

    fs.mkdirSync(path.dirname(newPath), { recursive: true });

    if (newKey) {
      // Rewrite frontmatter key when renaming.
      const parsed = safeParseFile(oldPath);
      if (parsed) {
        parsed.frontmatter.key = newKey;
        parsed.frontmatter.updatedAt = new Date().toISOString();
        fs.writeFileSync(newPath, stringifyFrontmatter(parsed.frontmatter) + parsed.body, 'utf8');
        fs.unlinkSync(oldPath);
        return newPath;
      }
    }

    fs.renameSync(oldPath, newPath);
    return newPath;
  }

  listMarkdownFiles(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.listMarkdownFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
    return results;
  }

  toTitle(key) {
    return String(key)
      .replace(/[-_]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .split(' ')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }
}
