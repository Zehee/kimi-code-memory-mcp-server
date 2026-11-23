/**
 * Optional auto-start of the kimi-memory-vis dashboard when the MCP server starts.
 *
 * The dashboard is a per-workspace singleton with an explicit owner:
 *
 * - the owner binds the HTTP port, generates the bearer token and publishes a
 *   private runtime file (workspace runtime directory, 0600 on POSIX);
 * - sibling processes find that file, probe the dashboard with the token and
 *   reuse the running instance instead of binding a second port;
 * - the owner keeps a lease/heartbeat in the runtime file, so a crashed owner
 *   is detected and the instance can be taken over;
 * - the token is never part of the plain dashboard URL. It only travels to
 *   the browser through the URL fragment (`#bootstrap=<token>`), which is
 *   never sent to the server and never lands in a request log.
 */

import type { ServerType } from '@hono/node-server';
import type { Ctx } from '../types.js';
import { startVisServer } from './server.js';
import { metrics } from '../utils/metrics.js';
import {
  LockTimeoutError,
  WorkspaceLock,
  workspaceLockRoot,
} from '../utils/workspace-lock.js';
import {
  RUNTIME_HEARTBEAT_INTERVAL_MS,
  VIS_RUNTIME_SCHEMA_VERSION,
  buildBrowserUrl,
  createRuntimeLease,
  generateVisToken,
  getVisRuntimeFilePath,
  isRuntimeLeaseAlive,
  isSupportedListenerHostname,
  readVisRuntimeFile,
  refreshVisRuntimeFile,
  removeVisRuntimeFile,
  writeVisRuntimeFile,
  type VisRuntimeFile,
} from './security.js';

const DEFAULT_VIS_PORT = 58628;
const MAX_PORT_ATTEMPTS = 10;
const PROBE_TIMEOUT_MS = 1000;
const RACE_RECHECK_DELAY_MS = 400;

export interface AutoStartResult {
  started: boolean;
  /** Plain dashboard URL. Never contains the token. */
  url?: string;
  /** URL to open in a browser; carries the token in the URL fragment only. */
  browserUrl?: string;
  /** True when an existing dashboard for this workspace was reused. */
  reused?: boolean;
  error?: string;
  /** Non fatal notice, e.g. a legacy unauthenticated instance was skipped. */
  warning?: string;
}

interface VisState {
  /** Set when this process owns the HTTP server. */
  server: ServerType | null;
  url: string | null;
  token: string | null;
  owned: boolean;
  runtimeFilePath: string | null;
  /** Lock root for the claim lock, captured when a runtime file is claimed. */
  lockRoot: string | null;
  heartbeat: NodeJS.Timeout | null;
}

const state: VisState = {
  server: null,
  url: null,
  token: null,
  owned: false,
  runtimeFilePath: null,
  lockRoot: null,
  heartbeat: null,
};

let pendingStart: Promise<AutoStartResult> | null = null;

/**
 * The dashboard is opt-in: it only starts automatically when
 * KIMI_MEMORY_AUTO_VIS is explicitly enabled.
 */
function getEnvFlag(): boolean {
  const raw = process.env.KIMI_MEMORY_AUTO_VIS;
  if (raw === undefined || raw.trim() === '') return false;
  return raw === '1' || raw.trim().toLowerCase() === 'true';
}

function getDesiredPort(): number {
  const raw = process.env.KIMI_MEMORY_VIS_PORT;
  if (!raw) return DEFAULT_VIS_PORT;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? DEFAULT_VIS_PORT : parsed;
}

function getDesiredHostname(): string {
  return process.env.KIMI_MEMORY_VIS_HOST || '127.0.0.1';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Authenticated probe of a running dashboard. Legacy instances that do not
 * require a token are never reused: they answer without authentication and
 * cannot be trusted.
 */
async function probeDashboard(
  url: string,
  token: string,
  workspaceId: string,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/workspace`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { id?: unknown };
    return data.id === workspaceId;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try to bind the vis server on a port, resolving once the server is actually
 * listening. A failed bind (e.g. EADDRINUSE when another workspace's server
 * wins the race) resolves to null instead of crashing the process — the
 * dashboard is optional and must never take down the MCP stdio server.
 */
function tryBindVisServer(
  ctx: Ctx,
  port: number,
  hostname: string,
  token: string,
): Promise<ServerType | null> {
  return new Promise((resolve) => {
    let server: ServerType;
    const onError = () => {
      try {
        server.close();
      } catch {
        // Ignore close errors; the server may not have started listening.
      }
      resolve(null);
    };
    try {
      server = startVisServer({
        ctx,
        port,
        hostname,
        authToken: token,
        onReady: () => {
          server.removeListener('error', onError);
          // Late runtime errors must not become unhandled 'error' events.
          server.on('error', (err) => {
            process.stderr.write(`[kimi-memory] vis dashboard error: ${err.message}\n`);
          });
          resolve(server);
        },
      });
    } catch {
      resolve(null);
      return;
    }
    server.once('error', onError);
  });
}

function buildRuntimeFile(
  ctx: Ctx,
  params: { url: string; hostname: string; port: number; token: string },
): VisRuntimeFile {
  const now = new Date().toISOString();
  return {
    schemaVersion: VIS_RUNTIME_SCHEMA_VERSION,
    workspaceId: ctx.workspaceId,
    url: params.url,
    hostname: params.hostname,
    port: params.port,
    pid: process.pid,
    token: params.token,
    createdAt: now,
    updatedAt: now,
    heartbeatAt: now,
    lease: createRuntimeLease(),
  };
}

/**
 * Publish the runtime file. When another live instance already owns the
 * workspace the claim is refused and the winner is reused instead.
 */
function claimRuntimeFile(
  ctx: Ctx,
  runtimeFilePath: string,
  ours: { url: string; hostname: string; port: number; token: string },
): { claimed: boolean; url?: string; token?: string } {
  const current = readVisRuntimeFile(runtimeFilePath);
  if (current && current.url !== ours.url && isRuntimeLeaseAlive(current)) {
    return { claimed: false, url: current.url, token: current.token };
  }
  writeVisRuntimeFile(runtimeFilePath, buildRuntimeFile(ctx, ours));
  return { claimed: true };
}

function stopHeartbeat(): void {
  if (state.heartbeat) {
    clearInterval(state.heartbeat);
    state.heartbeat = null;
  }
}

/**
 * Refresh the heartbeat/lease of our runtime record — atomically under the
 * `vis-runtime-claim` lock, validating BOTH pid and token inside the lock
 * (review R-06: a claim written between the heartbeat's read and write used
 * to be clobbered by the old owner's stale record).
 *
 * When the lock is busy (a claim is mid-handshake) or the record on disk no
 * longer belongs to this process, the refresh is skipped — the next tick
 * retries, and a skipped heartbeat never clobbers a newer owner.
 */
export type HeartbeatRefreshOutcome = 'refreshed' | 'foreign' | 'missing' | 'lock-busy';

export function refreshVisRuntimeRecordUnderClaimLock(
  runtimeFilePath: string,
  token: string,
  lockRoot: string | null,
): HeartbeatRefreshOutcome {
  if (!lockRoot) {
    metrics.increment('dashboard_heartbeat_skipped_no_lock_root');
    return 'lock-busy';
  }
  const claimLock = new WorkspaceLock(lockRoot);
  const outcome = claimLock.tryWithLockSync('vis-runtime-claim', () => {
    const current = readVisRuntimeFile(runtimeFilePath);
    if (!current) return 'missing' as const;
    if (current.pid !== process.pid || current.token !== token) {
      metrics.increment('dashboard_heartbeat_skipped_foreign');
      return 'foreign' as const;
    }
    refreshVisRuntimeFile(runtimeFilePath);
    return 'refreshed' as const;
  });
  if (!outcome.acquired) {
    metrics.increment('dashboard_heartbeat_skipped_lock_busy');
    return 'lock-busy';
  }
  return outcome.result ?? 'lock-busy';
}

function startHeartbeat(
  runtimeFilePath: string,
  token: string,
  lockRoot: string | null,
): void {
  stopHeartbeat();
  const timer = setInterval(() => {
    try {
      refreshVisRuntimeRecordUnderClaimLock(runtimeFilePath, token, lockRoot);
    } catch {
      // A failing heartbeat must never crash the MCP server.
    }
  }, RUNTIME_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();
  state.heartbeat = timer;
}

function clearState(): void {
  state.server = null;
  state.url = null;
  state.token = null;
  state.owned = false;
  state.runtimeFilePath = null;
  state.lockRoot = null;
  metrics.gauge('dashboard_owner_pid', 0);
}

async function doStartOrReuse(ctx: Ctx): Promise<AutoStartResult> {
  const hostname = getDesiredHostname();
  if (!isSupportedListenerHostname(hostname)) {
    return {
      started: false,
      error: `Refusing to bind the memory dashboard to a non-loopback address: ${hostname}`,
    };
  }
  const runtimeFilePath = getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId);

  // 1. Re-validate what we already know. A reused URL is never trusted
  //    forever: it is probed again on every call.
  if (state.url && state.token) {
    if (state.owned && state.server) {
      if (state.server.listening) {
        metrics.gauge('dashboard_owner_pid', process.pid);
        return {
          started: true,
          url: state.url,
          browserUrl: buildBrowserUrl(state.url, state.token),
          reused: false,
        };
      }
    } else if (await probeDashboard(state.url, state.token, ctx.workspaceId)) {
      metrics.increment('dashboard_reuse_probes');
      return {
        started: true,
        url: state.url,
        browserUrl: buildBrowserUrl(state.url, state.token),
        reused: true,
      };
    }
    stopHeartbeat();
    clearState();
  }

  // 2. Discover a running dashboard of this workspace through the runtime
  //    file. Instances without a valid lease are stale and get taken over.
  const existing = readVisRuntimeFile(runtimeFilePath);
  let warning: string | undefined;
  if (existing && existing.workspaceId === ctx.workspaceId) {
    if (isRuntimeLeaseAlive(existing)) {
      let alive = await probeDashboard(existing.url, existing.token, ctx.workspaceId);
      if (!alive) {
        // The owner may still be warming up; retry once before taking over.
        await sleep(RACE_RECHECK_DELAY_MS);
        alive = await probeDashboard(existing.url, existing.token, ctx.workspaceId);
      }
      if (alive) {
        state.url = existing.url;
        state.token = existing.token;
        state.owned = false;
        state.runtimeFilePath = runtimeFilePath;
        state.lockRoot = workspaceLockRoot(ctx.storeRoot);
        return {
          started: true,
          url: existing.url,
          browserUrl: buildBrowserUrl(existing.url, existing.token),
          reused: true,
        };
      }
      warning =
        'A previous dashboard instance did not answer the authenticated probe; starting a new one.';
    } else {
      warning =
        'A stale dashboard runtime file was found (expired lease); taking over the dashboard.';
    }
    // The stale file itself is NOT removed here: deleting it outside the
    // claim lock could interleave with another process's claim (review
    // R-06 follow-up). claimRuntimeFile inside the lock overwrites stale
    // records atomically.
  }

  // 3. Own a new instance. The read-runtime → claim sequence is serialized
  // by a dedicated cross-process file lock so two processes cannot both
  // believe they own the instance (review R-06).
  const token = generateVisToken();
  const startPort = getDesiredPort();
  const endPort = startPort + MAX_PORT_ATTEMPTS;
  const claimLock = new WorkspaceLock(workspaceLockRoot(ctx.storeRoot), { timeoutMs: 8_000 });

  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
    const port = startPort + offset;
    const server = await tryBindVisServer(ctx, port, hostname, token);
    if (!server) continue;

    const url = `http://${hostname}:${port}`;
    let claimOutcome: { owned: true; warning?: string } | { owned: false; url: string; token: string };
    try {
      claimOutcome = await claimLock.withLock('vis-runtime-claim', async () => {
        const current = readVisRuntimeFile(runtimeFilePath);
        if (current && current.url !== url && isRuntimeLeaseAlive(current)) {
          // Another process may have won the race for this workspace. Only
          // reuse it when it really answers an authenticated probe.
          const winnerAlive = await probeDashboard(current.url, current.token, ctx.workspaceId);
          if (winnerAlive) {
            return { owned: false as const, url: current.url, token: current.token };
          }
        }

        const claim = claimRuntimeFile(ctx, runtimeFilePath, {
          url,
          hostname,
          port,
          token,
        });

        if (!claim.claimed && claim.url && claim.token) {
          // Another process won the race for this workspace: reuse it.
          return { owned: false as const, url: claim.url, token: claim.token };
        }
        return { owned: true as const, warning };
      });
    } catch (err) {
      server.close();
      if (err instanceof LockTimeoutError) {
        return {
          started: false,
          error: 'Another process is currently claiming the dashboard; retry in a moment.',
          warning,
        };
      }
      throw err;
    }

    if (!claimOutcome.owned) {
      // Another process won the race for this workspace: reuse its instance.
      server.close();
      state.url = claimOutcome.url;
      state.token = claimOutcome.token;
      state.owned = false;
      state.runtimeFilePath = runtimeFilePath;
      return {
        started: true,
        url: claimOutcome.url,
        browserUrl: buildBrowserUrl(claimOutcome.url, claimOutcome.token),
        reused: true,
      };
    }

    state.server = server;
    state.url = url;
    state.token = token;
    state.owned = true;
    state.runtimeFilePath = runtimeFilePath;
    state.lockRoot = workspaceLockRoot(ctx.storeRoot);
    metrics.gauge('dashboard_owner_pid', process.pid);
    metrics.increment('dashboard_starts');
    startHeartbeat(runtimeFilePath, token, state.lockRoot);

    return {
      started: true,
      url,
      browserUrl: buildBrowserUrl(url, token),
      reused: false,
      warning,
    };
  }

  return {
    started: false,
    error: `No available port found for vis dashboard between ${startPort} and ${endPort - 1}`,
    warning,
  };
}

async function startOrReuse(ctx: Ctx): Promise<AutoStartResult> {
  if (pendingStart) {
    try {
      return await pendingStart;
    } catch {
      // Fall through and start a fresh attempt.
    }
  }
  const promise = doStartOrReuse(ctx);
  pendingStart = promise;
  try {
    return await promise;
  } finally {
    if (pendingStart === promise) pendingStart = null;
  }
}

/**
 * Start the dashboard only when the user opted in via KIMI_MEMORY_AUTO_VIS.
 * Disabled by default: the dashboard exposes the workspace memory.
 */
export async function maybeStartVisServer(ctx: Ctx): Promise<AutoStartResult> {
  if (!getEnvFlag()) {
    return { started: false };
  }
  return startOrReuse(ctx);
}

/**
 * Start or reuse the dashboard regardless of the auto-start flag. Used by the
 * explicit `open_memory_dashboard` tool, which always re-validates the
 * running instance first and restarts it when it is gone.
 */
export async function ensureVisServer(ctx: Ctx): Promise<AutoStartResult> {
  return startOrReuse(ctx);
}

/** Look for a live dashboard of this workspace without starting one. */
export async function findReusableVisServer(
  ctx: Ctx,
): Promise<{ url: string; token: string } | null> {
  const runtimeFilePath = getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId);
  const existing = readVisRuntimeFile(runtimeFilePath);
  if (!existing || existing.workspaceId !== ctx.workspaceId) return null;
  if (!isRuntimeLeaseAlive(existing)) return null;
  if (!(await probeDashboard(existing.url, existing.token, ctx.workspaceId))) return null;
  return { url: existing.url, token: existing.token };
}

/**
 * Stop the dashboard. Only an instance owned by this process is closed and
 * only its own runtime file is removed; a reused dashboard belongs to another
 * process and is left untouched.
 */
export function stopVisServer(): void {
  stopHeartbeat();
  const owned = state.owned;
  const server = state.server;
  const runtimeFilePath = state.runtimeFilePath;
  const ownedToken = state.token;
  const lockRoot = state.lockRoot;
  clearState();
  if (server) {
    try {
      server.close();
    } catch {
      // The server may already be closed.
    }
  }
  if (owned && runtimeFilePath) {
    // Best-effort cleanup: a lock I/O failure must not turn the shutdown
    // into an error after the HTTP server was already released.
    try {
      removeOwnedRuntimeFileSync(runtimeFilePath, ownedToken, lockRoot);
    } catch (err) {
      metrics.increment('dashboard_runtime_remove_lock_io_error');
      void err;
    }
  }
}

/**
 * Asynchronous variant for graceful shutdown: waits until the HTTP server
 * has actually released the port.
 */
export async function stopVisServerAsync(): Promise<void> {
  stopHeartbeat();
  const owned = state.owned;
  const server = state.server;
  const runtimeFilePath = state.runtimeFilePath;
  const ownedToken = state.token;
  const lockRoot = state.lockRoot;
  clearState();
  if (server) {
    await new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
  if (owned && runtimeFilePath) {
    // Best-effort cleanup: a lock I/O failure must not turn the shutdown
    // into an error after the HTTP server was already released.
    try {
      removeOwnedRuntimeFileSync(runtimeFilePath, ownedToken, lockRoot);
    } catch (err) {
      metrics.increment('dashboard_runtime_remove_lock_io_error');
      void err;
    }
  }
}

/**
 * Remove our runtime record — but only while it is still ours, and only
 * while holding the `vis-runtime-claim` lock: the ownership check and the
 * delete happen as one atomic section, so a newer owner's record written
 * between "read" and "delete" can no longer be destroyed (review R-06
 * TOCTOU).
 *
 * When the lock is held by someone else (a claiming process is mid-handshake)
 * the deletion is skipped entirely — the claimer manages the record from
 * there. When the record on disk belongs to another pid or carries another
 * token, it is left alone as well.
 */
function removeOwnedRuntimeFileSync(
  runtimeFilePath: string,
  ownedToken: string | null,
  lockRoot: string | null,
): void {
  if (!lockRoot) {
    // No lock root known (e.g. a reused instance): skip rather than risk a
    // foreign record — the lease expiry will clean it up.
    metrics.increment('dashboard_runtime_remove_skipped_no_lock_root');
    return;
  }
  const claimLock = new WorkspaceLock(lockRoot);
  const outcome = claimLock.tryWithLockSync('vis-runtime-claim', () => {
    const current = readVisRuntimeFile(runtimeFilePath);
    if (!current) return 'removed' as const;
    if (current.pid !== process.pid || (ownedToken && current.token !== ownedToken)) {
      return 'foreign' as const;
    }
    removeVisRuntimeFile(runtimeFilePath);
    return 'removed' as const;
  });
  if (!outcome.acquired) {
    metrics.increment('dashboard_runtime_remove_skipped_lock_busy');
    return;
  }
  if (outcome.result === 'foreign') {
    metrics.increment('dashboard_runtime_remove_skipped_foreign');
  }
}

/** Plain dashboard URL of the current instance. Never contains the token. */
export function getVisUrl(): string | null {
  return state.url;
}

/**
 * Dashboard URL for the browser, carrying the bootstrap token in the URL
 * fragment. Callers must not log or return the token separately.
 */
export function getVisBrowserUrl(): string | null {
  if (!state.url || !state.token) return null;
  return buildBrowserUrl(state.url, state.token);
}

export interface StandaloneVisHandle {
  url: string;
  browserUrl: string;
  close: () => Promise<void>;
}

/**
 * Start a standalone dashboard (used by `kimi-memory-vis`) on an explicit
 * port. The instance publishes a runtime file so MCP processes of the same
 * workspace can reuse it.
 *
 * The final probe, claim and write run under the same cross-process
 * `vis-runtime-claim` lock as the auto-start path (review R-06): when a
 * live dashboard already exists for the workspace, the second instance
 * refuses to start instead of silently stealing the runtime record.
 */
export async function startStandaloneVisServer(
  ctx: Ctx,
  options: { port: number; hostname?: string },
): Promise<StandaloneVisHandle> {
  const hostname = options.hostname ?? '127.0.0.1';
  const runtimeFilePath = getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId);
  const token = generateVisToken();

  const server = await tryBindVisServer(ctx, options.port, hostname, token);
  if (!server) {
    throw new Error(`Failed to bind the memory dashboard to port ${options.port}`);
  }

  const url = `http://${hostname}:${options.port}`;
  const claimLock = new WorkspaceLock(workspaceLockRoot(ctx.storeRoot), { timeoutMs: 8_000 });

  let claimRejected: string | null = null;
  try {
    await claimLock.withLock('vis-runtime-claim', async () => {
      const current = readVisRuntimeFile(runtimeFilePath);
      if (
        current &&
        current.url !== url &&
        current.workspaceId === ctx.workspaceId &&
        isRuntimeLeaseAlive(current)
      ) {
        const alive = await probeDashboard(current.url, current.token, ctx.workspaceId);
        if (alive) {
          // A live dashboard already owns this workspace: refuse instead of
          // overwriting its discovery record.
          claimRejected = current.url;
          return;
        }
      }
      writeVisRuntimeFile(
        runtimeFilePath,
        buildRuntimeFile(ctx, { url, hostname, port: options.port, token }),
      );
    });
  } catch (err) {
    server.close();
    if (err instanceof LockTimeoutError) {
      throw new Error(
        'Another process is currently claiming the dashboard; retry in a moment.',
      );
    }
    throw err;
  }

  if (claimRejected) {
    server.close();
    throw new Error(
      `A dashboard for this workspace is already running at ${claimRejected}; reuse it instead of starting a second instance.`,
    );
  }

  const timer = setInterval(() => {
    try {
      refreshVisRuntimeRecordUnderClaimLock(
        runtimeFilePath,
        token,
        workspaceLockRoot(ctx.storeRoot),
      );
    } catch {
      // Ignore heartbeat failures.
    }
  }, RUNTIME_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return {
    url,
    browserUrl: buildBrowserUrl(url, token),
    close: async () => {
      clearInterval(timer);
      // Remove the record only while it is still ours, atomically under the
      // claim lock: a newer owner's record written between "read" and
      // "delete" must survive our exit (review R-06 TOCTOU).
      //
      // The cleanup is best-effort: a lock I/O failure (e.g. `.locks`
      // replaced by a regular file) must not prevent the HTTP server from
      // being released (review round 3, P2). The record left behind is
      // stale and taken over via its lease expiry.
      try {
        removeOwnedRuntimeFileSync(runtimeFilePath, token, workspaceLockRoot(ctx.storeRoot));
      } catch (err) {
        metrics.increment('dashboard_runtime_remove_lock_io_error');
        process.stderr.write(
          `[kimi-memory] runtime cleanup failed (the record stays until its lease expires): ` +
            `${err instanceof Error ? err.message : String(err)}\n`,
        );
      } finally {
        await new Promise<void>((resolve) => {
          try {
            server.close(() => resolve());
          } catch {
            resolve();
          }
        });
      }
    },
  };
}
