process.env.KIMI_MEMORY_AUTO_VIS = '0';

/**
 * Integration tests for the vis dashboard HTTP server.
 *
 * Every /api/* route requires a bearer token; the tests use an explicit
 * token so the behaviour is deterministic.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import assert from 'assert';
import { fileURLToPath } from 'url';
import type { AddressInfo } from 'net';
import { IndexDao } from '../src/dao/index.js';
import { MemoryStore } from '../src/dao/memory-store.js';
import { ThemeManager } from '../src/theme-manager.js';
import { RefinedManager } from '../src/refined-manager.js';
import { WorkspaceJournal } from '../src/utils/workspace-journal.js';
import { WorkspaceLock, workspaceLockRoot } from '../src/utils/workspace-lock.js';
import { parseFrontmatter, stringifyFrontmatter } from '../src/utils/frontmatter.js';
import { startVisServer } from '../src/vis/server.js';
import {
  maybeStartVisServer,
  stopVisServer,
  getVisUrl,
  ensureVisServer,
  refreshVisRuntimeRecordUnderClaimLock,
  startStandaloneVisServer,
} from '../src/vis/auto-start.js';
import {
  VIS_RUNTIME_SCHEMA_VERSION,
  getVisRuntimeFilePath,
  writeVisRuntimeFile,
} from '../src/vis/security.js';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';
import type { Ctx } from '../src/types.js';

const __filename = fileURLToPath(import.meta.url);

export const TEST_TOKEN = 'test-token-0123456789abcdef';

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${TEST_TOKEN}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

function cleanupTempDirectories() {
  const prefix = 'kimi-memory-vis-test-';
  for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(os.tmpdir(), entry.name), {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {
      // Ignore Windows lock cleanup issues.
    }
  }
}

cleanupTempDirectories();

export function createTempCtx(): { ctx: Ctx; cleanup: () => void } {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-memory-vis-test-'));
  const cwd = tmpRoot.replace(/\\/g, '/');
  const workspaceId = `workspace-vis-test-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
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
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        // Windows may briefly lock files.
      }
    },
  };
}

export interface TestServer {
  server: ServerType;
  url: string;
  token: string;
  stop: () => Promise<void>;
}

export async function startTestServer(ctx: Ctx, token: string = TEST_TOKEN): Promise<TestServer> {
  const server = startVisServer({
    ctx,
    port: 0,
    hostname: '127.0.0.1',
    authToken: token,
  });

  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });

  const address = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${address.port}`;

  return {
    server,
    url,
    token,
    stop: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      ctx.refinedManager.close();
    },
  };
}

async function testWorkspaceEndpoint() {
  const { ctx, cleanup } = createTempCtx();
  const sessionsRoot = path.join(ctx.cwd, 'sessions');
  fs.mkdirSync(path.join(sessionsRoot, 'wd_unrelated_000000000000'), { recursive: true });
  const previousSessionsRoot = process.env.MEMORY_SESSIONS_ROOT;
  process.env.MEMORY_SESSIONS_ROOT = sessionsRoot;
  const { url, stop } = await startTestServer(ctx);
  try {
    const res = await fetch(`${url}/api/workspace`, { headers: authHeaders() });
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
    assert.strictEqual(data.stats.sessions, 0, 'other workspace directories are not current sessions');
  } finally {
    await stop();
    if (previousSessionsRoot === undefined) delete process.env.MEMORY_SESSIONS_ROOT;
    else process.env.MEMORY_SESSIONS_ROOT = previousSessionsRoot;
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
  fs.writeFileSync(
    path.join(ctx.storeRoot, 'themes', 'zz-malformed.json'),
    JSON.stringify({ theme: 'zz-malformed', turns: [], memories: 'broken' }),
    'utf8',
  );

  const { url, stop } = await startTestServer(ctx);
  try {
    const res = await fetch(`${url}/api/themes`, { headers: authHeaders() });
    assert(res.ok, `themes endpoint failed: ${res.status}`);
    const data = (await res.json()) as Array<{
      name: string;
      displayName: string;
      turnCount: number;
      memoryCount: number;
    }>;
    assert(Array.isArray(data));
    assert.strictEqual(data.length, 2, 'one corrupt theme must not hide healthy themes');
    assert.strictEqual(data[0].name, 'my-theme');
    assert.strictEqual(data[0].memoryCount, 1);
    assert.strictEqual(data[1].name, 'zz-malformed');
    assert.strictEqual((data[1] as { corrupt?: boolean }).corrupt, true);
  } finally {
    await stop();
    cleanup();
  }
}

async function testSaveEssenceAndReadBack() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const original = '# Essence\n\nTest content.';
    const saveRes = await fetch(`${url}/api/essence`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ content: original }),
    });
    assert(saveRes.ok, `save essence failed: ${saveRes.status}`);

    const essencePath = path.join(ctx.storeRoot, 'essence', 'essence.md');
    const firstParsed = parseFrontmatter(fs.readFileSync(essencePath, 'utf8'));
    assert(firstParsed);
    fs.writeFileSync(
      essencePath,
      stringifyFrontmatter({ ...firstParsed.frontmatter, sources: ['memory/decisions/auth.md'] }) +
        firstParsed.body,
      'utf8',
    );

    const workspaceRes = await fetch(`${url}/api/workspace`, { headers: authHeaders() });
    const workspace = (await workspaceRes.json()) as { essence: string; essenceRevision: number };
    assert.strictEqual(workspace.essence, original, 'the API exposes only the Markdown body');
    assert.strictEqual(workspace.essenceRevision, 1);

    const edited = `${original}\n\nEdited in the dashboard.`;
    const secondSave = await fetch(`${url}/api/essence`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ content: edited, expectedRevision: workspace.essenceRevision }),
    });
    assert(secondSave.ok, `second save failed: ${secondSave.status}`);
    const secondResult = (await secondSave.json()) as { revision: number };
    assert.strictEqual(secondResult.revision, 2);
    const secondParsed = parseFrontmatter(fs.readFileSync(essencePath, 'utf8'));
    assert.strictEqual(secondParsed?.body, edited, 'saving the API value does not nest frontmatter');
    assert.deepStrictEqual(
      secondParsed?.frontmatter.sources,
      ['memory/decisions/auth.md'],
      'dashboard edits preserve source provenance',
    );

    const staleSave = await fetch(`${url}/api/essence`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ content: 'stale overwrite', expectedRevision: 1 }),
    });
    assert.strictEqual(staleSave.status, 409, 'a stale editor receives a visible conflict');
    assert.strictEqual(parseFrontmatter(fs.readFileSync(essencePath, 'utf8'))?.body, edited);

    let revision = secondResult.revision;
    for (let i = 0; i < 11; i++) {
      const res = await fetch(`${url}/api/essence`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ content: `${edited}\n\nhistory ${i}`, expectedRevision: revision }),
      });
      assert(res.ok, `history save ${i} failed: ${res.status}`);
      revision = ((await res.json()) as { revision: number }).revision;
    }
    const history = fs.readdirSync(path.join(ctx.storeRoot, 'essence', 'history'));
    assert.strictEqual(history.filter((name) => name.endsWith('.md')).length, 10, 'dashboard history is pruned to the newest ten');
  } finally {
    await stop();
    cleanup();
  }
}

async function testEssenceRollbackEndpoint() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const save = async (content: string): Promise<void> => {
      const res = await fetch(`${url}/api/essence`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ content }),
      });
      assert(res.ok, `save essence failed: ${res.status}`);
    };
    await save('# Essence v1\n\noriginal body');
    await save('# Essence v2\n\nreorganized body');

    const rollbackRes = await fetch(`${url}/api/essence/rollback`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ revision: 1 }),
    });
    assert(rollbackRes.ok, `rollback failed: ${rollbackRes.status}`);
    const rolled = (await rollbackRes.json()) as {
      success: boolean;
      restoredFrom: number;
      toRevision: number;
    };
    assert.strictEqual(rolled.success, true);
    assert.strictEqual(rolled.restoredFrom, 1);
    assert.strictEqual(rolled.toRevision, 3, 'the rollback bumps the revision');

    const essenceOnDisk = fs.readFileSync(path.join(ctx.storeRoot, 'essence', 'essence.md'), 'utf8');
    assert(essenceOnDisk.includes('original body'), 'the v1 body is restored');

    // Rollback with no arguments targets the newest archive.
    const defaultRollback = await fetch(`${url}/api/essence/rollback`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({}),
    });
    const rolledBack = (await defaultRollback.json()) as { success: boolean };
    assert.strictEqual(rolledBack.success, true);
  } finally {
    await stop();
    cleanup();
  }
}

async function testSyncRecoversJournal() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    // A prepared entry left behind by a crashed writer.
    const journal = new WorkspaceJournal(ctx.storeRoot);
    journal.prepare('remember', { targetPath: 'memory/from-crash.md' });
    assert.strictEqual(journal.list().length, 1);

    const syncRes = await fetch(`${url}/api/sync`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert(syncRes.ok, `sync failed: ${syncRes.status}`);
    const synced = (await syncRes.json()) as {
      journalRecovered: Array<{ op: string }>;
      journalFailed: unknown[];
      indexState: string;
    };
    assert.strictEqual(synced.journalRecovered.length, 1, 'the sync reconciles the journal');
    assert.strictEqual(synced.journalRecovered[0].op, 'remember');
    assert.strictEqual(synced.journalFailed.length, 0);
    assert.strictEqual(synced.indexState, 'fresh');
    assert.strictEqual(journal.list().length, 0, 'the journal is clean after the sync');
  } finally {
    await stop();
    cleanup();
  }
}

async function testSyncKeepsJournalWhenReconcileFails() {
  // HTTP-path twin of review round 6 #2: when the reconcile reports
  // `synced: false` (here: duplicate ids poison it), the sync must KEEP the
  // prepared journal entries instead of dropping the only recovery clue.
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    // Two files sharing one stable id poison the reconcile.
    const write = await fetch(`${url}/api/memory/memory/seed`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ content: 'seed body', title: 'Seed' }),
    });
    assert(write.ok);
    const rawSeed = fs.readFileSync(path.join(ctx.storeRoot, 'memory', 'seed.md'), 'utf8');
    fs.mkdirSync(path.join(ctx.storeRoot, 'memory', 'dup'), { recursive: true });
    fs.writeFileSync(
      path.join(ctx.storeRoot, 'memory', 'dup', 'seed.md'),
      rawSeed,
      'utf8',
    );

    const journal = new WorkspaceJournal(ctx.storeRoot);
    journal.prepare('move', { targetPath: 'memory/x/moved.md', sourcePath: 'memory/x/moved.md' });
    // The HTTP seed write also left a committed entry behind.
    const preparedBefore = journal.list().filter((e) => e.state === 'prepared').length;
    assert.strictEqual(preparedBefore, 1);

    const syncRes = await fetch(`${url}/api/sync`, {
      method: 'POST',
      headers: authHeaders(),
    });
    assert(syncRes.ok);
    const synced = (await syncRes.json()) as {
      synced?: boolean;
      journalRecovered: unknown[];
      journalFailed: Array<{ reason: string }>;
    };
    assert.strictEqual(synced.synced, false, 'the duplicate poison makes the sync report failure');
    assert.strictEqual(synced.journalRecovered.length, 0, 'nothing is reported recovered');
    assert.strictEqual(synced.journalFailed.length, 1, 'the entry is reported failed');
    assert(/synced: false/.test(synced.journalFailed[0].reason), 'the failure names the reconcile');
    const preparedAfter = journal.list().filter((e) => e.state === 'prepared').length;
    assert.strictEqual(preparedAfter, 1, 'the recovery clue stays on disk');
  } finally {
    await stop();
    cleanup();
  }
}

async function testThemeTimelineRespectsReferenceState() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    // Memory A, referenced by a theme.
    const writeA = await fetch(`${url}/api/memory/memory/note-a`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ content: 'memory A body', title: 'Note A', tags: ['x'] }),
    });
    assert(writeA.ok);
    const infoA = (await writeA.json()) as { id: string; revision: number };
    // Associations are created through the theme manager (the dashboard has
    // no add-memory endpoint; it renders the association).
    await ctx.themeManager.addThemeAssociation('review', {
      memoryKey: 'note-a',
      folder: 'memory',
      title: 'Note A',
      memoryId: infoA.id,
      revision: infoA.revision,
    });

    // Delete A, then create an unrelated memory B at the same path.
    const del = await fetch(`${url}/api/memory/memory/note-a`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    assert(del.ok);
    const writeB = await fetch(`${url}/api/memory/memory/note-a`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ content: 'memory B body', title: 'Note B' }),
    });
    assert(writeB.ok);

    const timelineRes = await fetch(`${url}/api/themes/review`, { headers: authHeaders() });
    assert(timelineRes.ok);
    const timeline = (await timelineRes.json()) as {
      items: Array<{ type: string; data: Record<string, unknown> }>;
    };
    const memoryItems = timeline.items.filter((i) => i.type === 'memory');
    assert(memoryItems.length === 1, 'the deleted reference still appears once');
    const data = memoryItems[0].data as { missing?: boolean; status?: string; content?: string };
    assert.strictEqual(data.missing, true, 'the deleted reference does not render new content');
    assert(
      !String(data.content).includes('memory B body'),
      'the reused path must not leak memory B into the old reference',
    );
  } finally {
    await stop();
    cleanup();
  }
}

async function testRecursiveFolderDeleteSoftDeletes() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    for (const key of ['one', 'two']) {
      const res = await fetch(`${url}/api/memory/memory/bulk/${key}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ content: `${key} body`, title: key }),
      });
      assert(res.ok, `create memory/bulk/${key} failed: ${res.status}`);
    }
    // A non-memory file in the folder must survive the recursive delete.
    const attachment = path.join(ctx.storeRoot, 'memory', 'bulk', 'notes.txt');
    fs.writeFileSync(attachment, 'user attachment', 'utf8');

    const del = await fetch(`${url}/api/folders/memory/bulk?recursive=true`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    assert(del.ok, `recursive delete failed: ${del.status}`);
    const result = (await del.json()) as { ok: boolean; deleted?: number };
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.deleted, 2, 'both memories were soft deleted');

    // The trash holds both copies and the folder (with its non-memory file)
    // survives.
    const store = ctx.memoryStore;
    const trash = store.listTrash();
    const trashKeys = trash.map((entry) => entry.key).sort();
    assert.deepStrictEqual(trashKeys, ['one', 'two'], 'both entries are restorable');
    assert(!fs.existsSync(path.join(ctx.storeRoot, 'memory', 'bulk', 'one.md')), 'the memory files are gone');
    assert.strictEqual(
      fs.readFileSync(attachment, 'utf8'),
      'user attachment',
      'non-memory files are never destroyed by a recursive delete',
    );

    // A restore works after the recursive delete (dedicated endpoint — the
    // `/restore`-suffix variant was ambiguous with the write route).
    const restoreRes = await fetch(`${url}/api/restore`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ folder: 'memory/bulk', key: 'one' }),
    });
    assert(restoreRes.ok, `restore failed: ${restoreRes.status}`);
    const restored = (await restoreRes.json()) as { ok: boolean };
    assert.strictEqual(restored.ok, true);
  } finally {
    await stop();
    cleanup();
  }
}

async function testEssenceSaveWritesJournal() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const save = await fetch(`${url}/api/essence`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ content: '# Essence\n\njournaled save' }),
    });
    assert(save.ok, `save failed: ${save.status}`);

    // The dashboard save is journaled like every other write: a committed
    // entry exists until the next recovery pass drops it (review R-08).
    const journal = new WorkspaceJournal(ctx.storeRoot);
    const entries = journal.list();
    assert.strictEqual(entries.length, 1, 'one journal entry after the save');
    assert.strictEqual(entries[0].state, 'committed');
    assert.strictEqual(entries[0].targetPath, 'essence/essence.md');
  } finally {
    await stop();
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
    assert(text.includes('<!doctype html>') && text.includes('Kimi Memory'));
  } finally {
    await stop();
    cleanup();
  }
}

async function testFolderEndpoints() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const listRes = await fetch(`${url}/api/folders`, { headers: authHeaders() });
    assert(listRes.ok, `list folders failed: ${listRes.status}`);
    const folders = (await listRes.json()) as string[];
    assert(folders.includes('memory') && folders.includes('notes'));

    const createRes = await fetch(`${url}/api/folders`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ folder: 'memory/decisions' }),
    });
    assert(createRes.ok, `create folder failed: ${createRes.status}`);

    const list2 = (await (
      await fetch(`${url}/api/folders`, { headers: authHeaders() })
    ).json()) as string[];
    assert(list2.includes('memory/decisions'));

    const written = ctx.memoryStore.writeWithResult(
      'memory/decisions',
      'folder-reference',
      'folder reference body',
    );
    await ctx.themeManager.addThemeAssociation('folder-stable-reference', {
      memoryKey: written.key,
      folder: 'memory/decisions',
      memoryId: written.id,
      revision: written.revision,
      contentHash: written.contentHash,
    });
    await ctx.themeManager.addThemeAssociation('folder-legacy-reference', {
      memoryKey: written.key,
      folder: 'memory/decisions',
    });

    const renameRes = await fetch(
      `${url}/api/folders/${encodeURIComponent('memory/decisions')}/rename`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ newFolder: 'memory/choices' }),
      },
    );
    assert(renameRes.ok, `rename folder failed: ${renameRes.status}`);

    const list3 = (await (
      await fetch(`${url}/api/folders`, { headers: authHeaders() })
    ).json()) as string[];
    assert(list3.includes('memory/choices'));
    for (const themeName of ['folder-stable-reference', 'folder-legacy-reference']) {
      const ref = ctx.themeManager.loadTheme(themeName)?.memories[0];
      assert.strictEqual(ref?.folder, 'memory/choices', `${themeName} follows the folder rename`);
      assert.strictEqual(ref?.key, written.key);
    }

    const deleteRes = await fetch(
      `${url}/api/folders/${encodeURIComponent('memory/choices')}?recursive=true`,
      {
        method: 'DELETE',
        headers: authHeaders(),
      },
    );
    assert(deleteRes.ok, `delete folder failed: ${deleteRes.status}`);

    const list4 = (await (
      await fetch(`${url}/api/folders`, { headers: authHeaders() })
    ).json()) as string[];
    assert(!list4.includes('memory/choices'));
    for (const themeName of ['folder-stable-reference', 'folder-legacy-reference']) {
      const ref = ctx.themeManager.loadTheme(themeName)?.memories[0];
      assert.strictEqual(ref?.folder, 'memory/choices');
      assert.strictEqual(ref?.status, 'deleted', `${themeName} survives reconcile as deleted`);
    }
  } finally {
    await stop();
    cleanup();
  }
}

async function testMemoryCrudEndpoints() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx);
  try {
    const writeRes = await fetch(
      `${url}/api/memory/${encodeURIComponent('memory/knowledge')}/${encodeURIComponent('test-item')}`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ content: 'Body content', title: 'Test Item', tags: ['knowledge'] }),
      },
    );
    assert(writeRes.ok, `write memory failed: ${writeRes.status}`);

    const readRes = await fetch(
      `${url}/api/memory/${encodeURIComponent('memory/knowledge')}/${encodeURIComponent('test-item')}`,
      {
        headers: authHeaders(),
      },
    );
    assert(readRes.ok, `read memory failed: ${readRes.status}`);
    const data = (await readRes.json()) as {
      content: string;
      title: string;
      tags: string[];
      id: string;
      revision: number;
      contentHash: string;
    };
    assert.strictEqual(data.title, 'Test Item');
    assert.strictEqual(data.content, 'Body content');
    assert(data.tags.includes('knowledge'));
    assert(data.id && data.contentHash);
    assert(Number.isInteger(data.revision));

    const conflictRes = await fetch(
      `${url}/api/memory/${encodeURIComponent('memory/knowledge')}/${encodeURIComponent('test-item')}`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          content: 'stale overwrite',
          expectedRevision: data.revision + 1,
          expectedContentHash: data.contentHash,
        }),
      },
    );
    assert.strictEqual(conflictRes.status, 409, 'a stale revision must be rejected');

    const updateRes = await fetch(
      `${url}/api/memory/${encodeURIComponent('memory/knowledge')}/${encodeURIComponent('test-item')}`,
      {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          content: 'Updated body',
          tags: [],
          expectedRevision: data.revision,
          expectedContentHash: data.contentHash,
        }),
      },
    );
    assert(updateRes.ok, `valid CAS update failed: ${updateRes.status}`);
    const updated = (await updateRes.json()) as { revision: number; contentHash: string };
    assert(updated.revision > data.revision);

    const readUpdated = await fetch(
      `${url}/api/memory/${encodeURIComponent('memory/knowledge')}/${encodeURIComponent('test-item')}`,
      {
        headers: authHeaders(),
      },
    );
    const updatedData = (await readUpdated.json()) as { content: string; tags: string[] };
    assert.strictEqual(updatedData.content, 'Updated body');
    assert.deepStrictEqual(updatedData.tags, [], 'an explicit empty tag list clears tags');

    const deleteRes = await fetch(
      `${url}/api/memory/${encodeURIComponent('memory/knowledge')}/${encodeURIComponent('test-item')}`,
      {
        method: 'DELETE',
        headers: authHeaders(),
      },
    );
    assert(deleteRes.ok, `delete memory failed: ${deleteRes.status}`);

    const read2 = await fetch(
      `${url}/api/memory/${encodeURIComponent('memory/knowledge')}/${encodeURIComponent('test-item')}`,
      {
        headers: authHeaders(),
      },
    );
    assert.strictEqual(read2.status, 404);
  } finally {
    await stop();
    cleanup();
  }
}

export async function findFreePort(): Promise<number> {
  const probe = serve({ fetch: () => new Response('ok'), port: 0, hostname: '127.0.0.1' });
  await new Promise<void>((resolve) => probe.once('listening', () => resolve()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

async function withAutoVisEnv(port: number, fn: () => Promise<void>): Promise<void> {
  const prevFlag = process.env.KIMI_MEMORY_AUTO_VIS;
  const prevPort = process.env.KIMI_MEMORY_VIS_PORT;
  process.env.KIMI_MEMORY_AUTO_VIS = '1';
  process.env.KIMI_MEMORY_VIS_PORT = String(port);
  try {
    await fn();
  } finally {
    stopVisServer();
    if (prevFlag === undefined) delete process.env.KIMI_MEMORY_AUTO_VIS;
    else process.env.KIMI_MEMORY_AUTO_VIS = prevFlag;
    if (prevPort === undefined) delete process.env.KIMI_MEMORY_VIS_PORT;
    else process.env.KIMI_MEMORY_VIS_PORT = prevPort;
  }
}

async function testAutoStartDisabledByDefault() {
  const { ctx, cleanup } = createTempCtx();
  const prevFlag = process.env.KIMI_MEMORY_AUTO_VIS;
  delete process.env.KIMI_MEMORY_AUTO_VIS;
  try {
    const result = await maybeStartVisServer(ctx);
    assert.strictEqual(result.started, false, 'the dashboard must not start automatically');
    assert.strictEqual(result.url, undefined);
    assert.strictEqual(getVisUrl(), null);
  } finally {
    stopVisServer();
    if (prevFlag !== undefined) process.env.KIMI_MEMORY_AUTO_VIS = prevFlag;
    cleanup();
  }
}

async function testAutoStartOwnsInstanceAndCleansUp() {
  const { ctx, cleanup } = createTempCtx();
  const port = await findFreePort();
  try {
    await withAutoVisEnv(port, async () => {
      const result = await maybeStartVisServer(ctx);
      assert.strictEqual(result.started, true);
      assert.strictEqual(result.reused, false);
      assert(result.url, 'a dashboard url is required');
      assert(result.browserUrl, 'a browser url is required');

      // The plain url never carries the token, the browser url carries it in
      // the fragment only.
      assert(!result.url.includes('#'), 'the plain url must not contain a fragment');
      assert(!result.url.includes('bootstrap'), 'the plain url must not contain the token');
      assert(
        result.browserUrl.startsWith(`${result.url}#bootstrap=`),
        'the token must travel in the fragment',
      );
      assert.strictEqual(getVisUrl(), result.url);
      assert(!String(getVisUrl()).includes('bootstrap'));

      // The runtime file describes the owner.
      const runtimePath = getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId);
      const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as {
        schemaVersion: number;
        workspaceId: string;
        url: string;
        pid: number;
        token: string;
        createdAt: string;
        heartbeatAt: string;
        lease: { ownerPid: number; expiresAt: string };
      };
      assert.strictEqual(runtime.schemaVersion, VIS_RUNTIME_SCHEMA_VERSION);
      assert.strictEqual(runtime.workspaceId, ctx.workspaceId);
      assert.strictEqual(runtime.url, result.url);
      assert.strictEqual(runtime.pid, process.pid);
      assert(
        runtime.token.length >= 64,
        'the runtime token must have at least 32 bytes of entropy',
      );
      assert(runtime.createdAt);
      assert(runtime.heartbeatAt);
      assert.strictEqual(runtime.lease.ownerPid, process.pid);
      assert(Date.parse(runtime.lease.expiresAt) > Date.now());

      // The owner serves authenticated requests only.
      const unauthorized = await fetch(`${result.url}/api/workspace`);
      assert.strictEqual(unauthorized.status, 401);

      const authorized = await fetch(`${result.url}/api/workspace`, {
        headers: { Authorization: `Bearer ${runtime.token}` },
      });
      assert(authorized.ok, 'the owner token must authenticate');

      // Stopping releases the port and removes the runtime file.
      stopVisServer();
      assert.strictEqual(getVisUrl(), null);
      assert(!fs.existsSync(runtimePath), 'the runtime file of an owned instance must be removed');
    });
  } finally {
    cleanup();
  }
}

async function testAutoStartReusesRunningInstance() {
  const { ctx, cleanup } = createTempCtx();
  const { url, stop } = await startTestServer(ctx, 'owner-token-0123456789abcdef');
  const runtimePath = getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId);
  const port = Number(new URL(url).port);
  writeVisRuntimeFile(runtimePath, {
    schemaVersion: VIS_RUNTIME_SCHEMA_VERSION,
    workspaceId: ctx.workspaceId,
    url,
    hostname: '127.0.0.1',
    port,
    pid: process.pid,
    token: 'owner-token-0123456789abcdef',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    lease: {
      ownerPid: process.pid,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });

  try {
    await withAutoVisEnv(port, async () => {
      const result = await maybeStartVisServer(ctx);
      assert.strictEqual(result.started, true);
      assert.strictEqual(result.reused, true, 'a live instance must be reused');
      assert.strictEqual(result.url, url);
      assert(
        result.browserUrl?.includes('#bootstrap='),
        'the reused instance needs a bootstrap url',
      );
      assert.strictEqual(getVisUrl(), url);

      // A reused dashboard belongs to another process: stopping our own
      // auto-start state must not take it down nor remove its runtime file.
      stopVisServer();
      assert(fs.existsSync(runtimePath), 'a reused runtime file must not be removed');
      const res = await fetch(`${url}/api/workspace`, {
        headers: { Authorization: 'Bearer owner-token-0123456789abcdef' },
      });
      assert(res.ok, 'reused dashboard was killed by stopVisServer');
    });
  } finally {
    await stop();
    cleanup();
  }
}

async function testAutoStartTakesOverStaleRuntimeFile() {
  const { ctx, cleanup } = createTempCtx();
  const runtimePath = getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId);
  writeVisRuntimeFile(runtimePath, {
    schemaVersion: VIS_RUNTIME_SCHEMA_VERSION,
    workspaceId: ctx.workspaceId,
    url: 'http://127.0.0.1:59999',
    hostname: '127.0.0.1',
    port: 59999,
    pid: 999999,
    token: 'stale-token-0123456789abcdef',
    createdAt: new Date(Date.now() - 120_000).toISOString(),
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
    heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
    lease: {
      ownerPid: 999999,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    },
  });

  const port = await findFreePort();
  try {
    await withAutoVisEnv(port, async () => {
      const result = await maybeStartVisServer(ctx);
      assert.strictEqual(result.started, true);
      assert.strictEqual(result.reused, false, 'a stale runtime file must not be reused');
      assert(result.url);
      const runtime = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as {
        pid: number;
        url: string;
      };
      assert.strictEqual(runtime.pid, process.pid);
      assert.strictEqual(runtime.url, result.url);
    });
  } finally {
    cleanup();
  }
}

async function testAutoStartDoesNotAdoptUndiscoverableInstance() {
  const { ctx, cleanup } = createTempCtx();
  // An instance we know nothing about (no runtime file): we have no token for
  // it, so it must never be adopted.
  const { url, stop } = await startTestServer(ctx, 'legacy-token-0123456789abc');
  const port = Number(new URL(url).port);
  try {
    await withAutoVisEnv(port, async () => {
      const result = await maybeStartVisServer(ctx);
      assert.strictEqual(result.started, true);
      assert.strictEqual(
        result.reused,
        false,
        'an instance without a runtime file must not be reused',
      );
      assert(result.url !== url, 'an undiscoverable instance must not be adopted');
    });
  } finally {
    await stop();
    cleanup();
  }
}

async function testAutoStartConcurrentSameWorkspace() {
  const { ctx, cleanup } = createTempCtx();
  const basePort = await findFreePort();
  try {
    await withAutoVisEnv(basePort, async () => {
      const [r1, r2] = await Promise.all([maybeStartVisServer(ctx), maybeStartVisServer(ctx)]);
      assert.strictEqual(r1.started, true);
      assert.strictEqual(r2.started, true);
      assert.strictEqual(r1.url, r2.url, 'concurrent starts must converge on one dashboard');

      const res = await fetch(`${r1.url}/api/workspace`, {
        headers: { Authorization: `Bearer ${(r1.browserUrl ?? '').split('#bootstrap=')[1] ?? ''}` },
      });
      assert(res.ok, 'the dashboard must accept the token of the owning process');
    });
  } finally {
    cleanup();
  }
}

async function testEnsureVisServerRestartsDeadInstance() {
  const { ctx, cleanup } = createTempCtx();
  const { url, server } = await startTestServer(ctx, 'owner-token-0123456789abcdef');
  const runtimePath = getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId);
  writeVisRuntimeFile(runtimePath, {
    schemaVersion: VIS_RUNTIME_SCHEMA_VERSION,
    workspaceId: ctx.workspaceId,
    url,
    hostname: '127.0.0.1',
    port: Number(new URL(url).port),
    pid: process.pid,
    token: 'owner-token-0123456789abcdef',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    lease: {
      ownerPid: process.pid,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    },
  });

  const port = Number(new URL(url).port);
  try {
    await withAutoVisEnv(port, async () => {
      const first = await ensureVisServer(ctx);
      assert.strictEqual(first.started, true);
      assert.strictEqual(first.reused, true, 'the published instance must be reused');

      // The owner dies but the runtime file still claims a live lease: the
      // reuse side must not trust the cached URL forever.
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const second = await ensureVisServer(ctx);
      assert.strictEqual(second.started, true);
      assert.strictEqual(second.reused, false, 'a dead instance must not be reused');
      assert(second.url, 'the dashboard must be restarted');
      const res = await fetch(`${second.url}/api/workspace`, {
        headers: {
          Authorization: `Bearer ${(second.browserUrl ?? '').split('#bootstrap=')[1] ?? ''}`,
        },
      });
      assert(res.ok, 'the restarted dashboard must accept its own token');
      const withDeadToken = await fetch(`${second.url}/api/workspace`, {
        headers: { Authorization: 'Bearer owner-token-0123456789abcdef' },
      });
      assert.strictEqual(withDeadToken.status, 401, 'the token of the dead instance must not work');
    });
  } finally {
    cleanup();
  }
}

async function testStandaloneSingletonAndOwnership() {
  const { ctx, cleanup } = createTempCtx();
  const portA = await findFreePort();
  let portB = await findFreePort();
  if (portB === portA) portB += 1;
  try {
    // First standalone instance claims the workspace.
    const first = await startStandaloneVisServer(ctx, { port: portA });
    assert.strictEqual(first.url, `http://127.0.0.1:${portA}`);

    // A second standalone instance must refuse while the first is live —
    // it must NOT overwrite the discovery record (review repro).
    let secondError: Error | null = null;
    try {
      await startStandaloneVisServer(ctx, { port: portB });
    } catch (err) {
      secondError = err as Error;
    }
    assert(secondError, 'the second standalone instance refuses to start');
    assert(
      /already running at /.test(secondError.message),
      `the error names the running instance: ${secondError.message}`,
    );
    const afterSecond = JSON.parse(
      fs.readFileSync(getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId), 'utf8'),
    ) as { url: string };
    assert.strictEqual(afterSecond.url, first.url, 'the first instance keeps ownership');

    // Mixed mode: the auto-start path reuses the standalone instance.
    const reuse = await ensureVisServer(ctx);
    assert(reuse.started && reuse.reused, 'auto-start reuses the standalone dashboard');
    assert.strictEqual(reuse.url, first.url);

    // Closing the standalone removes the runtime only while it is still
    // ours: simulate a newer owner overwriting the record before close.
    const runtimePath = getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId);
    writeVisRuntimeFile(runtimePath, {
      schemaVersion: VIS_RUNTIME_SCHEMA_VERSION,
      workspaceId: ctx.workspaceId,
      url: `http://127.0.0.1:${portB + 1}`,
      hostname: '127.0.0.1',
      port: portB + 1,
      pid: process.pid + 100000,
      token: 'a-totally-different-token-value-0123456789abcdef',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      lease: { ownerPid: process.pid + 100000, expiresAt: new Date(Date.now() + 30_000).toISOString() },
    });
    await first.close();
    const survivor = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as { url: string };
    assert.strictEqual(
      survivor.url,
      `http://127.0.0.1:${portB + 1}`,
      'close does not delete a newer owner’s record',
    );

    // With the workspace free again, a fresh standalone instance starts.
    const third = await startStandaloneVisServer(ctx, { port: portB });
    assert.strictEqual(third.url, `http://127.0.0.1:${portB}`);
    await third.close();

    // Reset the auto-start module state (ensureVisServer above left the
    // reused instance in the singleton state, which would leak into later
    // tests that assert a clean module state).
    stopVisServer();
    cleanup();
  } catch (err) {
    stopVisServer();
    cleanup();
    throw err;
  }
}

async function testCloseUnderClaimLockSkipsDeletion() {
  // The TOCTOU repro from the re-review: a foreign record injected between
  // the ownership read and the delete. With the check+delete now atomic
  // inside the vis-runtime-claim lock, a close while the lock is held skips
  // the deletion entirely — the record survives whoever injected it.
  const { ctx, cleanup } = createTempCtx();
  const port = await findFreePort();
  const claimLock = new WorkspaceLock(workspaceLockRoot(ctx.storeRoot));
  const instance = await startStandaloneVisServer(ctx, { port });
  const runtimePath = getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId);
  try {
    await claimLock.withLock('vis-runtime-claim', async () => {
      // Simulate the interleaving: a newer owner's record appears while we
      // are shutting down.
      writeVisRuntimeFile(runtimePath, {
        schemaVersion: VIS_RUNTIME_SCHEMA_VERSION,
        workspaceId: ctx.workspaceId,
        url: 'http://127.0.0.1:1',
        hostname: '127.0.0.1',
        port: 1,
        pid: process.pid + 424242,
        token: 'foreign-token-value-0000000000000000000000',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        heartbeatAt: new Date().toISOString(),
        lease: { ownerPid: process.pid + 424242, expiresAt: new Date(Date.now() + 30_000).toISOString() },
      });

      await instance.close();
      assert(
        fs.existsSync(runtimePath),
        'close while the claim lock is held must not delete the record',
      );
    });

    // After the lock is released the record is still intact (the skip is a
    // full skip, not a delayed delete).
    assert(fs.existsSync(runtimePath), 'the surviving record is not deleted retroactively');
  } finally {
    stopVisServer();
    cleanup();
  }
}

async function testHeartbeatDoesNotClobberNewOwnerClaim() {
  // Exact review repro: the new owner's claim lands between the old
  // heartbeat's read and write. The heartbeat now runs inside the claim
  // lock and validates pid+token, so both interleavings leave the new
  // owner's record intact:
  //   ordering A — claim written before the heartbeat fires: the heartbeat
  //   sees a foreign record and skips;
  //   ordering B — heartbeat fires on the old record first: the claim
  //   (inside the lock) overwrites afterwards and wins.
  const { ctx, cleanup } = createTempCtx();
  const runtimePath = getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId);
  const lockRoot = workspaceLockRoot(ctx.storeRoot);
  const now = new Date().toISOString();
  try {
    // Ordering A: the record on disk already belongs to the new owner.
    writeVisRuntimeFile(runtimePath, {
      schemaVersion: VIS_RUNTIME_SCHEMA_VERSION,
      workspaceId: ctx.workspaceId,
      url: 'http://127.0.0.1:58002',
      hostname: '127.0.0.1',
      port: 58002,
      pid: process.pid,
      token: 'owner-b-token-0000000000000000000000',
      createdAt: now,
      updatedAt: now,
      heartbeatAt: now,
      lease: { ownerPid: process.pid, expiresAt: new Date(Date.now() + 30_000).toISOString() },
    });

    // The old owner's heartbeat fires with the old token.
    const outcome = refreshVisRuntimeRecordUnderClaimLock(
      runtimePath,
      'owner-a-token-0000000000000000000000',
      lockRoot,
    );
    assert.strictEqual(outcome, 'foreign', 'the stale heartbeat is skipped as foreign');

    const afterClaim = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as {
      url: string;
      token: string;
    };
    assert.strictEqual(afterClaim.url, 'http://127.0.0.1:58002', 'the new claim survives');
    assert.strictEqual(afterClaim.token, 'owner-b-token-0000000000000000000000');

    // Ordering B: heartbeat on the current record extends the lease…
    const before = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as { heartbeatAt: string };
    await new Promise((resolve) => setTimeout(resolve, 20));
    const refreshed = refreshVisRuntimeRecordUnderClaimLock(
      runtimePath,
      'owner-b-token-0000000000000000000000',
      lockRoot,
    );
    assert.strictEqual(refreshed, 'refreshed', 'the current owner refreshes normally');
    const afterRefresh = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as {
      heartbeatAt: string;
      url: string;
    };
    assert.notStrictEqual(afterRefresh.heartbeatAt, before.heartbeatAt, 'the lease was extended');
    assert.strictEqual(afterRefresh.url, 'http://127.0.0.1:58002');

    // …and a subsequent claim overwrites it last-writer-wins inside the
    // lock — the heartbeat never resurrects the old record.
    writeVisRuntimeFile(runtimePath, {
      schemaVersion: VIS_RUNTIME_SCHEMA_VERSION,
      workspaceId: ctx.workspaceId,
      url: 'http://127.0.0.1:58003',
      hostname: '127.0.0.1',
      port: 58003,
      pid: process.pid + 999,
      token: 'owner-c-token-0000000000000000000000',
      createdAt: now,
      updatedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      lease: { ownerPid: process.pid + 999, expiresAt: new Date(Date.now() + 30_000).toISOString() },
    });
    const stale = refreshVisRuntimeRecordUnderClaimLock(
      runtimePath,
      'owner-b-token-0000000000000000000000',
      lockRoot,
    );
    assert.strictEqual(stale, 'foreign', 'the previous owner cannot refresh owner-c’s record');
    const final = JSON.parse(fs.readFileSync(runtimePath, 'utf8')) as { url: string };
    assert.strictEqual(final.url, 'http://127.0.0.1:58003');
  } finally {
    cleanup();
  }
}

async function testCloseReleasesPortWhenLockCleanupFails() {
  // Review round 3 (P2): a lock I/O failure during close (here: `.locks`
  // replaced by a regular file) must not prevent the HTTP server from
  // being released.
  const { ctx, cleanup } = createTempCtx();
  const port = await findFreePort();
  const instance = await startStandaloneVisServer(ctx, { port });
  const lockRoot = workspaceLockRoot(ctx.storeRoot);

  // Sabotage the lock directory.
  fs.rmSync(lockRoot, { recursive: true, force: true });
  fs.writeFileSync(lockRoot, 'not a directory', 'utf8');

  try {
    // close() resolves despite the cleanup failure…
    await instance.close();

    // …the stale runtime record survives (deletion was skipped)…
    const runtimePath = getVisRuntimeFilePath(ctx.storeRoot, ctx.workspaceId);
    assert(fs.existsSync(runtimePath), 'the undeletable record is kept, not lost');

    // …and the port is released: after restoring the lock directory a fresh
    // instance can bind the same port again.
    fs.rmSync(lockRoot, { recursive: true, force: true });
    let rebound: Awaited<ReturnType<typeof startStandaloneVisServer>> | null = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 5 && !rebound; attempt++) {
      try {
        rebound = await startStandaloneVisServer(ctx, { port });
      } catch (err) {
        lastError = err;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert(rebound, `the port was released for a fresh instance: ${String(lastError)}`);
    await rebound!.close();
  } finally {
    stopVisServer();
    cleanup();
  }
}

const tests = [
  testCloseUnderClaimLockSkipsDeletion,
  testHeartbeatDoesNotClobberNewOwnerClaim,
  testCloseReleasesPortWhenLockCleanupFails,
  testStandaloneSingletonAndOwnership,
  testWorkspaceEndpoint,
  testThemesEndpoint,
  testSaveEssenceAndReadBack,
  testEssenceRollbackEndpoint,
  testSyncRecoversJournal,
  testSyncKeepsJournalWhenReconcileFails,
  testEssenceSaveWritesJournal,
  testThemeTimelineRespectsReferenceState,
  testRecursiveFolderDeleteSoftDeletes,
  testStaticFallback,
  testFolderEndpoints,
  testMemoryCrudEndpoints,
  testAutoStartDisabledByDefault,
  testAutoStartOwnsInstanceAndCleansUp,
  testAutoStartReusesRunningInstance,
  testAutoStartTakesOverStaleRuntimeFile,
  testAutoStartDoesNotAdoptUndiscoverableInstance,
  testAutoStartConcurrentSameWorkspace,
  testEnsureVisServerRestartsDeadInstance,
];

export async function runVisTests(): Promise<void> {
  for (const test of tests) {
    await test();
    console.log(`✓ ${test.name}`);
  }
}

async function main() {
  try {
    await runVisTests();
    const { runVisSecurityTests } = await import('./vis-security.test.js');
    await runVisSecurityTests();
    console.log('\nVis tests passed.');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nVis test failed: ${message}`);
    console.error(err instanceof Error ? err.stack : '');
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename);
if (isDirectRun) {
  void main();
}
