/**
 * Path and workspace hashing helpers.
 */

import os from 'os';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const homedir = os.homedir();

export function computeWorkspaceHash(cwd: string): string {
  const normalized = String(cwd).replace(/\\/g, '/');
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

export function computeWorkspaceId(cwd: string): string {
  if (!cwd || cwd === homedir) {
    return 'workspace-default';
  }
  return `workspace-${computeWorkspaceHash(cwd)}`;
}

export function getProjectRoot(): string {
  return path.resolve(__dirname, '..', '..');
}

export function relativeStorePath(storeRoot: string, filePath: string): string {
  return path.relative(storeRoot, filePath).replace(/\\/g, '/');
}

/**
 * Resolve path segments under a base directory and verify the result does not
 * escape the base directory (path traversal protection).
 */
export function safeResolve(base: string, ...segments: string[]): string {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(resolvedBase, ...segments);
  const relative = path.relative(resolvedBase, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes base directory: ${segments.join('/')}`);
  }
  return resolved;
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Atomically write a file by writing to a temp file and renaming it into place.
 * The target directory is created if it does not exist.
 */
export function atomicWriteFile(filePath: string, content: string, encoding: BufferEncoding = 'utf8'): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, content, encoding);
  fs.renameSync(tmpPath, filePath);
}
