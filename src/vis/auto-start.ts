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

function isPortAvailable(port: number, hostname: string): Promise<boolean> {
  return new Promise((resolve) => {
    import('net')
      .then(({ createServer }) => {
        const tester = createServer()
          .once('error', () => resolve(false))
          .once('listening', () => {
            tester.close(() => resolve(true));
          })
          .listen(port, hostname);
      })
      .catch(() => resolve(false));
  });
}

async function findAvailablePort(startPort: number, hostname: string): Promise<number | null> {
  for (let offset = 0; offset < MAX_PORT_ATTEMPTS; offset++) {
    const port = startPort + offset;
    if (await isPortAvailable(port, hostname)) {
      return port;
    }
  }
  return null;
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
  const port = await findAvailablePort(startPort, hostname);

  if (port === null) {
    const error = `No available port found for vis dashboard between ${startPort} and ${startPort + MAX_PORT_ATTEMPTS - 1}`;
    return { started: false, error };
  }

  try {
    const url = `http://${hostname}:${port}`;
    activeServer = startVisServer({
      ctx,
      port,
      hostname,
      onReady: () => {
        // Intentionally quiet; URL is returned to the caller.
      },
    });
    activeUrl = url;
    return { started: true, url };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { started: false, error };
  }
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
