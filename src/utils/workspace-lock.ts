/**
 * Cross-process workspace lock.
 *
 * The lock is a lock file inside a per-workspace lock directory. The file
 * records the owner (pid, host, random owner token), creation time, heartbeat
 * and lease expiry so that a crashed owner can be detected and its lock
 * reclaimed instead of blocking the workspace forever.
 *
 * Guarantees:
 *
 * - Mutual exclusion across processes: the lock file is created with the
 *   exclusive `wx` flag, so exactly one process can win the race.
 * - Stale owner detection: a lock whose owner process is gone is reclaimed;
 *   a live owner is never stolen merely because its lease expired.
 * - Ownership checked on release: a process never removes a lock it no longer
 *   owns.
 * - Same-process re-entrancy: nested acquisitions of the same key reuse the
 *   held lock instead of deadlocking, while independent (non-nested)
 *   acquisitions of the same key queue up.
 *
 * The lock does not protect against a hostile process running as the same
 * user; it protects against accidental concurrency and crashes.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { metrics } from './metrics.js';
import { atomicWriteFile } from './paths.js';

/** Lock key used for whole-workspace read-modify-write flows. */
export const WORKSPACE_LOCK_KEY = 'workspace';

export interface LockOwnerInfo {
  version: number;
  key: string;
  pid: number;
  hostname: string;
  ownerToken: string;
  createdAt: string;
  heartbeatAt: string;
  leaseExpiresAt: string;
}

export class LockTimeoutError extends Error {
  readonly key: string;
  readonly owner: LockOwnerInfo | null;

  constructor(key: string, owner: LockOwnerInfo | null, message?: string) {
    super(
      message ??
        `Timed out waiting for workspace lock "${key}"` +
          (owner ? ` (held by pid ${owner.pid} on ${owner.hostname})` : ''),
    );
    this.name = 'LockTimeoutError';
    this.key = key;
    this.owner = owner;
  }
}

export interface WorkspaceLockOptions {
  /** Maximum time to wait for the lock (default 10s). */
  timeoutMs?: number;
  /** Lease duration; the owner refreshes it with a heartbeat (default 30s). */
  leaseMs?: number;
  /** Poll interval while waiting (default 40ms). */
  pollIntervalMs?: number;
  /** Heartbeat interval (default: leaseMs / 3). */
  heartbeatMs?: number;
  /** Age after which a lock file without readable metadata is reclaimed. */
  staleLockMs?: number;
}

export interface LockHandle {
  readonly key: string;
  readonly path: string;
  readonly owner: LockOwnerInfo;
  /** Extend the lease immediately. */
  heartbeat(): void;
  /** Release the lock (only when still owned by this handle). */
  release(): void | Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_POLL_MS = 40;
const DEFAULT_STALE_LOCK_MS = 5_000;

/** Locks held by the current async context (re-entrancy bookkeeping). */
const heldLocks = new AsyncLocalStorage<Map<string, number>>();

/** In-process queues, shared by every lock instance of this process. */
const processQueues = new Map<string, Promise<unknown>>();

function enqueueProcess<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = processQueues.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  processQueues.set(
    key,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Check whether a process is still running. */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLockOwner(lockPath: string): LockOwnerInfo | null {
  try {
    const text = fs.readFileSync(lockPath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    const owner = parsed as Partial<LockOwnerInfo>;
    if (typeof owner.ownerToken !== 'string' || !owner.ownerToken) return null;
    if (typeof owner.pid !== 'number') return null;
    return {
      version: typeof owner.version === 'number' ? owner.version : 1,
      key: typeof owner.key === 'string' ? owner.key : '',
      pid: owner.pid,
      hostname: typeof owner.hostname === 'string' ? owner.hostname : '',
      ownerToken: owner.ownerToken,
      createdAt: typeof owner.createdAt === 'string' ? owner.createdAt : '',
      heartbeatAt: typeof owner.heartbeatAt === 'string' ? owner.heartbeatAt : '',
      leaseExpiresAt: typeof owner.leaseExpiresAt === 'string' ? owner.leaseExpiresAt : '',
    };
  } catch {
    return null;
  }
}

function lockFileAgeMs(lockPath: string): number {
  try {
    return Date.now() - fs.statSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

function createOwner(key: string, leaseMs: number): LockOwnerInfo {
  const now = new Date();
  return {
    version: 1,
    key,
    pid: process.pid,
    hostname: os.hostname(),
    ownerToken: crypto.randomBytes(16).toString('hex'),
    createdAt: now.toISOString(),
    heartbeatAt: now.toISOString(),
    leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
  };
}

function writeNewOwnerFile(filePath: string, owner: LockOwnerInfo): void {
  const fd = fs.openSync(filePath, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(owner, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeOwnedFile(filePath: string, ownerToken: string): void {
  const current = readLockOwner(filePath);
  if (!current || current.ownerToken !== ownerToken) return;
  try {
    fs.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function claimGuardPrefix(lockPath: string): string {
  return `${path.basename(lockPath)}.claim-`;
}

function claimCapturedPath(guardPath: string): string {
  const reapIndex = guardPath.indexOf('.reap-', guardPath.lastIndexOf('.claim-'));
  const base = reapIndex >= 0 ? guardPath.slice(0, reapIndex) : guardPath;
  return `${base}.captured`;
}

function listClaimGuards(lockPath: string): string[] {
  const dir = path.dirname(lockPath);
  const prefix = claimGuardPrefix(lockPath);
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && !name.endsWith('.captured'))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

function removeOwnedLockAndCaptures(lockPath: string, ownerToken: string): void {
  removeOwnedFile(lockPath, ownerToken);
  for (const guard of listClaimGuards(lockPath)) {
    removeOwnedFile(claimCapturedPath(guard), ownerToken);
  }
  // The reclaimer may have restored the captured file after the first check.
  removeOwnedFile(lockPath, ownerToken);
}

function settleCapturedLock(lockPath: string, guardPath: string): void {
  const capturedPath = claimCapturedPath(guardPath);
  const captured = readLockOwner(capturedPath);
  if (!captured) {
    try {
      fs.unlinkSync(capturedPath);
    } catch {
      // Missing or unreadable captured lock: nothing live to restore.
    }
    return;
  }

  if (!isProcessAlive(captured.pid)) {
    try {
      fs.unlinkSync(capturedPath);
    } catch {
      // Already removed by its owner or another settled claim.
    }
    return;
  }

  // A main file created while this guard exists is only a tentative acquirer:
  // its post-create guard check prevents it from entering the critical section.
  try {
    fs.unlinkSync(lockPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  try {
    fs.renameSync(capturedPath, lockPath);
  } catch (err) {
    // The captured owner can release itself while it is captured. In that case
    // there is nothing to restore and the next acquisition may proceed.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

function reapOrphanedClaims(lockPath: string, key: string, staleLockMs: number): void {
  for (const guard of listClaimGuards(lockPath)) {
    const reaping = guard.includes('.reap-', guard.lastIndexOf('.claim-'));
    if (reaping && lockFileAgeMs(guard) < staleLockMs) continue;
    const owner = readLockOwner(guard);
    if (owner && isProcessAlive(owner.pid)) continue;
    if (!owner && !reaping && lockFileAgeMs(guard) < staleLockMs) continue;

    const reapPath = `${guard}.reap-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    try {
      fs.renameSync(guard, reapPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }

    try {
      // The fresh mtime makes other cleaners back off. The reap path remains
      // visible to acquirers until the captured lock has been settled.
      fs.writeFileSync(reapPath, JSON.stringify(createOwner(key, staleLockMs)), 'utf8');
      settleCapturedLock(lockPath, guard);
      fs.unlinkSync(reapPath);
    } catch {
      // Leave the reap record for a later cleaner if this process cannot finish.
    }
  }
}

/**
 * Decide whether an existing lock file can be reclaimed.
 *
 * Death detection, not lease expiry: a lock whose owner PROCESS is gone is
 * reclaimed immediately; a lock whose owner is still ALIVE is never
 * reclaimed, even when the lease expired — the owner may simply be blocked
 * (GC pause, slow disk) and unable to heartbeat. Stealing from a live
 * process creates real critical-section overlap (review P1 #1), while
 * waiting surfaces a `LockTimeoutError` that is safe and diagnosable.
 *
 * Only a lock file that never received metadata (owner crashed between
 * create and write) is reclaimed by age.
 */
export function isLockStale(
  owner: LockOwnerInfo | null,
  lockPath: string,
  staleLockMs: number,
): boolean {
  if (!owner) {
    // The owner crashed between creating the file and writing its metadata.
    return lockFileAgeMs(lockPath) > staleLockMs;
  }
  return !isProcessAlive(owner.pid);
}

export class WorkspaceLock {
  readonly lockRoot: string;
  readonly timeoutMs: number;
  readonly leaseMs: number;
  readonly pollIntervalMs: number;
  readonly heartbeatMs: number;
  readonly staleLockMs: number;

  constructor(lockRoot: string, options: WorkspaceLockOptions = {}) {
    this.lockRoot = path.resolve(lockRoot);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(1000, Math.floor(this.leaseMs / 3));
    this.staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS;
  }

  /** Absolute path of the lock file used for a key. */
  lockPath(key: string): string {
    const safe = String(key)
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 48);
    const digest = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12);
    return path.join(this.lockRoot, `${safe}-${digest}.lock`);
  }

  /** Current owner of a lock, or `null` when the lock is free. */
  inspect(key: string): LockOwnerInfo | null {
    return readLockOwner(this.lockPath(key));
  }

  /**
   * Run `fn` while holding the lock for `key`.
   */
  /**
   * Try to run `fn` while holding the lock, acquiring it in a single
   * synchronous step. When the lock is held by someone else the function is
   * NOT run and `{ acquired: false }` is returned — callers use this for
   * short critical sections on shutdown paths where waiting is worse than
   * skipping (e.g. the runtime-record ownership check + delete).
   *
   * Mutual exclusion holds against `withLock` users of the same key, and fn
   * errors propagate to the caller after the lock is released.
   */
  tryWithLockSync<T>(key: string, fn: () => T): { acquired: boolean; result?: T } {
    const lockPath = this.lockPath(key);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    // A dead owner may be reclaimed without waiting. Live owners and active
    // claim guards retain the original non-waiting contract.
    for (let attempt = 0; attempt < 2; attempt++) {
      const attemptResult = this.tryAcquire(lockPath, key, {});
      if (attemptResult.status === 'reclaimed') {
        metrics.increment('lock_try_sync_stale_reclaimed');
        continue;
      }
      if (attemptResult.status !== 'acquired') {
        metrics.increment('lock_try_sync_skipped');
        return { acquired: false };
      }

      try {
        return { acquired: true, result: fn() };
      } finally {
        void attemptResult.handle.release();
      }
    }
    metrics.increment('lock_try_sync_skipped');
    return { acquired: false };
  }

  async withLock<T>(
    key: string,
    fn: () => Promise<T> | T,
    options: WorkspaceLockOptions = {},
  ): Promise<T> {
    const lockPath = this.lockPath(key);

    // Re-entrant path: the current async context already holds this lock.
    const held = heldLocks.getStore();
    const count = held?.get(lockPath) ?? 0;
    if (count > 0 && held) {
      held.set(lockPath, count + 1);
      try {
        return await fn();
      } finally {
        held.set(lockPath, count);
      }
    }

    return enqueueProcess(lockPath, async () => {
      const handle = await this.acquire(lockPath, key, options);
      const store = heldLocks.getStore() ?? new Map<string, number>();
      const previous = store.get(lockPath) ?? 0;
      store.set(lockPath, previous + 1);
      try {
        return await heldLocks.run(store, async () => await fn());
      } finally {
        store.set(lockPath, previous);
        await handle.release();
      }
    });
  }

  private async acquire(
    lockPath: string,
    key: string,
    options: WorkspaceLockOptions,
  ): Promise<LockHandle> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const pollIntervalMs = options.pollIntervalMs ?? this.pollIntervalMs;
    const deadline = Date.now() + timeoutMs;
    const waitStart = Date.now();
    let waited = false;

    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    for (;;) {
      const attempt = this.tryAcquire(lockPath, key, options);
      if (attempt.status === 'acquired') {
        if (waited) metrics.observe('lock_wait_ms', Date.now() - waitStart);
        return attempt.handle;
      }
      if (attempt.status === 'reclaimed') {
        metrics.increment('lock_stale_reclaims');
        waited = true;
        continue;
      }

      waited = true;
      if (Date.now() >= deadline) {
        metrics.increment('lock_timeouts');
        throw new LockTimeoutError(key, attempt.owner);
      }
      await sleep(pollIntervalMs);
    }
  }

  private tryAcquire(
    lockPath: string,
    key: string,
    options: WorkspaceLockOptions,
  ):
    | { status: 'acquired'; handle: LockHandle }
    | { status: 'busy' | 'retry' | 'reclaimed'; owner: LockOwnerInfo | null } {
    const leaseMs = options.leaseMs ?? this.leaseMs;
    const staleLockMs = options.staleLockMs ?? this.staleLockMs;
    reapOrphanedClaims(lockPath, key, staleLockMs);

    let owner: LockOwnerInfo | null = null;
    try {
      owner = createOwner(key, leaseMs);
      writeNewOwnerFile(lockPath, owner);
      const verify = readLockOwner(lockPath);
      const claims = listClaimGuards(lockPath);
      if (verify?.ownerToken === owner.ownerToken && claims.length === 0) {
        return { status: 'acquired', handle: this.createHandle(lockPath, owner, leaseMs) };
      }

      // Our file may have been captured by a stale reclaimer. Remove both the
      // main and captured copies so that no unentered acquisition is revived.
      metrics.increment('lock_verify_lost');
      removeOwnedLockAndCaptures(lockPath, owner.ownerToken);
      return { status: 'retry', owner: null };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        if (owner) removeOwnedLockAndCaptures(lockPath, owner.ownerToken);
        throw err;
      }
    }

    const existing = readLockOwner(lockPath);
    if (!isLockStale(existing, lockPath, staleLockMs)) {
      return { status: 'busy', owner: existing };
    }

    // The unique claim guard is created BEFORE the main lock is moved. Every
    // acquirer checks these guards after creation and backs off, so a delayed
    // reclaimer cannot capture one live replacement while another enters.
    const claimOwner = createOwner(key, leaseMs);
    const guardPath = `${lockPath}.claim-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
    const capturedPath = claimCapturedPath(guardPath);
    writeNewOwnerFile(guardPath, claimOwner);
    try {
      fs.renameSync(lockPath, capturedPath);
    } catch (err) {
      try {
        fs.unlinkSync(guardPath);
      } catch {
        // Best effort; a dead guard is recovered by a later acquirer.
      }
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return { status: 'retry', owner: null };
      }
      throw err;
    }

    try {
      const captured = readLockOwner(capturedPath);
      settleCapturedLock(lockPath, guardPath);
      fs.unlinkSync(guardPath);
      return {
        status: captured && isProcessAlive(captured.pid) ? 'retry' : 'reclaimed',
        owner: existing,
      };
    } catch (err) {
      try {
        settleCapturedLock(lockPath, guardPath);
        fs.unlinkSync(guardPath);
      } catch {
        // Leave a complete claim record for recovery by the next acquirer.
      }
      throw err;
    }
  }

  private createHandle(lockPath: string, owner: LockOwnerInfo, leaseMs: number): LockHandle {
    let released = false;
    let current = owner;

    const refresh = (): void => {
      if (released) return;
      try {
        const existing = readLockOwner(lockPath);
        if (!existing || existing.ownerToken !== current.ownerToken) return;
        const now = new Date();
        const next: LockOwnerInfo = {
          ...current,
          heartbeatAt: now.toISOString(),
          leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
        };
        atomicWriteFile(lockPath, JSON.stringify(next, null, 2), 'utf8');
        current = next;
      } catch {
        /* best effort */
      }
    };

    const timer = setInterval(refresh, this.heartbeatMs);
    if (typeof timer.unref === 'function') timer.unref();

    return {
      key: current.key,
      path: lockPath,
      get owner() {
        return current;
      },
      heartbeat: refresh,
      release: async () => {
        if (released) return;
        released = true;
        clearInterval(timer);
        try {
          removeOwnedLockAndCaptures(lockPath, current.ownerToken);
        } catch {
          /* ignore */
        }
      },
    };
  }
}

/** Default lock directory for a workspace store root. */
export function workspaceLockRoot(storeRoot: string): string {
  return path.join(path.resolve(storeRoot), '.locks');
}
