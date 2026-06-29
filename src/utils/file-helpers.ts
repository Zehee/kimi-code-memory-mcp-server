/**
 * File-system helpers used across DAOs and tools.
 */

import fs from 'fs';
import type { ParsedFrontmatter } from './frontmatter.js';
import { parseFrontmatter } from './frontmatter.js';

export function safeParseFile(filePath: string): ParsedFrontmatter | null {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return parseFrontmatter(text) || { frontmatter: {}, body: text };
  } catch {
    return null;
  }
}

export function fileStats(
  filePath: string,
): { exists: boolean; size: number; modifiedAt: string } | null {
  try {
    const stats = fs.statSync(filePath);
    return {
      exists: true,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
    };
  } catch {
    return null;
  }
}
