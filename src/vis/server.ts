/**
 * Hono HTTP server for the kimi-memory-vis dashboard.
 */

import fs from 'fs';
import path from 'path';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Ctx } from '../types.js';
import { getProjectRoot } from '../utils/paths.js';
import {
  getWorkspace,
  getThemes,
  getThemeTimeline,
  getRecentDecisions,
  getMemories,
  getMemoryContent,
  saveEssence,
  updateTheme,
} from './api.js';

const KIMI_ORIGIN = 'http://127.0.0.1:58627';
const THEME_CACHE_TTL_MS = 60_000;

const FALLBACK_CSS = `:root {
  color-scheme: light dark;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --r-sm: 6px;
  --r-md: 8px;
  --r-lg: 12px;
}
@media (prefers-color-scheme: light) {
  :root {
    --bg: #ffffff;
    --canvas: #f6f8fa;
    --panel: #f6f8fa;
    --panel2: #f3f4f6;
    --line: #d1d9e0;
    --ink: #1f2328;
    --text: #1f2328;
    --muted: #656d76;
    --dim: #8c959f;
    --blue: #0969da;
    --blue2: #218bff;
    --bluebg: #ddf4ff;
    --soft: #f6f8fa;
    --bd: #0969da;
    --ok: #1a7f37;
    --err: #cf222e;
    --warn: #9a6700;
  }
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --canvas: #161b22;
    --panel: #1c2128;
    --panel2: #21262d;
    --line: #2d333b;
    --ink: rgba(255,255,255,0.84);
    --text: rgba(255,255,255,0.84);
    --muted: rgba(255,255,255,0.55);
    --dim: rgba(255,255,255,0.35);
    --blue: #58a6ff;
    --blue2: #79b8ff;
    --bluebg: #1c2a3a;
    --soft: #21262d;
    --bd: #1f6feb;
    --ok: #3fb950;
    --err: #f85149;
    --warn: #f5b301;
  }
}`;

interface CachedTheme {
  css: string;
  fetchedAt: number;
}

let cachedTheme: CachedTheme | null = null;

async function fetchTextWithTimeout(url: string, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

async function proxyKimiThemeCss(): Promise<{ css: string; fromCache: boolean }> {
  if (cachedTheme && Date.now() - cachedTheme.fetchedAt < THEME_CACHE_TTL_MS) {
    return { css: cachedTheme.css, fromCache: true };
  }

  try {
    const html = await fetchTextWithTimeout(`${KIMI_ORIGIN}/`, 3000);
    const match =
      html.match(
        new RegExp(`<link[^>]+rel=["']stylesheet["'][^>]*href=["'](/assets/index-[a-zA-Z0-9]+\\.css)["'][^>]*>`, 'i'),
      ) ||
      html.match(
        new RegExp(`<link[^>]+href=["'](/assets/index-[a-zA-Z0-9]+\\.css)["'][^>]*rel=["']stylesheet["'][^>]*>`, 'i'),
      );
    const cssPath = match?.[1];
    if (!cssPath) throw new Error('Kimi stylesheet link not found');

    const css = await fetchTextWithTimeout(`${KIMI_ORIGIN}${cssPath}`, 3000);
    cachedTheme = { css, fetchedAt: Date.now() };
    return { css, fromCache: false };
  } catch {
    return { css: FALLBACK_CSS, fromCache: false };
  }
}

export interface VisServerOptions {
  ctx: Ctx;
  port: number;
  hostname?: string;
  onReady?: (url: string) => void;
}

function getStaticRoot(): string {
  return path.join(getProjectRoot(), 'dist', 'vis', 'static');
}

export function createApp(ctx: Ctx): Hono {
  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    c.header('Access-Control-Allow-Origin', '*');
    c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    if (c.req.method === 'OPTIONS') return c.body(null, 204);
    await next();
  });

  app.get('/api/workspace', (c) => {
    return c.json(getWorkspace(ctx));
  });

  app.get('/api/themes', (c) => {
    return c.json(getThemes(ctx));
  });

  app.get('/api/themes/:theme', (c) => {
    const theme = decodeURIComponent(c.req.param('theme'));
    return c.json(getThemeTimeline(ctx, theme));
  });

  app.get('/api/decisions', (c) => {
    const limitRaw = c.req.query('limit');
    const limit = limitRaw ? parseInt(limitRaw, 10) : undefined;
    return c.json(getRecentDecisions(ctx, limit));
  });

  app.get('/api/memories', (c) => {
    return c.json(getMemories(ctx));
  });

  app.get('/api/memory/:folder{.+}/:key', (c) => {
    const folder = decodeURIComponent(c.req.param('folder'));
    const key = decodeURIComponent(c.req.param('key'));
    const result = getMemoryContent(ctx, folder, key);
    if (!result) return c.json({ error: 'Memory not found' }, 404);
    return c.json(result);
  });

  app.post('/api/essence', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { content?: unknown };
    if (typeof body.content !== 'string') {
      return c.json({ error: 'content is required' }, 400);
    }
    return c.json(saveEssence(ctx, body.content));
  });

  app.post('/api/themes/:theme', async (c) => {
    const theme = decodeURIComponent(c.req.param('theme'));
    const body = (await c.req.json().catch(() => ({}))) as {
      displayName?: unknown;
      removeTurns?: unknown;
    };
    const patch: { displayName?: string; removeTurns?: Array<{ sessionId: string; turnId: number }> } = {};

    if (typeof body.displayName === 'string') {
      patch.displayName = body.displayName;
    }

    if (Array.isArray(body.removeTurns)) {
      patch.removeTurns = body.removeTurns
        .filter(
          (t): t is { sessionId: string; turnId: number } =>
            t && typeof t === 'object' && typeof t.sessionId === 'string' && typeof t.turnId === 'number',
        )
        .map((t) => ({ sessionId: t.sessionId, turnId: t.turnId }));
    }

    const result = updateTheme(ctx, theme, patch);
    return c.json(result, result.ok ? 200 : 404);
  });

  app.post('/api/sync', async (c) => {
    const result = await ctx.indexDao.reconcileIndex();
    return c.json(result);
  });

  app.get('/kimi-theme.css', async (c) => {
    const result = await proxyKimiThemeCss();
    c.header('Content-Type', 'text/css');
    c.header('X-Theme-Source', result.fromCache ? 'cache' : result.css === FALLBACK_CSS ? 'fallback' : 'proxy');
    return c.body(result.css);
  });

  const staticRoot = getStaticRoot();
  if (!fs.existsSync(staticRoot)) {
    fs.mkdirSync(staticRoot, { recursive: true });
  }
  app.use(
    '/*',
    serveStatic({
      root: staticRoot,
      index: 'index.html',
    }),
  );

  app.get('/*', (c) => {
    const indexPath = path.join(staticRoot, 'index.html');
    const html = fs.existsSync(indexPath)
      ? fs.readFileSync(indexPath, 'utf8')
      : '<!doctype html><html><head><title>Memory Vis</title></head><body><h1>kimi-memory-vis</h1><p>Static files not found. Run npm run build first.</p></body></html>';
    return c.html(html);
  });

  return app;
}

export function startVisServer(options: VisServerOptions): ServerType {
  const { ctx, port, hostname = '127.0.0.1', onReady } = options;
  const app = createApp(ctx);
  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname,
    },
    () => {
      const url = `http://${hostname}:${port}`;
      onReady?.(url);
    },
  );
  return server;
}
