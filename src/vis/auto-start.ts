/**
 * Optional auto-start of the kimi-memory-vis dashboard when the MCP server starts.
 *
 * Kimi Code may spawn several MCP server processes for the same workspace
 * (main session, secondary model, tool selection, ...). The dashboard is a
 * per-workspace singleton: the first process binds a port and opens the
 * browser, later processes detect the running dashboard via /api/workspace
 * and reuse it without opening another window.
 */

import type { ServerType } from '@hono/node-server';
import type { Ctx } from '../types.js';
import { startVisServer } from './server.js';

const DEFAULT_VIS_PORT = 58628;
const MAX_PORT_ATTEMPTS = 10;
const PROBE_TIMEOUT_MS = 500;
const RACE_RECHECK_DELAY_MS = 400;

let activeServer: ServerType | null = null;
let activeUrl: string | null = null;

function getEnvFlag(): boolean {
  const raw = process.env.KIMI_MEMORY_AUTO_VIS;
  if (!raw) return true;
  return raw === '1' || raw.toLowerCase() === 'true';
}

function getDesiredPort(): number {
  const raw = process.env.KIMI_MEMORY_VIS_PORT;
  if (!raw) return DEFAULT_VIS_PORT;
  const parsed = parseInt(raw, 10);
  return Number.isNaN(parsed) ? DEFAULT_VIS_PORT : parsed;
}

/**
 * Ask a port whether it serves a kimi-memory-vis dashboard for the given
 * workspace. Returns the dashboard URL on a match, null otherwise (port
 * closed, foreign service, or a different workspace).
 */
async function probeDashboard(hostname: string, port: number, workspaceId: string): Promise<string | null> {
  const url = `http://${hostname}:${port}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/api/workspace`, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { id?: unknown };
    return data.id === workspaceId ? url : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findExistingDashboard(
  hostname: string,
  startPort: number,
  endPortExclusive: number,
  workspaceId: string,
): Promise<string | null> {
  for (let port = startPort; port < endPortExclusive; port++) {
    const url = await probeDashboard(hostname, port, workspaceId);
    if (url) return url;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Try to bind the vis server on a port, resolving once the server is actually
 * listening. A failed bind (e.g. EADDRINUSE when another workspace's server
 * wins the race) resolves to null instead of crashing the process — the
 * dashboard is optional and must never take down the MCP stdio server.
 */
function tryBindVisServer(ctx: Ctx, port: number, hostname: string): Promise<ServerType | null> {
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

export interface AutoStartResult {
  started: boolean;
  url?: string;
  /** True when an existing dashboard for this workspace was reused; the caller must not open another browser window. */
  reused?: boolean;
  error?: string;
}

export async function maybeStartVisServer(ctx: Ctx): Promise<AutoStartResult> {
  if (!getEnvFlag()) {
    return { started: false };
  }

  if (activeUrl) {
    return { started: true, url: activeUrl, reused: !activeServer };
  }

  const hostname = process.env.KIMI_MEMORY_VIS_HOST || '127.0.0.1';
  const startPort = getDesiredPort();
  const endPort = startPort + MAX_PORT_ATTEMPTS;

  const existing = await findExistingDashboard(hostname, startPort, endPort, ctx.workspaceId);
  if (existing) {
    activeUrl = existing;
    return { started: true, url: existing, reused: true };
  }

  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
    const port = startPort + offset;
    const server = await tryBindVisServer(ctx, port, hostname);
    if (server) {
      const url = `http://${hostname}:${port}`;
      // Sibling processes for the same workspace may have raced us to a lower
      // port while we were binding. Re-check lower ports (twice, to cover a
      // sibling that is still starting up); the lowest port wins and everyone
      // else closes their server and reuses it.
      if (offset > 0) {
        let lower: string | null = null;
        for (let attempt = 0; attempt < 2 && !lower; attempt++) {
          if (attempt > 0) await sleep(RACE_RECHECK_DELAY_MS);
          lower = await findExistingDashboard(hostname, startPort, port, ctx.workspaceId);
        }
        if (lower) {
          server.close();
          activeUrl = lower;
          return { started: true, url: lower, reused: true };
        }
      }
      activeServer = server;
      activeUrl = url;
      return { started: true, url };
    }
  }

  return {
    started: false,
    error: `No available port found for vis dashboard between ${startPort} and ${endPort - 1}`,
  };
}

export function stopVisServer(): void {
  if (activeServer) {
    activeServer.close();
    activeServer = null;
  }
  // A reused dashboard belongs to another process; never close it here.
  activeUrl = null;
}

export function getVisUrl(): string | null {
  return activeUrl;
}
