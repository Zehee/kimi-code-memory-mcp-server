/**
 * Canonical path helpers.
 *
 * IMPORTANT: these helpers are **not** used to derive workspace directory
 * names or workspace hashes. The Kimi host hashes the literal working
 * directory (slashes + trimmed trailing slash, no realpath), so bucketing
 * must stay byte-compatible with that value — otherwise existing session
 * directories become invisible.
 *
 * `realpath` is only used as a *secondary alias comparison*: a symlinked path
 * that points at the same directory should still be recognized as the same
 * workspace, but it never replaces the literal path.
 *
 * See `src/search/host-workspace.ts` for the bucketing rules.
 */

import fs from 'fs';
import path from 'path';

/**
 * Resolve a path to its real (symlink-free) form. Returns null when the path
 * does not exist.
 */
export function safeRealpath(input: string): string | null {
  try {
    return fs.realpathSync.native(input);
  } catch {
    try {
      return fs.realpathSync(input);
    } catch {
      return null;
    }
  }
}

/**
 * Canonical form of a path: absolute and symlink-free when it exists.
 *
 * Use for alias comparisons only — never for hashing or directory naming.
 */
export function canonicalizePath(input: string): string {
  const resolved = path.resolve(String(input ?? ''));
  return safeRealpath(resolved) ?? resolved;
}

/**
 * Canonical cwd. Alias comparison only.
 */
export function canonicalCwd(): string {
  return canonicalizePath(process.cwd());
}

/**
 * Canonical cwd in slash form.
 *
 * Only used as a secondary key for the legacy `mcp-config.json` session
 * mapping — never for workspace bucketing or hashing.
 */
export function canonicalCwdHashInput(): string {
  return canonicalCwd().replace(/\\/g, '/');
}

/**
 * Comparison key for two paths. Windows paths compare case-insensitively.
 */
export function pathCompareKey(input: string): string {
  const normalized = path.resolve(String(input ?? '')).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/**
 * True when both paths point at the same location (alias tolerant).
 */
export function samePath(a: string, b: string): boolean {
  return pathCompareKey(a) === pathCompareKey(b);
}
