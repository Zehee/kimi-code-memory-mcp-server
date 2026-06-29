/**
 * Integration tests for the vis dashboard HTTP server.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import type { AddressInfo } from 'net';
import { IndexDao } from '../src/dao/index.js';
import { MemoryStore } from '../src/dao/memory-store.js';
import { ThemeManager } from '../src/theme-manager.js';
import { RefinedManager } from '../src/refined-manager.js';
import { createApp } from '../src/vis/server.js';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { Ctx } from '../src/types.js';

function createTempCtx(): { ctx: Ctx; cleanup: () => void } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-memory-vis-test-'));
  const cwd = tmpRoot.replace(/\\/g, '/');
  const workspaceId = `workspace-vis-test-${Date.now()}`;
  const storeRoot = path.join(tmpRoot, 'store');

  for (const dir of ['memory', 'notes', 'essence', 'themes', 'refined']) {
    fs.mkdirSync(path.join(storeRoot, dir), { recursive: true });
  }

  const indexDao = new IndexDao(storeRoot);
  const memoryStore = new MemoryStore(storeRoot);
  const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
  const refinedManager = new RefinedManager(path.join(storeRoot, 'refined'));

  const ctx: Ctx = {
    cwd,
    workspaceId,
    storeRoot,
    indexDao,
    memoryStore,
    themeManager,
    refinedManager,
  };

  return {
    ctx,
    cleanup: () => {
      refinedManager.close();
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows may briefly lock files.
      }
    },
  };
}

async function startTestServer(ctx: Ctx): Promise<{ server: ServerType; url: string; stop: () => void }> {
  const app = createApp(ctx);
  const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });

  await new Promise<void>((resolve) => {
    server.once('listening', resolve);
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    server,
    url,
    stop: () => {
      ctx.refinedManager.close();
      server.close();
    },
  };
}

async function testWorkspaceEndpoint() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const res = await fetch(`${url}/api/workspace`);
    assert(res.ok, `workspace endpoint failed: ${res.status}`);
    const data = (await res.json()) as {
      id: string;
      cwd: string;
      storePath: string;
      essence: string;
      stats: Record<string, number>;
    };
    assert.strictEqual(data.id, ctx.workspaceId);
    assert.strictEqual(data.cwd, ctx.cwd);
    assert.strictEqual(data.storePath, ctx.storeRoot);
    assert(typeof data.essence === 'string');
    assert(typeof data.stats.memories === 'number');
    assert(typeof data.stats.themes === 'number');
    assert(typeof data.stats.refinedTurns === 'number');
    assert(typeof data.stats.sessions === 'number');
  } finally {
    stop();
    cleanup();
  }
}

async function testThemesEndpoint() {
  const { ctx, cleanup } = createTempCtx();
  await ctx.themeManager.addThemeAssociation('my-theme', {
    memoryKey: 'sample',
    folder: 'memory/knowledge',
    title: 'Sample Memory',
  });

  const { url, stop } = await startTestServer(ctx);
  try {
    const res = await fetch(`${url}/api/themes`);
    assert(res.ok, `themes endpoint failed: ${res.status}`);
    const data = (await res.json()) as Array<{ name: string; displayName: string; turnCount: number; memoryCount: number }>;
    assert(Array.isArray(data));
    assert.strictEqual(data.length, 1);
    assert.strictEqual(data[0].name, 'my-theme');
    assert.strictEqual(data[0].memoryCount, 1);
  } finally {
    stop();
    cleanup();
  }
}

async function testSaveEssenceAndReadBack() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const saveRes = await fetch(`${url}/api/essence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: '# Essence\n\nTest content.' }),
    });
    assert(saveRes.ok, `save essence failed: ${saveRes.status}`);

    const workspaceRes = await fetch(`${url}/api/workspace`);
    const workspace = (await workspaceRes.json()) as { essence: string };
    assert(workspace.essence.includes('Test content'));
  } finally {
    stop();
    cleanup();
  }
}

async function testStaticFallback() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const res = await fetch(`${url}/`);
    assert(res.ok, `static fallback failed: ${res.status}`);
    const text = await res.text();
    assert(text.includes('<!doctype html>') && text.includes('Memory Vis'));
  } finally {
    stop();
    cleanup();
  }
}

const tests = [testWorkspaceEndpoint, testThemesEndpoint, testSaveEssenceAndReadBack, testStaticFallback];

async function main() {
  try {
    for (const test of tests) {
      await test();
      console.log(`✓ ${test.name}`);
    }
    console.log('\nVis tests passed.');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nVis test failed: ${message}`);
    console.error(err instanceof Error ? err.stack : '');
    process.exitCode = 1;
  }
}

main();
