/**
 * Security tests for the kimi-memory-vis dashboard.
 *
 * Covers the SEC-01 / WEB-01 requirements of the architecture audit:
 * bearer authentication on every /api/* route, Host and Origin validation,
 * request size limits, path traversal defence, token hygiene and the
 * frontend hardening (bootstrap fragment, markdown URL whitelist, CSP).
 */

import fs from 'fs';
import path from 'path';
import http from 'http';
import assert from 'assert';
import { fileURLToPath, pathToFileURL } from 'url';
import { authHeaders, createTempCtx, startTestServer, TEST_TOKEN } from './vis.test.js';
import { startVisServer } from '../src/vis/server.js';
import {
  VIS_RUNTIME_SCHEMA_VERSION,
  getVisRuntimeFilePath,
  writeVisRuntimeFile,
} from '../src/vis/security.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function rawRequest(options: {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

async function testUnauthenticatedRequestsAreRejected() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const getRes = await fetch(`${url}/api/workspace`);
    assert.strictEqual(getRes.status, 401, 'GET without a token must be rejected');
    const getBody = await getRes.text();
    assert(!/\n\s+at\s/.test(getBody), 'the error body must not contain a stack trace');
    assert(!getBody.includes('src/'), 'the error body must not contain internals');

    const postRes = await fetch(`${url}/api/essence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'nope' }),
    });
    assert.strictEqual(postRes.status, 401, 'POST without a token must be rejected');

    const deleteRes = await fetch(`${url}/api/folders/memory`, {
      method: 'DELETE',
    });
    assert.strictEqual(deleteRes.status, 401, 'DELETE without a token must be rejected');

    const listRes = await fetch(`${url}/api/memories`);
    assert.strictEqual(listRes.status, 401, 'every GET needs a token');

    const wrongToken = await fetch(`${url}/api/workspace`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.strictEqual(wrongToken.status, 401, 'a wrong token must be rejected');

    const malformed = await fetch(`${url}/api/workspace`, {
      headers: { Authorization: TEST_TOKEN },
    });
    assert.strictEqual(malformed.status, 401, 'a token without the Bearer scheme must be rejected');

    const ok = await fetch(`${url}/api/workspace`, { headers: authHeaders() });
    assert(ok.ok, 'the configured token must be accepted');
  } finally {
    await stop();
    cleanup();
  }
}

async function testMaliciousOriginIsRejected() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const evil = await fetch(`${url}/api/workspace`, {
      headers: { ...authHeaders(), Origin: 'http://evil.example' },
    });
    assert.strictEqual(evil.status, 403, 'a foreign origin must be rejected');
    assert(!evil.headers.get('access-control-allow-origin'), 'no CORS header may be returned');

    const preflight = await fetch(`${url}/api/workspace`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://evil.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    assert.strictEqual(preflight.status, 403, 'a cross-origin preflight must fail closed');
    assert(!preflight.headers.get('access-control-allow-origin'));
    assert(!preflight.headers.get('access-control-allow-methods'));

    const sameOrigin = await fetch(`${url}/api/workspace`, {
      headers: { ...authHeaders(), Origin: url },
    });
    assert(sameOrigin.ok, 'the dashboard origin itself must be allowed');
  } finally {
    await stop();
    cleanup();
  }
}

async function testHostHeaderValidation() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  const port = portOf(url);
  try {
    const evilHost = await rawRequest({
      port,
      path: '/api/workspace',
      headers: { Host: `evil.example:${port}`, Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.strictEqual(evilHost.status, 403, 'a foreign Host must be rejected');

    const wrongPort = await rawRequest({
      port,
      path: '/api/workspace',
      headers: { Host: `127.0.0.1:${port + 1}`, Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.strictEqual(wrongPort.status, 403, 'a Host with a foreign port must be rejected');

    const valid = await rawRequest({
      port,
      path: '/api/workspace',
      headers: { Host: `127.0.0.1:${port}`, Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.strictEqual(valid.status, 200, 'the real listener address must be accepted');
  } finally {
    await stop();
    cleanup();
  }
}

async function testRequestBodyLimit() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const oversized = 'x'.repeat(1024 * 1024 + 1024);
    const tooLarge = await fetch(`${url}/api/essence`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ content: oversized }),
    });
    assert.strictEqual(tooLarge.status, 413, 'a body above 1 MiB must be rejected');

    // A chunked body without Content-Length must be rejected while streaming.
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        controller.close();
      },
    });
    const chunked = await fetch(`${url}/api/essence`, {
      method: 'POST',
      headers: authHeaders(),
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: string });
    assert.strictEqual(chunked.status, 413, 'a chunked body above 1 MiB must be rejected');

    const prefix = '{"content":"';
    const suffix = '"}';
    const padding = 'y'.repeat(1024 * 1024 - prefix.length - suffix.length);
    const atLimit = await fetch(`${url}/api/essence`, {
      method: 'POST',
      headers: authHeaders(),
      body: `${prefix}${padding}${suffix}`,
    });
    assert.notStrictEqual(atLimit.status, 413, 'a body of exactly 1 MiB is allowed');
  } finally {
    await stop();
    cleanup();
  }
}

async function testWriteRequestsRequireJson() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const plain = await fetch(`${url}/api/essence`, {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    assert.strictEqual(plain.status, 415, 'a non JSON content type must be rejected');

    const withoutType = await fetch(`${url}/api/essence`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
      body: JSON.stringify({ content: 'hello' }),
    });
    assert.strictEqual(withoutType.status, 415, 'a missing content type must be rejected');

    const brokenJson = await fetch(`${url}/api/essence`, {
      method: 'POST',
      headers: authHeaders(),
      body: '{not json',
    });
    assert.strictEqual(brokenJson.status, 400, 'a broken JSON body must be rejected');
  } finally {
    await stop();
    cleanup();
  }
}

async function testPathTraversalIsRejected() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const search = await fetch(`${url}/api/searches/${encodeURIComponent('../../etc/passwd')}`, {
      headers: authHeaders(),
    });
    assert.strictEqual(search.status, 400, 'a traversing search view key must be rejected');

    const memory = await fetch(
      `${url}/api/memory/${encodeURIComponent('../../etc')}/${encodeURIComponent('passwd')}`,
      { headers: authHeaders() },
    );
    assert.strictEqual(memory.status, 400, 'a traversing folder must be rejected');

    const folder = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ folder: '../escape' }),
    });
    assert.strictEqual(folder.status, 400, 'a traversing folder name must be rejected');

    const rename = await fetch(`${url}/api/folders/${encodeURIComponent('memory/knowledge')}/rename`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ newFolder: '../../escape' }),
    });
    assert.strictEqual(rename.status, 400, 'a traversing rename target must be rejected');

    assert(!fs.existsSync(path.join(ctx.storeRoot, '..', 'escape')), 'nothing may be written outside the store');
  } finally {
    await stop();
    cleanup();
  }
}

async function testSecurityHeadersAndHealthCheck() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const page = await fetch(`${url}/`);
    assert(page.ok);
    const csp = page.headers.get('content-security-policy') ?? '';
    assert(csp.includes("script-src 'self'"), 'CSP must restrict scripts to same-origin');
    assert(csp.includes("connect-src 'self'"), 'CSP must restrict connections to same-origin');
    assert(csp.includes("object-src 'none'"), 'CSP must forbid plugins');
    assert(csp.includes("base-uri 'none'"), 'CSP must forbid base tag injection');
    assert(!csp.includes('unsafe-eval'), 'CSP must not allow unsafe-eval');
    assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
    assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');

    const health = await fetch(`${url}/healthz`);
    assert(health.ok);
    const payload = (await health.json()) as Record<string, unknown>;
    assert.deepStrictEqual(payload, { status: 'ok' }, 'the health check must return a fixed payload');
    assert(!JSON.stringify(payload).includes(ctx.workspaceId), 'the health check must not leak workspace data');
  } finally {
    await stop();
    cleanup();
  }
}

async function testTokenNeverLeaks() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx, 'super-secret-token-value');
  try {
    const page = await fetch(`${url}/`);
    const html = await page.text();
    assert(!html.includes('super-secret-token-value'), 'the token must not appear in the HTML');
    assert(!html.includes('bootstrap='), 'the HTML must not contain a bootstrap token');

    const apiRes = await fetch(`${url}/api/workspace`, {
      headers: { Authorization: 'Bearer super-secret-token-value' },
    });
    const body = await apiRes.text();
    assert(!body.includes('super-secret-token-value'), 'the token must not appear in API responses');
    assert(!body.toLowerCase().includes('authorization'), 'the token must not be echoed back');

    const apiJs = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'vis', 'static', 'api.js'),
      'utf8',
    );
    assert(!apiJs.includes('super-secret-token-value'));
    assert(apiJs.includes('bootstrap='), 'the frontend must read the bootstrap fragment');
    assert(apiJs.includes('replaceState'), 'the frontend must remove the bootstrap fragment');
    assert(apiJs.includes('Authorization'), 'the frontend must send the bearer token');
  } finally {
    await stop();
    cleanup();
  }
}

interface MarkdownModule {
  sanitizeUrl: (raw: string) => string | null;
  renderMarkdown: (md: string) => string;
}

interface ApiModule {
  getAuthToken: () => string | null;
}

async function importFrontend<T>(relativePath: string): Promise<T> {
  const fileUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'vis', 'static', relativePath)).href;
  const module = await import(`${fileUrl}?cache=${Date.now()}-${Math.random()}`);
  return module as T;
}

async function testMarkdownUrlWhitelist() {
  const markdown = await importFrontend<MarkdownModule>('utils/markdown.js');

  assert.strictEqual(markdown.sanitizeUrl('https://example.com/a'), 'https://example.com/a');
  assert.strictEqual(markdown.sanitizeUrl('http://example.com/a'), 'http://example.com/a');
  assert.strictEqual(markdown.sanitizeUrl('mailto:someone@example.com'), 'mailto:someone@example.com');
  assert.strictEqual(markdown.sanitizeUrl('./relative/path'), './relative/path');
  assert.strictEqual(markdown.sanitizeUrl('/absolute/path'), '/absolute/path');
  assert.strictEqual(markdown.sanitizeUrl('#anchor'), '#anchor');

  assert.strictEqual(markdown.sanitizeUrl('javascript:alert(1)'), null);
  assert.strictEqual(markdown.sanitizeUrl('JavaScript:alert(1)'), null);
  assert.strictEqual(markdown.sanitizeUrl('java\tscript:alert(1)'), null);
  assert.strictEqual(markdown.sanitizeUrl('data:text/html;base64,PHNjcmlwdD4='), null);
  assert.strictEqual(markdown.sanitizeUrl('vbscript:msgbox(1)'), null);
  assert.strictEqual(markdown.sanitizeUrl('file:///etc/passwd'), null);
  assert.strictEqual(markdown.sanitizeUrl('//evil.example/path'), null);

  const rendered = markdown.renderMarkdown('[click](javascript:alert(1))');
  assert(!rendered.includes('javascript:'), 'a javascript URL must not survive rendering');
  assert(!rendered.includes('<a href'), 'a blocked link must not become an anchor');

  const allowed = markdown.renderMarkdown('[ok](https://example.com/x)');
  assert(allowed.includes('href="https://example.com/x"'), 'allowed links keep their href');

  const escaped = markdown.renderMarkdown('<script>alert(1)</script>');
  assert(!escaped.includes('<script>'), 'raw HTML must stay escaped');
}

async function testFrontendBootstrapFragment() {
  const store = new Map<string, string>();
  let replacedUrl: string | null = null;
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousWindow = globals.window;
  const previousSession = globals.sessionStorage;

  globals.window = {
    location: { hash: '#bootstrap=secret-bootstrap-token', pathname: '/', search: '' },
    history: {
      replaceState: (_state: unknown, _title: unknown, url: string) => {
        replacedUrl = url;
      },
    },
  };
  globals.sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };

  try {
    const apiModule = await importFrontend<ApiModule>('api.js');
    assert.strictEqual(apiModule.getAuthToken(), 'secret-bootstrap-token');
    assert(store.get('kimi-memory-vis.token'), 'the token must be stored in sessionStorage');
    assert(replacedUrl !== null, 'the fragment must be removed from the address bar');
    assert(!String(replacedUrl).includes('bootstrap'), 'the token must not stay in the URL');
    assert(!String(replacedUrl).includes('#'), 'the fragment must be removed');
  } finally {
    globals.window = previousWindow;
    globals.sessionStorage = previousSession;
  }
}

async function testFrontendKeepsRoutingHash() {
  const store = new Map<string, string>();
  let replaceCalls = 0;
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousWindow = globals.window;
  const previousSession = globals.sessionStorage;

  globals.window = {
    location: { hash: '#themes/my-theme', pathname: '/', search: '' },
    history: {
      replaceState: () => {
        replaceCalls += 1;
      },
    },
  };
  globals.sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };

  try {
    const apiModule = await importFrontend<ApiModule>('api.js');
    assert.strictEqual(apiModule.getAuthToken(), null, 'no token without a bootstrap fragment');
    assert.strictEqual(replaceCalls, 0, 'a routing hash must not be touched');
  } finally {
    globals.window = previousWindow;
    globals.sessionStorage = previousSession;
  }
}

async function testNonLoopbackListenerIsRefused() {
  const { ctx, cleanup } = createTempCtx();
  try {
    assert.throws(
      () => startVisServer({ ctx, port: 0, hostname: '0.0.0.0' }),
      /non-loopback/,
      'binding to a non-loopback address must be refused',
    );
    assert.throws(
      () => startVisServer({ ctx, port: 0, hostname: '192.168.1.10' }),
      /non-loopback/,
      'binding to a LAN address must be refused',
    );
  } finally {
    ctx.refinedManager.close();
    cleanup();
  }
}

async function testRuntimeFileIsPrivate() {
  const { ctx, cleanup } = createTempCtx();
  const runtimePath = getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId);
  const runtimeDir = path.dirname(runtimePath);
  assert(runtimeDir.startsWith(ctx.storeRoot), 'the runtime file must live inside the workspace store');
  assert(runtimeDir.includes('runtime'), 'the runtime file must live in a dedicated runtime directory');

  writeVisRuntimeFile(runtimePath, {
    schemaVersion: VIS_RUNTIME_SCHEMA_VERSION,
    workspaceId: ctx.workspaceId,
    url: 'http://127.0.0.1:58628',
    hostname: '127.0.0.1',
    port: 58628,
    pid: process.pid,
    token: 'a'.repeat(64),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    lease: { ownerPid: process.pid, expiresAt: new Date(Date.now() + 30_000).toISOString() },
  });

  assert(fs.existsSync(runtimePath));
  if (process.platform !== 'win32') {
    const mode = fs.statSync(runtimePath).mode & 0o777;
    assert.strictEqual(mode, 0o600, `the runtime file must be 0600, got ${mode.toString(8)}`);
  }
  const parsed = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as { token: string };
  assert.strictEqual(parsed.token.length, 64, 'the token must carry at least 32 bytes of entropy');
  cleanup();
}

async function testEveryApiRouteRequiresAuth() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const port = portOf(url);
    // Every /api/* route the server registers, with representative parameters.
    const routes: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'GET', path: '/api/workspace' },
      { method: 'GET', path: '/api/themes' },
      { method: 'GET', path: '/api/themes/work' },
      { method: 'GET', path: '/api/decisions' },
      { method: 'GET', path: '/api/memories' },
      { method: 'GET', path: '/api/searches' },
      { method: 'GET', path: '/api/searches/search-abcdef123456' },
      { method: 'GET', path: '/api/refined-turn/session_x/0' },
      { method: 'GET', path: '/api/folders' },
      { method: 'GET', path: '/api/memory/memory/anything' },
      { method: 'POST', path: '/api/memory/memory/anything', body: { content: 'hi' } },
      { method: 'POST', path: '/api/restore', body: { folder: 'memory', key: 'anything' } },
      { method: 'POST', path: '/api/folders', body: { folder: 'memory/newone' } },
      {
        method: 'POST',
        path: '/api/folders/memory/rename',
        body: { newFolder: 'memory/renamed' },
      },
      { method: 'POST', path: '/api/essence', body: { content: 'essence' } },
      { method: 'POST', path: '/api/themes/work', body: { displayName: 'Work' } },
      { method: 'POST', path: '/api/sync' },
      { method: 'DELETE', path: '/api/memory/memory/anything' },
      { method: 'DELETE', path: '/api/folders/memory' },
      { method: 'DELETE', path: '/api/themes/work' },
      { method: 'DELETE', path: '/api/searches/search-abcdef123456' },
    ];

    for (const route of routes) {
      const unauth = await rawRequest({
        port,
        path: route.path,
        method: route.method,
        headers: { 'Content-Type': 'application/json' },
        body: route.body === undefined ? undefined : JSON.stringify(route.body),
      });
      assert.strictEqual(
        unauth.status,
        401,
        `${route.method} ${route.path} without a token must return 401, got ${unauth.status}`,
      );
    }

    for (const route of routes) {
      const authed = await rawRequest({
        port,
        path: route.path,
        method: route.method,
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: route.body === undefined ? undefined : JSON.stringify(route.body),
      });
      assert.notStrictEqual(
        authed.status,
        401,
        `${route.method} ${route.path} with a valid token must not be unauthorized`,
      );
    }
  } finally {
    await stop();
    cleanup();
  }
}

async function testTokenNeverLeaksInServerOutputOrFiles() {
  const { ctx, cleanup } = createTempCtx();
  const stderrChunks: string[] = [];
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stderr.write;

  let url: string;
  let stop: (() => Promise<void>) | undefined;
  try {
    const started = await startTestServer(ctx);
    url = started.url;
    stop = started.stop;

    // Exercise the surface: an authorized read, an unauthorized read and a
    // dashboard HTML request.
    const port = portOf(url);
    await rawRequest({ port, path: '/api/workspace', headers: authHeaders() });
    await rawRequest({ port, path: '/api/workspace' });
    await rawRequest({ port, path: '/' });
  } finally {
    process.stderr.write = originalStderrWrite;
    if (stop) await stop();
  }

  const allOutput = stderrChunks.join('');
  assert(
    !allOutput.includes(TEST_TOKEN),
    'the server must never print the bearer token to stderr',
  );

  // The raw test server does not write a runtime file, so the token must not
  // appear anywhere on disk at all. (The auto-start runtime file is covered
  // by its own dedicated test.)
  const tokenFiles: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          if (fs.readFileSync(fullPath, 'utf8').includes(TEST_TOKEN)) tokenFiles.push(fullPath);
        } catch {
          // Binary / unreadable files cannot hold the plain token.
        }
      }
    }
  };
  walk(ctx.storeRoot);
  assert.deepStrictEqual(
    tokenFiles,
    [],
    `the token must not be persisted outside a runtime file, found it in: ${tokenFiles.join(', ')}`,
  );
  cleanup();
}

async function testOperationalEndpoints() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    // Both operational endpoints sit behind the bearer wall.
    const healthUnauth = await fetch(`${url}/api/health`);
    assert.strictEqual(healthUnauth.status, 401);
    const metricsUnauth = await fetch(`${url}/api/metrics`);
    assert.strictEqual(metricsUnauth.status, 401);

    const healthRes = await fetch(`${url}/api/health`, { headers: authHeaders() });
    assert(healthRes.ok);
    const health = (await healthRes.json()) as { status: string; indexState: string; reasons: string[] };
    assert.strictEqual(health.status, 'ok');
    assert.strictEqual(typeof health.indexState, 'string');
    assert(Array.isArray(health.reasons));

    const metricsRes = await fetch(`${url}/api/metrics`, { headers: authHeaders() });
    assert(metricsRes.ok);
    const metricsBody = (await metricsRes.json()) as {
      uptimeMs: number;
      counters: Record<string, number>;
      gauges: Record<string, number>;
      timings: Record<string, unknown>;
    };
    assert(typeof metricsBody.uptimeMs === 'number' && metricsBody.uptimeMs >= 0);
    assert(typeof metricsBody.counters === 'object');
    assert(typeof metricsBody.timings === 'object');
    // Content-free guarantee: no metric may carry a value that looks like a
    // memory body or a query.
    const serialized = JSON.stringify(metricsBody);
    assert(!serialized.includes('content'), 'metrics must not carry content fields');
  } finally {
    await stop();
    cleanup();
  }
}

const tests = [
  testUnauthenticatedRequestsAreRejected,
  testOperationalEndpoints,
  testEveryApiRouteRequiresAuth,
  testTokenNeverLeaksInServerOutputOrFiles,
  testMaliciousOriginIsRejected,
  testHostHeaderValidation,
  testRequestBodyLimit,
  testWriteRequestsRequireJson,
  testPathTraversalIsRejected,
  testSecurityHeadersAndHealthCheck,
  testTokenNeverLeaks,
  testNonLoopbackListenerIsRefused,
  testRuntimeFileIsPrivate,
  testMarkdownUrlWhitelist,
  testFrontendBootstrapFragment,
  testFrontendKeepsRoutingHash,
];

export async function runVisSecurityTests(): Promise<void> {
  for (const test of tests) {
    await test();
    console.log(`✓ ${test.name}`);
  }
}

async function main() {
  try {
    await runVisSecurityTests();
    console.log('\nVis security tests passed.');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nVis security test failed: ${message}`);
    console.error(err instanceof Error ? err.stack : '');
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectRun) {
  void main();
}
