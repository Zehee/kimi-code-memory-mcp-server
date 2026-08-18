/**
 * Optional auto-start of the kimi-memory-vis dashboard when the MCP server starts.
 */

import type { ServerType } from '@hono/node-server';
import type { Ctx } from '../types.js';
import { startVisServer } from './server.js';

const DEFAULT_VIS_PORT = 58628;
const MAX_PORT_ATTEMPTS = 10;

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
  error?: string;
}

export async function maybeStartVisServer(ctx: Ctx): Promise<AutoStartResult> {
  if (!getEnvFlag()) {
    return { started: false };
  }

  if (activeServer) {
    return { started: true, url: activeUrl ?? undefined };
  }

  const hostname = process.env.KIMI_MEMORY_VIS_HOST || '127.0.0.1';
  const startPort = getDesiredPort();

  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
    const port = startPort + offset;
    const server = await tryBindVisServer(ctx, port, hostname);
    if (server) {
      activeServer = server;
      activeUrl = `http://${hostname}:${port}`;
      return { started: true, url: activeUrl };
    }
  }

  return {
    started: false,
    error: `No available port found for vis dashboard between ${startPort} and ${startPort + MAX_PORT_ATTEMPTS - 1}`,
  };
}

export function stopVisServer(): void {
  if (activeServer) {
    activeServer.close();
    activeServer = null;
    activeUrl = null;
  }
}

export function getVisUrl(): string | null {
  return activeUrl;
}
