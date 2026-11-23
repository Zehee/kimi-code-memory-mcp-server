/**
 * Hono HTTP server for the kimi-memory-vis dashboard.
 */

import fs from 'fs';
import path from 'path';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { Ctx } from '../types.js';
import type { ReconcileOutcome } from '../dao/index-reconciler.js';
import { getProjectRoot } from '../utils/paths.js';
import { metrics, healthFromMetrics } from '../utils/metrics.js';
import { WorkspaceJournal } from '../utils/workspace-journal.js';
import {
  MAX_REQUEST_BODY_BYTES,
  generateVisToken,
  isAllowedHost,
  isAllowedOrigin,
  isJsonContentType,
  isSafePathParam,
  isSupportedListenerHostname,
  isValidBearer,
  type ListenerInfo,
} from './security.js';
import {
  getWorkspace,
  getThemes,
  getThemeTimeline,
  getRecentDecisions,
  getMemories,
  getMemoryContent,
  saveEssence,
  updateTheme,
  deleteTheme,
  deleteSearchView,
  listMemoryFolders,
  writeMemory,
  deleteMemory,
  restoreMemory,
  createFolder,
  renameFolder,
  deleteFolder,
} from './api.js';
import {
  InvalidSearchViewKeyError,
  SearchViewAccessError,
  SearchViewNotFoundError,
  SearchViewRepository,
} from '../search/search-view-repository.js';

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
  /** Bearer token required by every /api/* route. Generated when omitted. */
  authToken?: string;
  onReady?: (url: string) => void;
}

export interface VisAppOptions {
  /** Bearer token required by every /api/* route. Generated when omitted. */
  authToken?: string;
  /** Loopback address the dashboard is bound to. */
  hostname?: string;
  /** Port the dashboard is bound to; null while the port is not yet known. */
  port?: number | null;
}

/**
 * Basic content security policy.
 *
 * The dashboard ships no inline script and does not need eval, so scripts are
 * restricted to same-origin files. Inline styles are still used by the
 * generated markup (table alignment, status colors), hence 'unsafe-inline'
 * for styles only.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join('; ');

const appListeners = new WeakMap<Hono, ListenerInfo>();
const appTokens = new WeakMap<Hono, string>();

/** The listener information (host/port) currently accepted by an app. */
export function getVisListener(app: Hono): ListenerInfo | undefined {
  return appListeners.get(app);
}

/** Update the accepted host/port, e.g. once an ephemeral port is known. */
export function setVisListener(app: Hono, hostname: string, port: number): void {
  const listener = appListeners.get(app);
  if (!listener) return;
  listener.hostname = hostname;
  listener.port = port;
}

/** The bearer token an app requires. */
export function getVisAuthToken(app: Hono): string | undefined {
  return appTokens.get(app);
}

function getStaticRoot(): string {
  const root = getProjectRoot();
  // Prefer the sources when running from a checkout so the dashboard always
  // matches the code; packaged installs only ship dist/.
  const sourceStatic = path.join(root, 'src', 'vis', 'static');
  if (fs.existsSync(sourceStatic)) return sourceStatic;
  return path.join(root, 'dist', 'vis', 'static');
}

type JsonBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; response: Response };

/**
 * Read and parse a JSON request body, enforcing the 1 MiB limit while the
 * body is streamed so oversized payloads are rejected instead of buffered.
 */
async function readJsonBody(c: Context): Promise<JsonBodyResult> {
  const stream = c.req.raw.body;
  if (!stream) return { ok: true, body: {} };

  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, response: c.json({ error: 'Payload Too Large' }, 413) };
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return { ok: false, response: c.json({ error: 'Invalid request body' }, 400) };
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be released.
    }
  }

  if (total === 0) return { ok: true, body: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return { ok: false, response: c.json({ error: 'Invalid JSON body' }, 400) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, response: c.json({ error: 'Invalid JSON body' }, 400) };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

export function createApp(ctx: Ctx, options: VisAppOptions = {}): Hono {
  const app = new Hono();

  const authToken = options.authToken && options.authToken.length > 0
    ? options.authToken
    : generateVisToken();
  const listener: ListenerInfo = {
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? null,
  };
  appListeners.set(app, listener);
  appTokens.set(app, authToken);

  app.use('*', async (c, next) => {
    c.header('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    if (c.req.path.startsWith('/api/')) {
      c.header('Cache-Control', 'no-store');
    }
    // Read 10s / write 30s request timeout: a hung handler must not hold the
    // browser (or the caller) forever.
    const timeoutMs = c.req.method === 'GET' || c.req.method === 'HEAD' ? 10_000 : 30_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`request timeout after ${timeoutMs}ms`)), timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
    });
    const started = Date.now();
    metrics.increment('http_requests_active');
    try {
      await Promise.race([next(), timeout]);
      metrics.observe('http_request_duration_ms', Date.now() - started);
    } catch (err) {
      metrics.increment('http_request_errors');
      if (err instanceof Error && err.message.startsWith('request timeout')) {
        return c.json({ error: 'Gateway Timeout' }, 504);
      }
      throw err;
    } finally {
      metrics.increment('http_requests_active', -1);
      if (timer) clearTimeout(timer);
    }
  });

  app.use('/api/*', async (c, next) => {
    // DNS-rebinding hardening: only the address we actually listen on.
    if (!isAllowedHost(c.req.header('host'), listener)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    // Same-origin only: the dashboard never talks to a foreign origin.
    if (!isAllowedOrigin(c.req.header('origin'), listener)) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    // Cross-origin preflight is not supported at all.
    if (c.req.method === 'OPTIONS') {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!isValidBearer(c.req.header('authorization'), authToken)) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
    if (c.req.method === 'POST' || c.req.method === 'PUT' || c.req.method === 'PATCH') {
      if (!isJsonContentType(c.req.header('content-type'))) {
        return c.json({ error: 'Unsupported Media Type' }, 415);
      }
      const lengthHeader = c.req.header('content-length');
      if (lengthHeader) {
        const length = Number(lengthHeader);
        if (Number.isFinite(length) && length > MAX_REQUEST_BODY_BYTES) {
          return c.json({ error: 'Payload Too Large' }, 413);
        }
      }
    }
    // Only index-backed views need a reconcile. Operational endpoints and
    // refined-only views must not repeatedly scan the Markdown corpus.
    const indexBackedRead =
      c.req.path === '/api/workspace' ||
      c.req.path === '/api/memories' ||
      c.req.path === '/api/folders' ||
      c.req.path.startsWith('/api/themes');
    if (c.req.method === 'GET' && indexBackedRead) {
      try {
        await ctx.indexDao.reconcileIndex();
      } catch {
        // Ignore reconciliation failures and serve the cached view.
      }
    }
    await next();
  });

  // Health check: fixed, information free, no authentication required.
  app.get('/healthz', (c) => c.json({ status: 'ok' }));

  // Authenticated operational endpoints: health verdict and content-free
  // metrics for the diagnostics loop.
  app.get('/api/health', (c) => {
    const health = healthFromMetrics();
    return c.json({ ...health, indexState: ctx.indexDao.getIndexState().state });
  });

  app.get('/api/metrics', (c) => {
    return c.json(metrics.snapshot());
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

  app.get('/api/searches', (c) => {
    const repository = new SearchViewRepository(ctx.storeRoot);
    return c.json(
      repository.list().map((view) => ({
        key: view.key,
        query: view.query,
        createdAt: view.createdAt,
        resultCount: view.clusterCount,
      })),
    );
  });

  app.get('/api/searches/:key', (c) => {
    const key = decodeURIComponent(c.req.param('key'));
    const repository = new SearchViewRepository(ctx.storeRoot);
    let data;
    try {
      data = repository.load(key);
    } catch (error) {
      const statusCode =
        error instanceof InvalidSearchViewKeyError || error instanceof SearchViewAccessError
          ? 400
          : error instanceof SearchViewNotFoundError
            ? 404
            : 500;
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        statusCode,
      );
    }
    const clusters = data.clusters;
    const seen = new Set<string>();
    const turns: Array<{
      sessionId: string;
      turnId: number;
      clusterId: number;
      isHit: boolean;
      summary: string;
      facts: string[];
      notes: string[];
      timestamp: string;
    }> = [];

    clusters.forEach((cluster: { hitTurnId?: number; members?: Array<{ sessionId: string; turnId: number }> }, clusterIdx: number) => {
      const members = Array.isArray(cluster.members) ? cluster.members : [];
      members.forEach((m) => {
        const id = `${m.sessionId}:${m.turnId}`;
        if (seen.has(id)) return;
        seen.add(id);
        const refined = ctx.refinedManager.loadRefinedTurn(m.sessionId, m.turnId);
        turns.push({
          sessionId: m.sessionId,
          turnId: m.turnId,
          clusterId: clusterIdx,
          isHit: cluster.hitTurnId === m.turnId,
          summary: refined?.summary || '',
          facts: refined?.facts || [],
          notes: refined?.notes || [],
          timestamp: refined?.timestamp || data.createdAt || '',
        });
      });
    });

    turns.sort((a, b) => {
      const sa = String(a.sessionId);
      const sb = String(b.sessionId);
      if (sa !== sb) return sa.localeCompare(sb);
      return (a.turnId ?? 0) - (b.turnId ?? 0);
    });

    return c.json({
      key,
      query: data.query || '',
      createdAt: data.createdAt || '',
      totalHits: turns.length,
      clusterCount: clusters.length,
      turns,
    });
  });

  app.get('/api/refined-turn/:sessionId/:turnId', (c) => {
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const turnId = parseInt(c.req.param('turnId'), 10);
    const turn = ctx.refinedManager.loadRefinedTurn(sessionId, turnId);
    if (!turn) {
      return c.json({ error: 'Turn not found' }, 404);
    }
    return c.json(turn);
  });

  app.get('/api/folders', (c) => {
    return c.json(listMemoryFolders(ctx));
  });

  // Restore gets a dedicated top-level path: a `/restore` suffix under the
  // generic `:folder{.+}/:key` route is ambiguous (the greedy `{.+}` capture
  // makes the write route swallow the suffix and create a bogus file).
  app.post('/api/restore', async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { folder?: unknown; key?: unknown };
    if (typeof body.folder !== 'string' || typeof body.key !== 'string') {
      return c.json({ ok: false, error: 'folder and key are required' }, 400);
    }
    if (!isSafePathParam(body.folder) || !isSafePathParam(body.key)) {
      return c.json({ ok: false, error: 'Invalid folder path' }, 400);
    }
    const result = await restoreMemory(ctx, body.folder, body.key);
    return c.json(result, result.ok ? 200 : 404);
  });

  app.post('/api/memory/:folder{.+}/:key', async (c) => {
    const folder = decodeURIComponent(c.req.param('folder'));
    const key = decodeURIComponent(c.req.param('key'));
    if (!isSafePathParam(folder) || !isSafePathParam(key)) {
      return c.json({ ok: false, error: 'Invalid folder path' }, 400);
    }
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as {
      content?: unknown;
      title?: unknown;
      tags?: unknown;
      expectedRevision?: unknown;
      expectedContentHash?: unknown;
    };
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((t): t is string => typeof t === 'string')
      : undefined;
    const result = await writeMemory(ctx, folder, key, {
      content: typeof body.content === 'string' ? body.content : '',
      title: typeof body.title === 'string' ? body.title : undefined,
      tags,
      expectedRevision:
        typeof body.expectedRevision === 'number' && Number.isInteger(body.expectedRevision)
          ? body.expectedRevision
          : undefined,
      expectedContentHash:
        typeof body.expectedContentHash === 'string' ? body.expectedContentHash : undefined,
    });
    return c.json(result, result.ok ? 200 : (result.statusCode ?? 500));
  });

  app.delete('/api/memory/:folder{.+}/:key', async (c) => {
    const folder = decodeURIComponent(c.req.param('folder'));
    const key = decodeURIComponent(c.req.param('key'));
    if (!isSafePathParam(folder) || !isSafePathParam(key)) {
      return c.json({ ok: false, error: 'Invalid folder path' }, 400);
    }
    const result = await deleteMemory(ctx, folder, key);
    return c.json(result, result.ok ? 200 : 404);
  });

  app.get('/api/memory/:folder{.+}/:key', (c) => {
    const folder = decodeURIComponent(c.req.param('folder'));
    const key = decodeURIComponent(c.req.param('key'));
    if (!isSafePathParam(folder) || !isSafePathParam(key)) {
      return c.json({ error: 'Invalid folder path' }, 400);
    }
    const result = getMemoryContent(ctx, folder, key);
    if (!result) return c.json({ error: 'Memory not found' }, 404);
    return c.json(result);
  });

  app.post('/api/folders', async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { folder?: unknown };
    if (typeof body.folder !== 'string') {
      return c.json({ ok: false, error: 'folder is required' }, 400);
    }
    if (!isSafePathParam(body.folder)) {
      return c.json({ ok: false, error: 'Invalid folder path' }, 400);
    }
    const result = await createFolder(ctx, body.folder);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post('/api/folders/:folder{.+}/rename', async (c) => {
    const folder = decodeURIComponent(c.req.param('folder'));
    if (!isSafePathParam(folder)) {
      return c.json({ ok: false, error: 'Invalid folder path' }, 400);
    }
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { newFolder?: unknown };
    if (typeof body.newFolder !== 'string') {
      return c.json({ ok: false, error: 'newFolder is required' }, 400);
    }
    if (!isSafePathParam(body.newFolder)) {
      return c.json({ ok: false, error: 'Invalid folder path' }, 400);
    }
    const result = await renameFolder(ctx, folder, body.newFolder);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.delete('/api/folders/:folder{.+}', async (c) => {
    const folder = decodeURIComponent(c.req.param('folder'));
    if (!isSafePathParam(folder)) {
      return c.json({ ok: false, error: 'Invalid folder path' }, 400);
    }
    const recursive = c.req.query('recursive') === 'true';
    const result = await deleteFolder(ctx, folder, recursive);
    return c.json(result, result.ok ? 200 : 400);
  });

  app.post('/api/essence', async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { content?: unknown; expectedRevision?: unknown };
    if (typeof body.content !== 'string') {
      return c.json({ error: 'content is required' }, 400);
    }
    const expectedRevision =
      typeof body.expectedRevision === 'number' && Number.isInteger(body.expectedRevision)
        ? body.expectedRevision
        : undefined;
    const result = await saveEssence(ctx, body.content, expectedRevision);
    return c.json(result, result.ok ? 200 : (result.statusCode ?? 500));
  });

  app.post('/api/essence/rollback', async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as { revision?: unknown };
    const revision =
      typeof body.revision === 'number' && Number.isInteger(body.revision) ? body.revision : undefined;
    const { rollbackEssence } = await import('../tools/system-tools.js');
    const result = await rollbackEssence(ctx, revision);
    return c.json(result, result.success ? 200 : 400);
  });

  app.post('/api/themes/:theme', async (c) => {
    const theme = decodeURIComponent(c.req.param('theme'));
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as {
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

    const result = await updateTheme(ctx, theme, patch);
    return c.json(result, result.ok ? 200 : 404);
  });

  app.delete('/api/themes/:theme', async (c) => {
    const theme = decodeURIComponent(c.req.param('theme'));
    const result = await deleteTheme(ctx, theme);
    return c.json(result, result.ok ? 200 : 404);
  });

  app.delete('/api/searches/:key', async (c) => {
    const key = decodeURIComponent(c.req.param('key'));
    const deleteRefinedTurns = c.req.query('deleteRefinedTurns') === 'true';
    const result = await deleteSearchView(ctx, key, deleteRefinedTurns);
    return c.json(result, result.ok ? 200 : (result.statusCode ?? 500));
  });

  app.post('/api/sync', async (c) => {
    // The reconcile outcome feeds the journal recovery: a `synced: false`
    // result keeps every prepared entry on disk instead of dropping the
    // only recovery clue (same contract as sync_workspace_index).
    let syncOutcome: ReconcileOutcome | null = null;
    const journal = new WorkspaceJournal(ctx.storeRoot);
    const recovery = await journal.recover(async () => {
      syncOutcome = await ctx.indexDao.reconcileIndex();
      return syncOutcome;
    });
    return c.json({
      ...(syncOutcome as unknown as object),
      indexState: ctx.indexDao.getIndexState().state,
      journalRecovered: recovery.recovered,
      journalFailed: recovery.failed,
      journalCorrupt: recovery.corrupt,
    });
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

  // The dashboard is a local-only tool: binding it to a non-loopback address
  // would expose the workspace memory to the local network.
  if (!isSupportedListenerHostname(hostname)) {
    throw new Error(
      `Refusing to bind the memory dashboard to a non-loopback address: ${hostname}`,
    );
  }

  const authToken = options.authToken && options.authToken.length > 0
    ? options.authToken
    : generateVisToken();
  const app = createApp(ctx, { authToken, hostname, port: port === 0 ? null : port });

  const server = serve(
    {
      fetch: app.fetch,
      port,
      hostname,
    },
    () => {
      const address = server.address();
      const actualPort =
        address && typeof address === 'object' && 'port' in address
          ? (address as { port: number }).port
          : port;
      setVisListener(app, hostname, actualPort);
      onReady?.(`http://${hostname}:${actualPort}`);
    },
  );
  return server;
}
