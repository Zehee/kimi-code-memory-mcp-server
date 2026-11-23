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
 * Build a unique temporary file path next to the target file.
 *
 * The name contains the owning PID and a random suffix so that concurrent
 * processes never share a temporary file.
 */
export function createTempFilePath(filePath: string): string {
  const random = crypto.randomBytes(8).toString('hex');
  return `${filePath}.${process.pid}.${random}.tmp`;
}

/** Pattern matching temporary files created by `createTempFilePath`. */
export const TEMP_FILE_PATTERN = /\.\d+\.[0-9a-f]{16}\.tmp$/;

/**
 * Atomically write a file.
 *
 * The content is written to a unique temporary file in the same directory,
 * flushed with `fsync`, closed and only then renamed over the target. A
 * failed write removes its own temporary file and leaves the previous content
 * untouched. When the target already exists its permission bits are copied to
 * the replacement file.
 */
export function atomicWriteFile(filePath: string, content: string, encoding: BufferEncoding = 'utf8'): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = createTempFilePath(filePath);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'wx', 0o600);
    const buffer = Buffer.from(content, encoding);
    fs.writeSync(fd, buffer, 0, buffer.length, 0);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;

    preserveFileMode(filePath, tmpPath);

    fs.renameSync(tmpPath, filePath);
    syncDirectory(dir);
  } catch (err) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/**
 * Copy the permission bits of an existing file onto its replacement.
 * Missing targets simply keep the default permissions.
 */
export function preserveFileMode(targetPath: string, replacementPath: string): void {
  try {
    const stats = fs.statSync(targetPath);
    fs.chmodSync(replacementPath, stats.mode & 0o777);
  } catch {
    /* new file or unreadable target: keep defaults */
  }
}

/**
 * Flush the directory entry so the rename survives a crash.
 * Directory fsync is not supported on Windows and is best effort elsewhere.
 */
export function syncDirectory(dir: string): void {
  if (process.platform === 'win32') return;
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    /* best effort */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Remove leftover temporary files from crashed writes.
 *
 * Returns the removed file paths so callers can report them.
 */
export function cleanupTempFiles(
  dir: string,
  options: { maxAgeMs?: number } = {},
): string[] {
  const maxAgeMs = options.maxAgeMs ?? 60 * 60 * 1000;
  const removed: string[] = [];
  if (!fs.existsSync(dir)) return removed;

  const now = Date.now();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!TEMP_FILE_PATTERN.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    try {
      const stats = fs.statSync(full);
      if (now - stats.mtimeMs < maxAgeMs) continue;
      fs.unlinkSync(full);
      removed.push(full);
    } catch {
      /* ignore */
    }
  }
  return removed;
}

/**
 * Inspect an existing file for symlink escapes.
 *
 * `lstat` rejects symbolic links and `realpath` verifies that the resolved
 * target still lives inside `root`. This lowers the risk of accidental
 * symlink escapes; it cannot protect against a hostile process that swaps
 * files between the check and the use (TOCTOU).
 */
export function isSafeExistingFile(filePath: string, root?: string): boolean {
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) return false;
    if (!stats.isFile()) return false;
    if (!root) return true;
    const real = fs.realpathSync(filePath);
    return isPathInside(root, real);
  } catch {
    return false;
  }
}

/**
 * Resolve the real path of an existing file, rejecting symlinked files.
 * Returns `null` when the file is missing or unsafe.
 */
export function safeRealpath(filePath: string, root?: string): string | null {
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) return null;
    if (!stats.isFile()) return null;
    const real = fs.realpathSync(filePath);
    if (root && !isPathInside(root, real)) return null;
    return real;
  } catch {
    return null;
  }
}

/**
 * Throw when an existing file is not safe to read or replace.
 */
export function assertSafeExistingFile(filePath: string, root?: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(filePath);
  } catch {
    return; // missing file: nothing to check
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing to use symbolic link: ${filePath}`);
  }
  if (!stats.isFile()) {
    throw new Error(`Refusing to use non-regular file: ${filePath}`);
  }
  if (root) {
    const real = safeRealpath(filePath, root);
    if (!real) {
      throw new Error(`Refusing to use path outside of ${root}: ${filePath}`);
    }
  }
}
