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

  const staticRoot = getStaticRoot();
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
      : '<h1>kimi-memory-vis</h1><p>Static files not found. Run npm run build first.</p>';
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
