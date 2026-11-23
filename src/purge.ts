/**
 * Derived-data purge.
 *
 * Removes everything this service derives or caches, keeping the authoritative
 * data (memory/, notes/, essence/essence.md, index.json) untouched. The
 * original session wires belong to the Kimi Code host: they are never
 * modified or deleted here — the report states how many remain so the user
 * knows exactly what is left behind.
 */

import fs from 'fs';
import path from 'path';
import { getSessionsRoot } from './config.js';
import { isLockStale, type LockOwnerInfo } from './utils/workspace-lock.js';
import { findAllWorkspaceSessions } from './context/wire-context.js';

export interface PurgeCategoryReport {
  category: string;
  /** Absolute directory whose contents were removed. */
  path: string;
  /** Number of files removed inside it. */
  removed: number;
}

export interface PurgeReport {
  storeRoot: string;
  removed: PurgeCategoryReport[];
  /** Host-owned data that was NOT touched. */
  kept: Array<{ category: string; path: string; note?: string }>;
  /** Number of original session wires found for this workspace (not deleted). */
  hostWireSessions: number;
  /** Where the host wires live, when discoverable. */
  hostWireRoot: string | null;
}

/** Empty a directory's contents without removing the directory itself. */
function clearDirectory(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    fs.rmSync(fullPath, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

/** Resolve the sessions root for reporting, or null when unavailable. */
function getSessionsRootSafe(): string | null {
  try {
    return getSessionsRoot();
  } catch {
    return null;
  }
}

/**
 * True when a workspace lock file looks like it is held by a live process.
 * Stale leftovers from crashed processes do not block the purge.
 */
function hasActiveLocks(lockRoot: string): boolean {
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(lockRoot)
      .filter((name) => name.endsWith('.lock') || name.includes('.lock.claim-'));
  } catch {
    return false;
  }
  for (const name of entries) {
    const lockPath = path.join(lockRoot, name);
    let owner: LockOwnerInfo | null = null;
    try {
      owner = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockOwnerInfo;
    } catch {
      // Unreadable lock file: treat as stale leftover.
      continue;
    }
    if (!isLockStale(owner, lockPath, 5_000)) {
      return true;
    }
  }
  return false;
}

/**
 * Purge all derived data of a workspace store.
 *
 * By default it throws when a live workspace lock exists — a running MCP
 * process must not write while the derived stores disappear. Callers that
 * already hold the workspace lock pass `assumeLocked` to skip the check.
 */
export function purgeDerivedData(
  storeRoot: string,
  options: { assumeLocked?: boolean } = {},
): PurgeReport {
  if (!options.assumeLocked && hasActiveLocks(path.join(storeRoot, '.locks'))) {
    throw new Error(
      'Refusing to purge: a live process holds a workspace lock. Stop the running MCP processes for this workspace first.',
    );
  }

  const removed: PurgeCategoryReport[] = [];

  const categories: Array<{ category: string; dir: string }> = [
    { category: 'themes', dir: path.join(storeRoot, 'themes') },
    { category: 'search views', dir: path.join(storeRoot, 'searches') },
    { category: 'refined turns (SQLite)', dir: path.join(storeRoot, 'refined') },
    { category: 'essence history', dir: path.join(storeRoot, 'essence', 'history') },
    { category: 'trash', dir: path.join(storeRoot, 'trash') },
    { category: 'write journal', dir: path.join(storeRoot, '.journal') },
    { category: 'dashboard runtime files', dir: path.join(storeRoot, 'runtime') },
  ];

  for (const { category, dir } of categories) {
    const count = clearDirectory(dir);
    removed.push({ category, path: dir, removed: count });
  }

  // Best-effort accounting of the host-owned wires. The store directory
  // name (workspace-*) does not match the host's session buckets (wd_*/wm_*),
  // so the workspace-scoped session discovery is reused here — the same
  // source the search uses (review R-09).
  let hostWireSessions = 0;
  let hostWireRoot: string | null = null;
  try {
    hostWireSessions = findAllWorkspaceSessions().length;
    hostWireRoot = getSessionsRootSafe();
  } catch {
    hostWireRoot = null;
  }

  const kept = [
    { category: 'memory entries', path: path.join(storeRoot, 'memory') },
    { category: 'notes', path: path.join(storeRoot, 'notes') },
    { category: 'essence', path: path.join(storeRoot, 'essence', 'essence.md') },
    { category: 'index', path: path.join(storeRoot, 'index.json') },
  ];

  return { storeRoot, removed, kept, hostWireSessions, hostWireRoot };
}
