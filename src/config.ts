/**
 * Global configuration.
 *
 * The store root can be overridden via the MEMORY_STORE_ROOT environment
 * variable. When unset, it defaults to ~/.kimi-code-memory/ so that the
 * server behaves like a user-level tool even when installed as a package.
 */

import os from 'os';
import path from 'path';

export const homedir = os.homedir();

export const sessionsRoot = path.join(homedir, '.kimi-code', 'sessions');

export function getStoreRoot(): string {
  const envRoot = process.env.MEMORY_STORE_ROOT;
  if (envRoot) {
    if (envRoot.includes('\0')) {
      throw new Error('MEMORY_STORE_ROOT contains invalid null byte');
    }
    const resolved = path.resolve(envRoot);
    if (!path.isAbsolute(resolved)) {
      throw new Error(`MEMORY_STORE_ROOT must resolve to an absolute path: ${envRoot}`);
    }
    return resolved;
  }
  return path.join(homedir, '.kimi-code-memory');
}

export interface ContextWindow {
  detailedRounds: number;
  defaultSummaryRounds: number;
  loadMoreChunkSize: number;
}

export const DEFAULT_CONTEXT_WINDOW: ContextWindow = {
  detailedRounds: 3,
  defaultSummaryRounds: 2,
  loadMoreChunkSize: 5,
};

export const DEFAULT_RECENT_CHANGE_LIMIT = 5;

export const ESSENCE_SIZE_LIMIT = 15 * 1024; // 15 KB
