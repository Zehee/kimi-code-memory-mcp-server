/**
 * Storage contract tests: atomic writes, cross-process locking, stable memory
 * identity, optimistic concurrency, frontmatter round-trips, index freshness
 * and theme references.
 *
 * Every test works inside its own temporary directory. The tests never touch
 * the user's global memory store.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'url';
import {
  parseFrontmatter,
  stringifyFrontmatter,
  FrontmatterParseError,
} from '../src/utils/frontmatter.js';
import { atomicWriteFile, cleanupTempFiles, createTempFilePath } from '../src/utils/paths.js';
import {
  WorkspaceLock,
  WORKSPACE_LOCK_KEY,
  LockTimeoutError,
  workspaceLockRoot,
} from '../src/utils/workspace-lock.js';
import { MemoryStore, MemoryCorruptError, RevisionConflictError, hashContent } from '../src/dao/memory-store.js';
import { IndexDao } from '../src/dao/index.js';
import { IndexStore } from '../src/dao/index-store.js';
import { IndexReconciler } from '../src/dao/index-reconciler.js';
import { ThemeManager } from '../src/theme-manager.js';
import { RefinedManager } from '../src/refined-manager.js';
import { purgeDerivedData } from '../src/purge.js';
import {
  doctorReport,
  exportWorkspaceData,
  backupWorkspaceData,
  pruneByRetention,
} from '../src/maintenance.js';
import { BackgroundIndexer } from '../src/background/indexer.js';
import { refineSessionBatch } from '../src/background/refine-batch.js';
import { createMemoryTools } from '../src/tools/memory-tools.js';
import { createSystemTools } from '../src/tools/system-tools.js';
import { WorkspaceJournal } from '../src/utils/workspace-journal.js';
import { InvalidKeyError, assertValidKey, sanitizeFolder, sanitizeKey } from '../src/utils/validation.js';
import { toStorageError, errorToHttpStatus, UnsupportedVersionError, CorruptDataError } from '../src/utils/errors.js';
import { computeWorkspaceHash } from '../src/utils/paths.js';
import { findAllWorkspaceSessions, parseWireFile } from '../src/context/wire-context.js';
import type { Ctx } from '../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(__dirname, 'helpers', 'storage-worker.ts');

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function cleanup(): void {
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* ignore */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runWorker(
  storeRoot: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', WORKER, storeRoot, ...args],
      { encoding: 'utf8', cwd: path.join(__dirname, '..'), env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: number }).code === 'number'
            ? (err as { code: number }).code
            : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

function startWorker(storeRoot: string, args: string[]) {
  return spawn(process.execPath, ['--import', 'tsx', WORKER, storeRoot, ...args], {
    cwd: path.join(__dirname, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

interface ToolCallResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

async function callTool(
  tools: ReturnType<typeof createMemoryTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const tool = tools.find((t) => t.name === name);
  assert(tool, `tool ${name} not found`);
  const result = await tool.handler(args);
  const text = result.content[0]?.text ?? '{}';
  return JSON.parse(text) as ToolCallResult;
}

async function callSystemTool(
  tools: ReturnType<typeof createSystemTools>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  const tool = tools.find((t) => t.name === name);
  assert(tool, `tool ${name} not found`);
  const result = await tool.handler(args);
  const text = result.content[0]?.text ?? '{}';
  return JSON.parse(text) as ToolCallResult;
}

function makeCtx(storeRoot: string): Ctx {
  const indexDao = new IndexDao(storeRoot);
  const memoryStore = new MemoryStore(storeRoot);
  const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
  return {
    cwd: storeRoot,
    workspaceId: 'test-workspace',
    storeRoot,
    indexDao,
    memoryStore,
    themeManager,
    refinedManager: {} as unknown as Ctx['refinedManager'],
  };
}

const suites: Array<{ name: string; run: () => Promise<void> }> = [
  {
    name: 'frontmatter/round-trip',
    run: async () => {
      const frontmatter = {
        key: 'my-key',
        title: 'He said: "hi" # not a comment',
        tags: [],
        note: 'line1\nline2',
        unicode: '中文 ✅ 🎉',
        backslash: 'C:\\path\\to\\file',
        singleQuote: "it's fine",
        revision: 7,
      };
      const body = '# Title\n\n---\n\nstill body';
      const text = stringifyFrontmatter(frontmatter) + body;

      const parsed = parseFrontmatter(text);
      assert(parsed, 'frontmatter should parse');
      assert.deepStrictEqual(parsed.frontmatter, frontmatter);
      assert.strictEqual(parsed.body, body);

      const arrayFrontmatter = { tags: ['a', 'b c', 'd:e'] };
      const parsedArray = parseFrontmatter(stringifyFrontmatter(arrayFrontmatter));
      assert.deepStrictEqual(parsedArray?.frontmatter, arrayFrontmatter);

      // "no tags" and "empty tags" are different states.
      const withoutTags = parseFrontmatter(stringifyFrontmatter({ key: 'k' }));
      assert.strictEqual(withoutTags?.frontmatter.tags, undefined);
      const withEmptyTags = parseFrontmatter(stringifyFrontmatter({ key: 'k', tags: [] }));
      assert.deepStrictEqual(withEmptyTags?.frontmatter.tags, []);
    },
  },
  {
    name: 'frontmatter/legacy-compatibility',
    run: async () => {
      const legacy = [
        '---',
        "key: 'legacy-key'",
        "title: 'Legacy'",
        'tags:',
        '  - one',
        '  - two',
        "createdAt: '2024-01-01T00:00:00.000Z'",
        '---',
        '',
        'Legacy body',
        '',
      ].join('\n');

      const parsed = parseFrontmatter(legacy);
      assert(parsed);
      assert.strictEqual(parsed.frontmatter.key, 'legacy-key');
      assert.strictEqual(parsed.frontmatter.title, 'Legacy');
      assert.deepStrictEqual(parsed.frontmatter.tags, ['one', 'two']);
      assert.strictEqual(parsed.body, 'Legacy body\n');
    },
  },
  {
    name: 'frontmatter/strict-failures',
    run: async () => {
      assert.throws(
        () => parseFrontmatter('---\nkey: a\nkey: b\n---\nbody'),
        (err: unknown) => err instanceof FrontmatterParseError,
        'duplicate keys must fail',
      );
      assert.throws(
        () => parseFrontmatter('---\nkey: a\n  broken line\n---\nbody'),
        (err: unknown) => err instanceof FrontmatterParseError,
        'malformed frontmatter must fail',
      );
      assert.throws(
        () => parseFrontmatter('---\nkey: a\n'),
        (err: unknown) => err instanceof FrontmatterParseError,
        'unterminated frontmatter must fail',
      );
      assert.strictEqual(parseFrontmatter('no frontmatter here'), null);
    },
  },
  {
    name: 'paths/atomic-write',
    run: async () => {
      const dir = makeTempDir('kimi-storage-atomic-');
      const target = path.join(dir, 'note.md');

      atomicWriteFile(target, 'first');
      assert.strictEqual(fs.readFileSync(target, 'utf8'), 'first');
      assert.deepStrictEqual(
        fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
        [],
        'no temporary file may survive a successful write',
      );

      // Concurrent writers must never share a temporary file.
      const a = createTempFilePath(target);
      const b = createTempFilePath(target);
      assert.notStrictEqual(a, b);
      assert(a.includes(String(process.pid)), 'temporary file name contains the pid');

      // A failing write cleans up its own temporary file and keeps the old body.
      const blocked = path.join(dir, 'blocked.md');
      fs.mkdirSync(blocked);
      assert.throws(() => atomicWriteFile(blocked, 'nope'));
      assert.deepStrictEqual(
        fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
        [],
        'a failed write must remove its temporary file',
      );
      assert(fs.statSync(blocked).isDirectory(), 'the original file is untouched');

      if (process.platform !== 'win32') {
        const modeFile = path.join(dir, 'mode.md');
        fs.writeFileSync(modeFile, 'x');
        fs.chmodSync(modeFile, 0o640);
        atomicWriteFile(modeFile, 'y');
        assert.strictEqual(fs.statSync(modeFile).mode & 0o777, 0o640, 'permissions are preserved');
      }
    },
  },
  {
    name: 'paths/temp-cleanup',
    run: async () => {
      const dir = makeTempDir('kimi-storage-tmp-');
      const old = path.join(dir, 'note.md.999999.0123456789abcdef.tmp');
      const fresh = path.join(dir, 'note.md.999999.fedcba9876543210.tmp');
      fs.writeFileSync(old, 'stale');
      fs.writeFileSync(fresh, 'fresh');
      const oldTime = new Date(Date.now() - 10 * 60 * 1000);
      fs.utimesSync(old, oldTime, oldTime);

      const removed = cleanupTempFiles(dir, { maxAgeMs: 60 * 1000 });
      assert.deepStrictEqual(removed, [old]);
      assert(fs.existsSync(fresh), 'recent temporary files are kept');
      assert(!fs.existsSync(old));
    },
  },
  {
    name: 'lock/ordering-and-reentrancy',
    run: async () => {
      const dir = makeTempDir('kimi-storage-lock-');
      const lockA = new WorkspaceLock(dir);
      const lockB = new WorkspaceLock(dir);
      const order: string[] = [];

      const first = lockA.withLock('k', async () => {
        order.push('a-start');
        await sleep(60);
        // Re-entrant acquisition of the same key must not deadlock.
        await lockB.withLock('k', async () => {
          order.push('a-nested');
        });
        order.push('a-end');
      });

      const second = lockB.withLock('k', async () => {
        order.push('b');
      });

      await Promise.all([first, second]);
      assert.deepStrictEqual(order, ['a-start', 'a-nested', 'a-end', 'b']);
    },
  },
  {
    name: 'lock/stale-owner-reclaimed',
    run: async () => {
      const dir = makeTempDir('kimi-storage-stale-');
      const lock = new WorkspaceLock(dir, { timeoutMs: 2000 });
      const lockPath = lock.lockPath('k');

      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          version: 1,
          key: 'k',
          pid: 999999,
          hostname: 'ghost',
          ownerToken: 'dead-token',
          createdAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60000).toISOString(),
        }),
      );

      await lock.withLock('k', async () => {
        assert(fs.existsSync(lockPath), 'the lock is held while the callback runs');
      });
      assert(!fs.existsSync(lockPath), 'the lock is released afterwards');
    },
  },
  {
    name: 'lock/cross-process-timeout',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-lock-timeout-');
      const child = startWorker(storeRoot, ['hold-lock', '3000']);
      await new Promise<void>((resolve, reject) => {
        let buffered = '';
        child.stdout.on('data', (chunk) => {
          buffered += String(chunk);
          if (buffered.includes('LOCKED')) resolve();
        });
        child.on('error', reject);
        setTimeout(() => reject(new Error('worker did not start')), 5000);
      });

      const lock = new WorkspaceLock(workspaceLockRoot(storeRoot), { timeoutMs: 300 });
      let timedOut = false;
      try {
        await lock.withLock(WORKSPACE_LOCK_KEY, async () => undefined);
      } catch (err) {
        timedOut = err instanceof LockTimeoutError;
        if (err instanceof LockTimeoutError) {
          assert(err.owner && err.owner.pid > 0, 'the timeout reports the current owner');
        }
      }
      assert(timedOut, 'a lock held by another process must time out');
      child.kill();
    },
  },
  {
    name: 'memory/backfill-and-stable-id',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-identity-');
      const folder = path.join(storeRoot, 'memory', 'decisions');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'legacy.md'), '# Legacy\n\nold body\n');

      const store = new MemoryStore(storeRoot);
      const read = store.read('memory/decisions', 'legacy');
      assert(read, 'legacy file is readable');
      assert(read.id, 'a stable id is assigned');
      assert.strictEqual(read.revision, 1);
      assert.strictEqual(read.contentHash, hashContent('# Legacy\n\nold body\n'));

      // The id must be persisted: a fresh store instance sees the same id.
      // The read-path backfill is deferred under the workspace lock — flush
      // it before checking the file.
      await store.flushIdentityPersists();
      const reopened = new MemoryStore(storeRoot);
      const reread = reopened.read('memory/decisions', 'legacy');
      assert.strictEqual(reread?.id, read.id, 'the id must not change between runs');
      assert.strictEqual(reread?.revision, 1, 'the revision must not change between runs');

      const raw = fs.readFileSync(path.join(folder, 'legacy.md'), 'utf8');
      assert(raw.includes('id:'), 'the identity is persisted in the frontmatter');
    },
  },
  {
    name: 'memory/concurrent-legacy-backfill',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-backfill-race-');
      const folder = path.join(storeRoot, 'memory');
      fs.mkdirSync(folder, { recursive: true });
      fs.writeFileSync(path.join(folder, 'legacy-race.md'), 'legacy concurrent body\n');

      const [a, b] = await Promise.all([
        runWorker(storeRoot, ['read-id', 'legacy-race']),
        runWorker(storeRoot, ['read-id', 'legacy-race']),
      ]);
      const first = JSON.parse(a.stdout) as { ok: boolean; id: string; revision: number };
      const second = JSON.parse(b.stdout) as { ok: boolean; id: string; revision: number };
      assert(first.ok && second.ok, 'both concurrent readers succeed');
      assert.strictEqual(first.id, second.id, 'both readers converge on one stable id');
      assert.strictEqual(first.revision, 1);
      assert.strictEqual(second.revision, 1);

      const persisted = new MemoryStore(storeRoot).read('memory', 'legacy-race');
      assert.strictEqual(persisted?.id, first.id);
      assert.strictEqual(persisted?.revision, 1);
    },
  },
  {
    name: 'memory/revision-and-cas',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-cas-');
      const store = new MemoryStore(storeRoot);

      const first = store.writeWithResult('memory/decisions', 'cas', 'v1', ['a']);
      assert.strictEqual(first.revision, 1);

      const second = store.writeWithResult('memory/decisions', 'cas', 'v2', undefined, {
        expectedRevision: 1,
      });
      assert.strictEqual(second.revision, 2);
      assert.strictEqual(second.id, first.id, 'the id survives an update');

      assert.throws(
        () =>
          store.writeWithResult('memory/decisions', 'cas', 'v3', undefined, {
            expectedRevision: 1,
          }),
        (err: unknown) => {
          assert(err instanceof RevisionConflictError, 'a stale revision must conflict');
          assert.strictEqual(err.currentRevision, 2);
          assert.strictEqual(err.expectedRevision, 1);
          assert.strictEqual(err.currentContentHash, hashContent('v2'));
          return true;
        },
      );

      const content = store.read('memory/decisions', 'cas');
      assert.strictEqual(content?.content, 'v2', 'a conflicting write must not overwrite');

      for (const [key, body, normalized] of [
        ['leading-newline', '\n\nbody', 'body'],
        ['crlf-body', 'first\r\nsecond', 'first\nsecond'],
      ] as const) {
        const written = store.writeWithResult('memory/decisions', key, body, []);
        const updated = store.writeWithResult('memory/decisions', key, `${normalized}\nnext`, [], {
          expectedRevision: written.revision,
        });
        assert.strictEqual(updated.revision, 2, `${key} must not conflict immediately after its own write`);
        const persisted = parseFrontmatter(fs.readFileSync(written.filePath, 'utf8'));
        assert.strictEqual(persisted?.body, `${normalized}\nnext`);
      }
    },
  },
  {
    name: 'memory/tags-tristate',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-tags-');
      const store = new MemoryStore(storeRoot);

      store.writeWithResult('memory', 'tags', 'body', ['keep', 'me']);
      assert.deepStrictEqual(store.read('memory', 'tags')?.tags, ['keep', 'me']);

      store.writeWithResult('memory', 'tags', 'body', undefined);
      assert.deepStrictEqual(store.read('memory', 'tags')?.tags, ['keep', 'me'], 'undefined keeps');

      store.writeWithResult('memory', 'tags', 'body', []);
      assert.deepStrictEqual(store.read('memory', 'tags')?.tags, [], 'empty array clears');

      store.writeWithResult('memory', 'tags', 'body', ['new']);
      assert.deepStrictEqual(store.read('memory', 'tags')?.tags, ['new'], 'non-empty replaces');
    },
  },
  {
    name: 'memory/external-edit-bumps-revision',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-external-');
      const store = new MemoryStore(storeRoot);
      const written = store.writeWithResult('memory', 'external', 'original body');
      const filePath = written.filePath;

      // Simulate a user editing the file outside of the service.
      const raw = fs.readFileSync(filePath, 'utf8');
      fs.writeFileSync(filePath, raw.replace('original body', 'edited body'), 'utf8');

      const reread = store.read('memory', 'external');
      assert.strictEqual(reread?.revision, 2, 'an external edit bumps the revision');
      assert.strictEqual(reread?.id, written.id, 'the id does not change');

      // The bumped revision is persisted asynchronously under the lock.
      await store.flushIdentityPersists();
      const persisted = fs.readFileSync(filePath, 'utf8');
      assert(persisted.includes('revision: 2'), 'the new revision is persisted');

      const metadataEdit = persisted.replace(/title: "[^"]*"/, 'title: "Externally edited"');
      fs.writeFileSync(filePath, metadataEdit, 'utf8');
      const metadataReread = store.read('memory', 'external');
      assert.strictEqual(metadataReread?.title, 'Externally edited');
      assert.strictEqual(metadataReread?.revision, 3, 'frontmatter-only edits also bump the revision');
      await store.flushIdentityPersists();
      assert(fs.readFileSync(filePath, 'utf8').includes('revision: 3'));

      assert.throws(
        () =>
          store.writeWithResult('memory', 'external', 'third body', undefined, {
            expectedRevision: 1,
          }),
        (err: unknown) => err instanceof RevisionConflictError,
        'an external edit must not be bypassed by the CAS',
      );
    },
  },
  {
    name: 'index/reconcile-detects-external-edit',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-reconcile-');
      const indexDao = new IndexDao(storeRoot);
      const store = new MemoryStore(storeRoot);
      const written = store.writeWithResult('memory/knowledge', 'stack', 'original body', [
        'knowledge',
      ]);

      const first = await indexDao.reconcileIndex();
      assert.strictEqual(first.synced, true);
      assert.strictEqual(first.corruptFiles.length, 0);
      assert.strictEqual(first.revisionsBumped, 0, 'identity persistence alone is not a revision bump');

      const raw = fs.readFileSync(written.filePath, 'utf8');
      fs.writeFileSync(written.filePath, raw.replace('original body', 'edited body'), 'utf8');

      const second = await indexDao.reconcileIndex();
      assert(second.revisionsBumped >= 1, 'the reconciler bumps the revision of changed files');

      const index = indexDao.getIndex();
      const entry = index.index['memory/knowledge/stack.md'] as
        | { id?: string; revision?: number; contentHash?: string }
        | undefined;
      assert.strictEqual(entry?.revision, 2);
      assert.strictEqual(entry?.id, written.id);
      assert.strictEqual(entry?.contentHash, hashContent('edited body'));
    },
  },
  {
    name: 'index/schema-validation',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-index-schema-');
      const indexDao = new IndexDao(storeRoot);
      await indexDao.reconcileIndex();

      fs.writeFileSync(
        path.join(storeRoot, 'index.json'),
        JSON.stringify({ version: '3-kv', meta: {}, index: { 'memory/a.md': { tags: 'nope' } } }),
        'utf8',
      );

      const state = indexDao.getIndexState();
      assert.strictEqual(state.state, 'corrupt', 'an invalid schema must be reported');
      assert(state.lastError, 'the schema error is reported');
    },
  },
  {
    name: 'tools/remember-move-delete-theme-references',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-tools-');
      const ctx = makeCtx(storeRoot);
      const tools = createMemoryTools(ctx);

      const remembered = await callTool(tools, 'remember', {
        key: 'auth-flow',
        folder: 'memory/decisions',
        content: '# Auth flow',
        tags: ['decision'],
        themes: ['security'],
      });
      assert.strictEqual(remembered.success, true);
      assert.strictEqual(remembered.key, 'auth-flow');
      assert(remembered.id, 'remember returns the stable id');
      assert.strictEqual(remembered.revision, 1);
      assert(remembered.contentHash, 'remember returns the content hash');

      const theme = ctx.themeManager.loadTheme('security');
      assert(theme, 'the theme was created');
      const ref = theme?.memories[0];
      assert(ref);
      assert.strictEqual(ref.memoryId, remembered.id);
      assert.strictEqual(ref.status, 'active');
      assert.strictEqual(ref.folder, 'memory/decisions');
      assert.strictEqual(ref.key, 'auth-flow');

      const moved = await callTool(tools, 'move', {
        key: 'auth-flow',
        folder: 'memory/decisions',
        toFolder: 'memory/knowledge',
        newKey: 'auth-flow-v2',
      });
      assert.strictEqual(moved.success, true);
      assert.strictEqual(moved.id, remembered.id, 'the id survives the move');

      const movedTheme = ctx.themeManager.loadTheme('security');
      const movedRef = movedTheme?.memories[0];
      assert.strictEqual(movedRef?.folder, 'memory/knowledge');
      assert.strictEqual(movedRef?.key, 'auth-flow-v2');
      assert.strictEqual(movedRef?.memoryId, remembered.id);

      const deleted = await callTool(tools, 'delete', {
        key: 'auth-flow-v2',
        folder: 'memory/knowledge',
      });
      assert.strictEqual(deleted.success, true);

      const deletedTheme = ctx.themeManager.loadTheme('security');
      const deletedRef = deletedTheme?.memories[0];
      assert.strictEqual(deletedRef?.status, 'deleted', 'the reference must not stay valid');
      assert.strictEqual(deletedRef?.memoryId, remembered.id);
    },
  },
  {
    name: 'tools/remember-conflict-and-tags',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-tools-conflict-');
      const ctx = makeCtx(storeRoot);
      const tools = createMemoryTools(ctx);

      const first = await callTool(tools, 'remember', {
        key: 'conflict',
        folder: 'memory',
        content: 'v1',
        tags: ['a'],
      });
      assert.strictEqual(first.success, true);

      const conflict = await callTool(tools, 'remember', {
        key: 'conflict',
        folder: 'memory',
        content: 'v2',
        expectedRevision: 99,
      });
      assert.strictEqual(conflict.success, false);
      assert.strictEqual(conflict.error, 'RevisionConflict');
      assert.strictEqual(conflict.currentRevision, 1);
      assert(conflict.currentContentHash, 'the conflict reports the current hash');

      const kept = await callTool(tools, 'remember', {
        key: 'conflict',
        folder: 'memory',
        content: 'v3',
      });
      assert.strictEqual(kept.success, true);
      const after = ctx.memoryStore.read('memory', 'conflict');
      assert.deepStrictEqual(after?.tags, ['a'], 'omitting tags keeps the current tags');

      const cleared = await callTool(tools, 'remember', {
        key: 'conflict',
        folder: 'memory',
        content: 'v4',
        tags: [],
      });
      assert.strictEqual(cleared.success, true);
      const clearedRead = ctx.memoryStore.read('memory', 'conflict');
      assert.deepStrictEqual(clearedRead?.tags, [], 'an empty array clears the tags');
    },
  },
  {
    name: 'tools/legacy-key-compatibility',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-legacy-key-');
      const ctx = makeCtx(storeRoot);
      const tools = createMemoryTools(ctx);

      // A file written by an older version with an unsanitized key.
      const folder = path.join(storeRoot, 'memory');
      fs.mkdirSync(folder, { recursive: true });
      const legacyPath = path.join(folder, 'legacy key.md');
      fs.writeFileSync(
        legacyPath,
        "---\nkey: 'legacy key'\ntitle: 'Legacy'\ntags:\n  - old\n---\n\nlegacy body\n",
        'utf8',
      );

      const recalled = await callTool(tools, 'recall', { key: 'legacy key', folder: 'memory' });
      assert.strictEqual(recalled.found, true, 'legacy keys stay readable');
      assert(String(recalled.content).includes('legacy body'));

      const moved = await callTool(tools, 'move', {
        key: 'legacy key',
        folder: 'memory',
        toFolder: 'memory/knowledge',
      });
      assert.strictEqual(moved.success, true, 'legacy keys stay movable');
      assert.strictEqual(moved.key, 'legacy_key', 'the new path uses the canonical key');
      assert(fs.existsSync(path.join(storeRoot, 'memory', 'knowledge', 'legacy_key.md')));
      assert(!fs.existsSync(legacyPath), 'the legacy file is moved, not copied');

      const deleted = await callTool(tools, 'delete', {
        key: 'legacy key',
        folder: 'memory/knowledge',
      });
      assert.strictEqual(deleted.success, true, 'legacy keys stay deletable');
      assert(
        !fs.existsSync(path.join(storeRoot, 'memory', 'knowledge', 'legacy_key.md')),
        'the memory is gone',
      );
    },
  },
  {
    name: 'tools/orphaned-theme-references',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-orphan-');
      const ctx = makeCtx(storeRoot);
      const tools = createMemoryTools(ctx);

      const remembered = await callTool(tools, 'remember', {
        key: 'gone',
        folder: 'memory',
        content: 'will disappear',
        themes: ['topic'],
      });
      assert.strictEqual(remembered.success, true);
      assert.strictEqual(ctx.themeManager.loadTheme('topic')?.memories[0]?.status, 'active');

      // The file disappears without going through the delete tool.
      const filePath = ctx.memoryStore.resolveFilePath('memory', 'gone');
      fs.unlinkSync(filePath);

      await ctx.indexDao.reconcileIndex();
      const ref = ctx.themeManager.loadTheme('topic')?.memories[0];
      assert.strictEqual(ref?.status, 'orphaned', 'a missing memory must orphan its reference');
      assert.strictEqual(ref?.memoryId, remembered.id);
    },
  },
  {
    name: 'concurrency/two-processes-different-keys',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-concurrent-');
      const childA = startWorker(storeRoot, ['write', 'alpha', 'content alpha']);
      const childB = startWorker(storeRoot, ['write', 'beta', 'content beta']);

      const results = await Promise.all(
        [childA, childB].map(
          (child) =>
            new Promise<{ code: number; stdout: string }>((resolve) => {
              let stdout = '';
              child.stdout.on('data', (chunk) => {
                stdout += String(chunk);
              });
              child.on('close', (code) => resolve({ code: code ?? 0, stdout }));
            }),
        ),
      );

      for (const result of results) {
        assert.strictEqual(result.code, 0, 'both writers succeed');
        assert(JSON.parse(result.stdout).ok);
      }

      const store = new MemoryStore(storeRoot);
      assert.strictEqual(store.read('memory', 'alpha')?.content, 'content alpha');
      assert.strictEqual(store.read('memory', 'beta')?.content, 'content beta');

      const indexDao = new IndexDao(storeRoot);
      await indexDao.reconcileIndex();
      const index = indexDao.getIndex();
      assert(index.index['memory/alpha.md'], 'the index contains the first memory');
      assert(index.index['memory/beta.md'], 'the index contains the second memory');
    },
  },
  {
    name: 'concurrency/same-key-cas',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-cas-race-');
      const store = new MemoryStore(storeRoot);
      const written = store.writeWithResult('memory', 'race', 'base');
      const expected = String(written.revision);

      const [a, b] = await Promise.all([
        runWorker(storeRoot, ['cas', 'race', 'from a', expected]),
        runWorker(storeRoot, ['cas', 'race', 'from b', expected]),
      ]);

      const parsed = [a, b].map(
        (result) => JSON.parse(result.stdout || '{}') as { ok: boolean; error?: string },
      );
      const succeeded = parsed.filter((entry) => entry.ok);
      const conflicted = parsed.filter((entry) => !entry.ok);
      assert.strictEqual(succeeded.length, 1, 'exactly one writer wins');
      assert.strictEqual(conflicted.length, 1, 'the other writer sees a conflict');
      assert.strictEqual(conflicted[0].error, 'RevisionConflict');

      const after = store.read('memory', 'race');
      assert.strictEqual(after?.revision, 2, 'the revision was incremented exactly once');
      assert(['from a', 'from b'].includes(after?.content ?? ''), 'no write was lost silently');
    },
  },
  {
    name: 'memory/move-unlink-failure-fault-injection',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-movefail-');
      const store = new MemoryStore(storeRoot);
      store.writeWithResult('memory', 'movable', 'move me', []);

      // Injected fault: the source unlink throws after the destination was
      // written (review R-05 wanted exactly this injection).
      const result = await runWorker(
        storeRoot,
        ['move-tool', 'movable', 'memory/archived'],
        { KIMI_MEMORY_FAULT: 'move.before-unlink-source:throw' },
      );
      const parsed = JSON.parse(result.stdout || '{}') as { success: boolean; error?: string };
      assert.strictEqual(parsed.success, false, 'the move reports failure');
      assert(/rolled back/.test(String(parsed.error)), 'the error names the rollback');

      // No double-authority state: the source survives, the destination is
      // gone, and the journal holds a failed entry for diagnostics.
      const sourcePath = store.resolveFilePath('memory', 'movable');
      const destPath = path.join(storeRoot, 'memory', 'archived', 'movable.md');
      assert(fs.existsSync(sourcePath), 'the source survives the failed move');
      assert(!fs.existsSync(destPath), 'no orphan destination file remains');
      const reread = store.read('memory', 'movable');
      assert.strictEqual(reread?.content, 'move me', 'the source content is intact');

      // A clean move still works after the failure.
      const retry = await runWorker(storeRoot, ['move-tool', 'movable', 'memory/archived']);
      const retryResult = JSON.parse(retry.stdout || '{}') as { success: boolean };
      assert.strictEqual(retryResult.success, true);
      assert(!fs.existsSync(sourcePath), 'the source is gone after a clean move');
      assert(fs.existsSync(destPath), 'the destination exists after a clean move');
    },
  },
  {
    name: 'memory/restore-trash-unlink-failure',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-rfail-');
      const store = new MemoryStore(storeRoot);
      store.writeWithResult('memory', 'rfail', 'restorable content', []);
      const removed = store.deleteWithResult('memory', 'rfail');
      assert(removed?.trashPath, 'the entry sits in trash');

      // Fault injection: the trash unlink throws after the target was
      // restored (review P2 #2).
      process.env.KIMI_MEMORY_FAULT = 'restore.before-trash-unlink:throw';
      let thrown: Error | null = null;
      try {
        store.restoreWithResult('memory', 'rfail');
      } catch (err) {
        thrown = err as Error;
      } finally {
        delete process.env.KIMI_MEMORY_FAULT;
      }
      assert(thrown, 'the restore reports failure');
      assert(/rolled back/.test(thrown!.message), 'the error names the rollback');

      // No partial state: the restored target was rolled back, the trash
      // copy still exists, and a clean retry succeeds.
      assert(
        !fs.existsSync(store.resolveFilePath('memory', 'rfail')),
        'the restored target was rolled back',
      );
      assert(fs.existsSync(removed.trashPath!), 'the trash copy is untouched');

      const restored = store.restoreWithResult('memory', 'rfail');
      assert(restored, 'a clean retry restores successfully');
      assert.strictEqual(restored!.id, removed.id, 'the stable id is preserved');
    },
  },
  {
    name: 'journal/corrupt-entry-reported',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-jcorrupt-');
      const journal = new WorkspaceJournal(storeRoot);
      journal.prepare('remember', { targetPath: 'memory/valid.md' });

      // Corrupt entries: broken JSON and an unknown schema version.
      fs.writeFileSync(path.join(storeRoot, '.journal', 'broken.json'), '{ not json', 'utf8');
      fs.writeFileSync(
        path.join(storeRoot, '.journal', 'future.json'),
        JSON.stringify({ schemaVersion: 99, operationId: 'x', op: 'remember', state: 'prepared' }),
        'utf8',
      );

      const recovery = await journal.recover();
      // The valid prepared entry is reconciled as usual…
      assert.strictEqual(recovery.recovered.length, 1, 'valid entries are still reconciled');
      // …and the corrupt ones are reported.
      assert.strictEqual(recovery.corrupt.length, 2, 'corrupt entries are reported');
      const reasons = recovery.corrupt.map((c) => c.reason).join(' | ');
      assert(/invalid JSON/.test(reasons), 'invalid JSON is named');
      assert(/unsupported schemaVersion/.test(reasons), 'the schema mismatch is named');

      // The corrupt files stay on disk for human inspection — they must not
      // look like "there was no journal".
      assert(fs.existsSync(path.join(storeRoot, '.journal', 'broken.json')));
      assert(fs.existsSync(path.join(storeRoot, '.journal', 'future.json')));

      const syncRecovery = await journal.recover();
      assert.strictEqual(syncRecovery.corrupt.length, 2, 'the report is stable across runs');
    },
  },
  {
    name: 'journal/move-crash-recovers-theme-path',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-movetheme-');
      const store = new MemoryStore(storeRoot);
      store.writeWithResult('memory', 'theme-moved', 'content with id', []);
      const read = store.read('memory', 'theme-moved');
      const memoryId = read?.id as string;

      const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
      await themeManager.addThemeAssociation('moved-theme', {
        memoryKey: 'theme-moved',
        folder: 'memory',
        title: 'Theme Moved',
        memoryId,
      });

      // The move worker crashes AFTER the file move (dest written, source
      // removed) and BEFORE the index/theme update (review P2 #3 repro).
      const crashed = await runWorker(
        storeRoot,
        ['move-tool', 'theme-moved', 'memory/archived'],
        { KIMI_MEMORY_FAULT: 'move.after-file-move:crash' },
      );
      assert.strictEqual(crashed.code, 70);
      assert(
        fs.existsSync(path.join(storeRoot, 'memory', 'archived', 'theme-moved.md')),
        'the moved file exists at the new location',
      );
      assert(
        !fs.existsSync(store.resolveFilePath('memory', 'theme-moved')),
        'the old location is empty',
      );

      // Recovery: reconcile must align the theme reference PATH by stable
      // id, not only its status.
      const indexDao = new IndexDao(storeRoot);
      const recovery = await new WorkspaceJournal(storeRoot).recover(() =>
        indexDao.reconcileIndex(),
      );
      assert.strictEqual(recovery.recovered.length, 1, 'the interrupted move is recovered');

      const theme = themeManager.loadTheme('moved-theme');
      const ref = theme?.memories?.[0];
      assert(ref, 'the theme reference exists');
      assert.strictEqual(ref.memoryId, memoryId, 'the stable id is unchanged');
      assert.strictEqual(ref.folder, 'memory/archived', 'the reference folder follows the file');
      assert.strictEqual(ref.status, 'active', 'the reference is active');
    },
  },
  {
    name: 'lock/try-sync-self-heals-dead-holder',
    run: async () => {
      // A reclaimer that dies while holding the reclaim mutex leaves its
      // file behind; tryWithLockSync must recover it (death detection) so
      // future reclaims are never blocked forever.
      const lockRoot = makeTempDir('kimi-lock-trysync-');
      const lock = new WorkspaceLock(lockRoot);

      // Dead holder on the reclaim mutex itself.
      const reclaimPath = lock.lockPath('reclaim');
      fs.mkdirSync(lockRoot, { recursive: true });
      fs.writeFileSync(
        reclaimPath,
        JSON.stringify({
          version: 1,
          key: 'reclaim',
          pid: 3333333,
          hostname: 'dead-host',
          ownerToken: 'dead-reclaimer',
          createdAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        'utf8',
      );

      const outcome = lock.tryWithLockSync('reclaim', () => 'ran');
      assert(outcome.acquired, 'the dead holder is reclaimed and the section runs');
      assert.strictEqual(outcome.result, 'ran');
      // The section releases internally: the record is gone afterwards.
      assert.strictEqual(lock.inspect('reclaim'), null, 'released record is removed');

      // A LIVE holder blocks the sync attempt (mutual exclusion preserved):
      // seed a record whose owner pid is this (alive) process.
      const now = new Date().toISOString();
      fs.writeFileSync(
        reclaimPath,
        JSON.stringify({
          version: 1,
          key: 'reclaim',
          pid: process.pid,
          hostname: 'live-host',
          ownerToken: 'live-holder-token',
          createdAt: now,
          heartbeatAt: now,
          leaseExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
        'utf8',
      );
      const blocked = lock.tryWithLockSync('reclaim', () => 'should not run');
      assert.strictEqual(blocked.acquired, false, 'a live holder blocks the sync attempt');
      assert(fs.existsSync(reclaimPath), 'the live record survives the blocked attempt');
    },
  },
  {
    name: 'lock/claim-guards-protect-live-replacements',
    run: async () => {
      const lockRoot = makeTempDir('kimi-lock-claim-guard-');
      const lock = new WorkspaceLock(lockRoot);
      const lockPath = lock.lockPath('claim-race');
      const guardPath = `${lockPath}.claim-999999-guard`;
      const capturedPath = `${guardPath}.captured`;
      const now = new Date().toISOString();
      const owner = (pid: number, ownerToken: string) => ({
        version: 1,
        key: 'claim-race',
        pid,
        hostname: 'test-host',
        ownerToken,
        createdAt: now,
        heartbeatAt: now,
        leaseExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
      });

      fs.mkdirSync(lockRoot, { recursive: true });
      fs.writeFileSync(guardPath, JSON.stringify(owner(process.pid, 'active-reclaimer')));
      fs.writeFileSync(capturedPath, JSON.stringify(owner(process.pid, 'live-owner')));

      // A new acquisition may create a tentative main file, but the visible
      // claim guard forces it to back off without disturbing the captured owner.
      const duringClaim = lock.tryWithLockSync('claim-race', () => 'must not run');
      assert.strictEqual(duringClaim.acquired, false);
      assert.strictEqual(fs.existsSync(lockPath), false);
      assert.strictEqual(
        JSON.parse(fs.readFileSync(capturedPath, 'utf8')).ownerToken,
        'live-owner',
      );

      // If the reclaimer dies, recovery must restore the live captured owner,
      // not discard it merely because a tentative replacement appeared.
      fs.writeFileSync(guardPath, JSON.stringify(owner(3333333, 'dead-reclaimer')));
      fs.writeFileSync(lockPath, JSON.stringify(owner(process.pid, 'tentative-owner')));
      const recovered = lock.tryWithLockSync('claim-race', () => 'must not run either');
      assert.strictEqual(recovered.acquired, false);
      assert.strictEqual(fs.existsSync(capturedPath), false);
      assert.strictEqual(
        JSON.parse(fs.readFileSync(lockPath, 'utf8')).ownerToken,
        'live-owner',
      );
      assert.strictEqual(
        fs.readdirSync(lockRoot).some((name) => name.includes('.claim-')),
        false,
        'claim and reap records are cleaned after restoration',
      );
    },
  },
  {
    name: 'lock/alive-owner-never-reclaimed-even-with-expired-lease',
    run: async () => {
      const storeRoot = makeTempDir('kimi-lock-alive-');
      const lock = new WorkspaceLock(workspaceLockRoot(storeRoot), { timeoutMs: 600, pollIntervalMs: 40 });

      // Real two-process repro of review P1 #1: worker A holds the lock and
      // stalls (its lease expires while its process stays alive).
      const worker = startWorker(storeRoot, ['stall-lock', '1200']);
      await new Promise<void>((resolve, reject) => {
        let buffered = '';
        worker.stdout!.on('data', (chunk) => {
          buffered += String(chunk);
          if (buffered.includes('LOCKED')) resolve();
        });
        worker.once('exit', () => reject(new Error('worker exited before locking')));
      });

      // Worker A is alive with an expired lease: B must NOT take over.
      let timedOut = false;
      try {
        await lock.withLock(WORKSPACE_LOCK_KEY, () => 'should not run', { timeoutMs: 600 });
      } catch (err) {
        timedOut = err instanceof LockTimeoutError;
      }
      assert(timedOut, 'an alive owner with an expired lease is never taken over');

      // While A is alive, the lock file still identifies A as owner.
      const owner = lock.inspect(WORKSPACE_LOCK_KEY);
      assert(owner && owner.pid === worker.pid, 'the lock still belongs to the live process');

      // Only after A exits (death detection) does the lock become available.
      await new Promise<void>((resolve) => {
        worker.on('exit', () => resolve());
      });
      const acquired = await lock.withLock(WORKSPACE_LOCK_KEY, () => 'acquired', {
        timeoutMs: 2000,
      });
      assert.strictEqual(acquired, 'acquired', 'the lock is reclaimed after owner death');
    },
  },
  {
    name: 'index/duplicate-id-conflict-reported',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-dupid-');
      const store = new MemoryStore(storeRoot);
      store.writeWithResult('memory', 'dup-a', 'content A', []);
      const idA = store.read('memory', 'dup-a')?.id as string;

      // A second file carries the SAME stable id with different content.
      const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
      await themeManager.addThemeAssociation('dup-theme', {
        memoryKey: 'dup-a',
        folder: 'memory',
        title: 'Dup A',
        memoryId: idA,
      });
      const otherDir = path.join(storeRoot, 'memory', 'other');
      fs.mkdirSync(otherDir, { recursive: true });
      const rawA = fs.readFileSync(store.resolveFilePath('memory', 'dup-a'), 'utf8');
      fs.writeFileSync(
        path.join(otherDir, 'dup-b.md'),
        rawA.replace('content A', 'content B'),
        'utf8',
      );

      const outcome = await new IndexDao(storeRoot).reconcileIndex();
      assert.strictEqual(
        outcome.synced,
        false,
        'duplicate ids forbid a clean sync (review P1 #2)',
      );
      assert(
        outcome.errors.some((e) => /duplicate memory id/.test(e) && e.includes('dup-a')),
        'the conflict is reported with both paths',
      );

      // The theme reference is NOT re-pointed to the other file: the
      // migration contract forbids automatic merging.
      const ref = themeManager.loadTheme('dup-theme')?.memories?.[0];
      assert.strictEqual(ref?.folder, 'memory', 'the reference location is untouched');
      assert.strictEqual(ref?.key, 'dup-a', 'the reference key is untouched');
      assert.strictEqual(ref?.title, 'Dup A', 'the reference title is untouched');
      assert.strictEqual(ref?.status, 'active');

      // The conflict must NOT become a clean checkpoint: repeated reconciles
      // keep reporting it instead of short-circuiting to skipped/synced:true
      // (review P2, round 6 #1 — the repro needed three runs).
      const indexDao = new IndexDao(storeRoot);
      for (let run = 2; run <= 3; run++) {
        const repeat = await indexDao.reconcileIndex();
        assert.strictEqual(repeat.synced, false, `run ${run}: the conflict keeps syncing false`);
        assert.strictEqual(repeat.skipped, false, `run ${run}: is a full reconcile, not skipped`);
        assert(
          repeat.errors.some((e) => /duplicate memory id/.test(e)),
          `run ${run}: the duplicate is re-reported`,
        );
      }
    },
  },
  {
    name: 'journal/recover-keeps-entries-when-reconcile-fails',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-jfail-');
      const store = new MemoryStore(storeRoot);
      store.writeWithResult('memory', 'kept-entry', 'content with id', []);
      const memoryId = store.read('memory', 'kept-entry')?.id as string;

      const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
      await themeManager.addThemeAssociation('failing-theme', {
        memoryKey: 'kept-entry',
        folder: 'memory',
        title: 'Kept Entry',
        memoryId,
      });

      // A duplicate id poisons the reconcile: it reports synced:false.
      const dupDir = path.join(storeRoot, 'memory', 'dup');
      fs.mkdirSync(dupDir, { recursive: true });
      const raw = fs.readFileSync(store.resolveFilePath('memory', 'kept-entry'), 'utf8');
      fs.writeFileSync(path.join(dupDir, 'kept-entry.md'), raw, 'utf8');

      // An interrupted move left a prepared journal entry.
      const journal = new WorkspaceJournal(storeRoot);
      journal.prepare('move', {
        targetPath: 'memory/archived/kept-entry.md',
        sourcePath: 'memory/kept-entry.md',
      });
      const before = journal.list().length;
      assert.strictEqual(before, 1);

      // Recovery: the failing reconcile must NOT drop the prepared entry —
      // it is the only recovery clue (review P2, round 6 #2).
      const { IndexDao } = await import('../src/dao/index.js');
      const recovery = await journal.recover(async () =>
        new IndexDao(storeRoot).reconcileIndex(),
      );
      assert.strictEqual(recovery.recovered.length, 0, 'nothing is reported as recovered');
      assert.strictEqual(recovery.failed.length, 1, 'the entry is reported as failed');
      assert(/synced: false/.test(String(recovery.failed[0].reason)), 'the failure names the reconcile');
      assert.strictEqual(journal.list().length, 1, 'the recovery clue stays on disk');

      // The theme reference is untouched by the failed recovery.
      const ref = themeManager.loadTheme('failing-theme')?.memories?.[0];
      assert.strictEqual(ref?.folder, 'memory', 'the reference folder is unchanged');
      assert.strictEqual(ref?.status, 'active');
    },
  },
  {
    name: 'index/theme-update-failure-retried',
    run: async () => {
      // Review round 6 follow-up (P2): the theme update runs AFTER the index
      // is saved. A one-shot failure must NOT be hidden by the clean
      // checkpoint — the second reconcile must retry and align the
      // reference.
      const storeRoot = makeTempDir('kimi-storage-themefail-');
      const store = new MemoryStore(storeRoot);
      store.writeWithResult('memory', 'retry-a', 'content retry', []);
      const memoryId = store.read('memory', 'retry-a')?.id as string;

      const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
      await themeManager.addThemeAssociation('retry-theme', {
        memoryKey: 'retry-a',
        folder: 'memory',
        title: 'Retry A',
        memoryId,
      });

      // Simulate a crashed move: the file lives at the new location, the
      // theme still points at the old one.
      const archivedDir = path.join(storeRoot, 'memory', 'archived');
      fs.mkdirSync(archivedDir, { recursive: true });
      fs.renameSync(store.resolveFilePath('memory', 'retry-a'), path.join(archivedDir, 'retry-a.md'));

      const indexDao = new IndexDao(storeRoot);
      const prevFlag = process.env.KIMI_MEMORY_FAULT;
      try {
        // First reconcile: the theme-location update is injected to fail.
        process.env.KIMI_MEMORY_FAULT = 'reconcile.theme-locations:throw';
        const first = await indexDao.reconcileIndex();
        assert.strictEqual(first.synced, false, 'the injected failure surfaces');
        assert(first.errors.some((e) => /Injected fault/.test(e)), 'the injection is reported');

        // Second reconcile (no fault): the update MUST be retried — not
        // hidden behind the clean checkpoint.
        delete process.env.KIMI_MEMORY_FAULT;
        const second = await indexDao.reconcileIndex();
        assert.strictEqual(second.synced, true, 'the retry succeeds');

        const ref = themeManager.loadTheme('retry-theme')?.memories?.[0];
        assert.strictEqual(ref?.folder, 'memory/archived', 'the reference was aligned on retry');
        assert.strictEqual(ref?.memoryId, memoryId);
        assert.strictEqual(ref?.status, 'active');
      } finally {
        if (prevFlag === undefined) delete process.env.KIMI_MEMORY_FAULT;
        else process.env.KIMI_MEMORY_FAULT = prevFlag;
      }
    },
  },
  {
    name: 'lock/multi-waiter-reclaim-no-overlap',
    run: async () => {
      // Review P1 round 6: six waiters racing to reclaim the same dead
      // owner caused real critical-section overlap (a delayed stale-unlink
      // destroyed a freshly created lock). With the reclaim serialized by
      // the reclaim mutex, the enter/exit intervals of all workers must be
      // strictly mutually exclusive.
      const storeRoot = makeTempDir('kimi-lock-contend-');
      const lockRoot = workspaceLockRoot(storeRoot);
      // Seed at the REAL lock path the implementation constructs (SHA-256 of
      // the key) — a wrong filename would make the test pass vacuously
      // (review round 6 follow-up).
      const lock = new WorkspaceLock(lockRoot);
      const mainLockPath = lock.lockPath(WORKSPACE_LOCK_KEY);

      // Seed a dead owner lock: pid that does not exist, lease long expired.
      fs.mkdirSync(lockRoot, { recursive: true });
      const deadPid = 3333333;
      fs.writeFileSync(
        mainLockPath,
        JSON.stringify({
          version: 1,
          key: WORKSPACE_LOCK_KEY,
          pid: deadPid,
          hostname: 'dead-host',
          ownerToken: 'dead-owner-token',
          createdAt: new Date(Date.now() - 3600_000).toISOString(),
          heartbeatAt: new Date(Date.now() - 3600_000).toISOString(),
          leaseExpiresAt: new Date(Date.now() - 1800_000).toISOString(),
        }),
        'utf8',
      );

      // Six real processes race to reclaim and enter.
      const WORKERS = 6;
      const ROUNDS = 2;
      const HOLD_MS = 120;
      const workers = Array.from({ length: WORKERS }, () =>
        startWorker(storeRoot, ['contend-lock', String(ROUNDS), String(HOLD_MS)]),
      );

      const events: Array<{ pid: number; event: 'enter' | 'exit'; t: number }> = [];
      await Promise.all(
        workers.map(
          (worker) =>
            new Promise<void>((resolve, reject) => {
              let buffered = '';
              worker.stdout!.on('data', (chunk) => {
                buffered += String(chunk);
                let idx: number;
                while ((idx = buffered.indexOf('\n')) >= 0) {
                  const line = buffered.slice(0, idx).trim();
                  buffered = buffered.slice(idx + 1);
                  if (line) events.push(JSON.parse(line));
                }
              });
              worker.stderr!.on('data', () => {
                /* ignore */
              });
              worker.on('exit', (code) => {
                if (code === 0) resolve();
                else reject(new Error(`worker exited ${code}`));
              });
            }),
        ),
      );
      assert.strictEqual(events.length, WORKERS * ROUNDS * 2, 'every enter/exit was recorded');

      // Overlap detection across DIFFERENT pids: sort by enter time, then
      // the exit of the current holder must not exceed the next enter.
      const enters = events.filter((e) => e.event === 'enter').sort((a, b) => a.t - b.t);
      const exits = events.filter((e) => e.event === 'exit').sort((a, b) => a.t - b.t);
      for (let i = 1; i < enters.length; i++) {
        const prevExit = exits.find((e) => e.pid === enters[i - 1].pid)?.t ?? 0;
        if (enters[i - 1].pid !== enters[i].pid) {
          assert(
            prevExit <= enters[i].t,
            `critical sections overlap: pid ${enters[i - 1].pid} exited at ${prevExit} ` +
              `but pid ${enters[i].pid} entered at ${enters[i].t}`,
          );
        }
      }
    },
  },
  {
    name: 'index/corrupt-file-keeps-reporting',
    run: async () => {
      // Review P2 round 6 follow-up: a corrupt file must block the clean
      // checkpoint so EVERY reconcile keeps reporting it (previously the
      // second run short-circuited to skipped/synced:true).
      const storeRoot = makeTempDir('kimi-storage-corruptrep-');
      fs.mkdirSync(path.join(storeRoot, 'memory'), { recursive: true });
      fs.writeFileSync(path.join(storeRoot, 'memory', 'ok.md'), '---\nkey: "ok"\n---\n\nfine');
      // Duplicate frontmatter key: strict parse throws → corrupt.
      fs.writeFileSync(
        path.join(storeRoot, 'memory', 'broken.md'),
        '---\nkey: "a"\nkey: "b"\n---\n\nbody',
        'utf8',
      );

      const indexDao = new IndexDao(storeRoot);
      const first = await indexDao.reconcileIndex();
      assert.strictEqual(first.synced, false, 'a corrupt file blocks a clean sync');
      assert.deepStrictEqual(first.corruptFiles, ['memory/broken.md']);

      const second = await indexDao.reconcileIndex();
      assert.strictEqual(second.synced, false, 'the second run still reports the problem');
      assert.strictEqual(second.skipped, false, 'the second run is a full rescan, not skipped');
      assert.deepStrictEqual(second.corruptFiles, ['memory/broken.md'], 'the file is re-reported');

      // Once the corrupt file is removed, the sync goes clean again.
      fs.rmSync(path.join(storeRoot, 'memory', 'broken.md'));
      const third = await indexDao.reconcileIndex();
      assert.strictEqual(third.synced, true);
      assert.deepStrictEqual(third.corruptFiles, []);
    },
  },
  {
    name: 'memory/schema-version-and-trash-metadata',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-schema-');
      const store = new MemoryStore(storeRoot);

      store.writeWithResult('memory', 'schemakey', 'body text', ['one']);
      const file = store.resolveFilePath('memory', 'schemakey');
      const parsed = parseFrontmatter(fs.readFileSync(file, 'utf8'));
      assert(parsed);
      assert.strictEqual(parsed.frontmatter.schemaVersion, 1, 'new writes carry schemaVersion');

      // Delete moves the entry into trash with provenance metadata.
      const removed = store.deleteWithResult('memory', 'schemakey');
      assert(removed?.trashPath, 'delete reports the trash copy');
      assert(!fs.existsSync(file), 'the original path is empty after delete');
      const trashParsed = parseFrontmatter(fs.readFileSync(removed.trashPath!, 'utf8'));
      assert(trashParsed);
      assert.strictEqual(typeof trashParsed.frontmatter.deletedAt, 'string');
      assert.strictEqual(
        trashParsed.frontmatter.deletedFrom,
        'memory/schemakey.md',
        'trash records the original store-relative path',
      );
      assert.strictEqual(trashParsed.body.trim(), 'body text');
    },
  },
  {
    name: 'memory/repeated-delete-preserves-trash-history',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-trash-history-');
      const store = new MemoryStore(storeRoot);

      store.writeWithResult('memory', 'same', 'FIRST', []);
      const first = store.deleteWithResult('memory', 'same');
      store.writeWithResult('memory', 'same', 'SECOND', []);
      const second = store.deleteWithResult('memory', 'same');

      assert(first?.trashPath && second?.trashPath);
      assert.notStrictEqual(first.trashPath, second.trashPath, 'each deletion gets its own trash copy');
      const trash = store.listTrash();
      assert.strictEqual(trash.length, 2);
      assert.deepStrictEqual(trash.map((entry) => entry.key), ['same', 'same']);
      assert.strictEqual(parseFrontmatter(fs.readFileSync(first.trashPath, 'utf8'))?.body, 'FIRST');
      assert.strictEqual(parseFrontmatter(fs.readFileSync(second.trashPath, 'utf8'))?.body, 'SECOND');

      const latest = store.restoreWithResult('memory', 'same');
      assert.strictEqual(latest && fs.readFileSync(latest.filePath, 'utf8').endsWith('SECOND'), true);
      assert.strictEqual(store.listTrash().length, 1, 'the older copy remains recoverable');

      fs.unlinkSync(latest!.filePath);
      const older = store.restoreWithResult('memory', 'same');
      assert.strictEqual(older && fs.readFileSync(older.filePath, 'utf8').endsWith('FIRST'), true);
      assert.strictEqual(store.listTrash().length, 0);
    },
  },
  {
    name: 'memory/trash-and-restore',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-trash-');
      const ctx = makeCtx(storeRoot);
      const tools = createMemoryTools(ctx);

      const remembered = await callTool(tools, 'remember', {
        key: 'restore-me',
        folder: 'memory/decisions',
        content: 'important decision',
        tags: ['decision'],
        themes: ['restore-theme'],
      });
      assert.strictEqual(remembered.success, true);
      const originalId = remembered.id as string;
      const originalRevision = remembered.revision as number;

      // Delete: soft, with the theme reference marked deleted.
      const deleted = await callTool(tools, 'delete', { key: 'restore-me', folder: 'memory/decisions' });
      assert.strictEqual(deleted.success, true);
      assert.strictEqual(deleted.recoverable, true, 'delete reports the entry as recoverable');
      assert(typeof deleted.trashPath === 'string' && deleted.trashPath.startsWith('trash/'));
      const themeAfterDelete = ctx.themeManager.loadTheme('restore-theme');
      const refAfterDelete = themeAfterDelete?.memories?.find((m) => m.key === 'restore-me');
      assert.strictEqual(refAfterDelete?.status, 'deleted', 'theme reference marked deleted');

      // Restore: id and revision survive, theme reference is active again.
      const restored = await callTool(tools, 'restore_memory', {
        key: 'restore-me',
        folder: 'memory/decisions',
      });
      assert.strictEqual(restored.success, true, `restore succeeded: ${restored.error ?? ''}`);
      assert.strictEqual(restored.id, originalId, 'stable id survives the round trip');
      assert.strictEqual(restored.revision, originalRevision, 'revision survives the round trip');
      const themeAfterRestore = ctx.themeManager.loadTheme('restore-theme');
      const refAfterRestore = themeAfterRestore?.memories?.find((m) => m.key === 'restore-me');
      assert.strictEqual(refAfterRestore?.status, 'active', 'theme reference reactivated');

      // The trash is empty again and the index knows the entry.
      const store = new MemoryStore(storeRoot);
      assert.strictEqual(store.listTrash().length, 0, 'no trash copy remains');
      const indexEntry = ctx.indexDao.getIndex().index['memory/decisions/restore-me.md'];
      assert(indexEntry, 'the restored entry is in the index');

      // Restoring without a trash copy fails clearly.
      const missing = await callTool(tools, 'restore_memory', {
        key: 'restore-me',
        folder: 'memory/decisions',
      });
      assert.strictEqual(missing.success, false);
      assert(/No trash copy/.test(String(missing.error)));
    },
  },
  {
    name: 'validation/nfc-and-control-chars',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-nfc-');
      const store = new MemoryStore(storeRoot);

      // NFC normalization: decomposed and composed forms map to one file.
      const decomposed = 'cafe\u0301';
      const composed = 'caf\u00e9';
      assert.strictEqual(sanitizeKey(decomposed), sanitizeKey(composed));
      store.writeWithResult('memory', decomposed, 'nfc body', []);
      const found = store.findExistingFile('memory', composed);
      assert(found, 'the composed form resolves to the stored file');

      // Control characters are rejected, not silently replaced.
      assert.throws(
        () => sanitizeKey('bad\u0000key'),
        InvalidKeyError,
        'NUL bytes are rejected',
      );
      assert.throws(() => sanitizeKey('bad\u001fkey'), InvalidKeyError);

      const ctx = makeCtx(storeRoot);
      const tools = createMemoryTools(ctx);
      const rejected = await callTool(tools, 'remember', { key: 'bad\u0007key', content: 'x' });
      assert.strictEqual(rejected.success, false, 'the tool rejects control-character keys');
      assert(/control characters/.test(String(rejected.error)));

      assert.strictEqual(sanitizeFolder('decisions'), 'memory/decisions');
      assert.strictEqual(sanitizeFolder('knowledge/sub'), 'memory/knowledge/sub');
      assert.strictEqual(sanitizeFolder('notes'), 'notes');
      const bareFolder = await callTool(tools, 'remember', {
        key: 'bare-folder',
        folder: 'decisions',
        content: 'indexed and backed up',
      });
      assert.strictEqual(bareFolder.success, true);
      assert(fs.existsSync(path.join(storeRoot, 'memory', 'decisions', 'bare-folder.md')));
      assert(!fs.existsSync(path.join(storeRoot, 'decisions', 'bare-folder.md')));
    },
  },
  {
    name: 'essence/prepare-store-conflict',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-essence-');
      const ctx = makeCtx(storeRoot);
      const tools = createSystemTools(ctx);

      // Two memories so the prepare snapshot covers real content.
      ctx.memoryStore.writeWithResult('memory/decisions', 'auth-flow', 'use tokens', ['decision']);
      ctx.memoryStore.writeWithResult('memory/knowledge', 'stack', 'typescript', ['knowledge']);
      await ctx.indexDao.reconcileIndex();

      const prepared = await callSystemTool(tools, 'organize_memories', {});
      assert.strictEqual(prepared.stage, 'prepare');
      assert(typeof prepared.prepareToken === 'string' && prepared.prepareToken.startsWith('prep-'));
      assert.strictEqual(Array.isArray(prepared.pendingMemories), true);
      assert(
        (prepared.pendingMemories as Array<{ contentHash: unknown }>).every(
          (m) => typeof m.contentHash === 'string',
        ),
        'prepare reports per-memory content hashes',
      );

      const content = '# Essence\n\nUse tokens for auth.';
      const stored = await callSystemTool(tools, 'organize_memories', {
        content,
        sources: ['auth-flow'],
        prepareToken: prepared.prepareToken,
      });
      assert.strictEqual(stored.success, true, `store succeeded: ${stored.error ?? ''}`);
      assert.strictEqual(stored.revision, 1, 'the first store is revision 1');

      const essenceFile = path.join(storeRoot, 'essence', 'essence.md');
      const parsed = parseFrontmatter(fs.readFileSync(essenceFile, 'utf8'));
      assert(parsed);
      assert.strictEqual(parsed.frontmatter.schemaVersion, 1);
      assert.strictEqual(parsed.frontmatter.revision, 1);
      assert.strictEqual(parsed.frontmatter.generator, 'agent');
      assert.strictEqual(typeof parsed.frontmatter.generatedAt, 'string');
      const sources = parsed.frontmatter.sources as unknown as string[];
      assert(
        Array.isArray(sources) && sources.some((s) => String(s).startsWith('memory/decisions/auth-flow.md')),
        'sources record the memory path, revision and hash',
      );

      // The token is single-use: after a store the essence itself changed,
      // so replaying the same token must conflict instead of overwriting.
      const replay = await callSystemTool(tools, 'organize_memories', {
        content,
        prepareToken: prepared.prepareToken,
      });
      assert.strictEqual(replay.success, false, 'a used token cannot store twice');
      assert.strictEqual(replay.stage, 'conflict');

      // A fresh prepare/store round bumps the revision and archives history.
      const reprepared = await callSystemTool(tools, 'organize_memories', {});
      assert.notStrictEqual(reprepared.prepareToken, prepared.prepareToken);
      const second = await callSystemTool(tools, 'organize_memories', {
        content,
        prepareToken: reprepared.prepareToken,
      });
      assert.strictEqual(second.success, true);
      assert.strictEqual(second.revision, 2, 'revision increments');
      const historyDir = path.join(storeRoot, 'essence', 'history');
      assert(fs.existsSync(historyDir), 'the previous version was archived');
      const historyFiles = fs.readdirSync(historyDir);
      assert.strictEqual(historyFiles.length, 1, 'one history copy after two stores');

      // External memory edit between prepare and store -> conflict.
      const memPath = ctx.memoryStore.resolveFilePath('memory/decisions', 'auth-flow');
      const raw = fs.readFileSync(memPath, 'utf8');
      fs.writeFileSync(memPath, raw.replace('use tokens', 'use sessions'), 'utf8');

      const conflicted = await callSystemTool(tools, 'organize_memories', {
        content,
        prepareToken: reprepared.prepareToken,
      });
      assert.strictEqual(conflicted.success, false, 'stale tokens are rejected');
      assert.strictEqual(conflicted.stage, 'conflict');
      assert.strictEqual(conflicted.reason, 'workspace-state-changed');
      assert.notStrictEqual(
        conflicted.currentPrepareToken,
        reprepared.prepareToken,
        'the external edit invalidated the token',
      );

      // Re-prepare returns a fresh token that stores cleanly.
      const freshPrepared = await callSystemTool(tools, 'organize_memories', {});
      assert.notStrictEqual(freshPrepared.prepareToken, reprepared.prepareToken);
      const final = await callSystemTool(tools, 'organize_memories', {
        content,
        prepareToken: freshPrepared.prepareToken,
      });
      assert.strictEqual(final.success, true);
      assert.strictEqual(final.revision, 3);
    },
  },
  {
    name: 'journal/crash-recovery',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-journal-');

      // A worker crashes (hard exit) right after the Markdown write: the
      // journal must show a prepared entry, the index must be stale.
      const crashed = await runWorker(
        storeRoot,
        ['remember-tool', 'crashed-entry', 'written before the crash'],
        { KIMI_MEMORY_FAULT: 'remember.after-file-write:crash' },
      );
      assert.strictEqual(crashed.code, 70, 'the fault hook exits the worker');

      const file = new MemoryStore(storeRoot).resolveFilePath('memory', 'crashed-entry');
      assert(fs.existsSync(file), 'the Markdown authority was written before the crash');

      const journal = new WorkspaceJournal(storeRoot);
      assert.strictEqual(journal.list().length, 1, 'one prepared journal entry remains');

      // Recovery reconciles the derived stores and clears the journal.
      const indexDao = new IndexDao(storeRoot);
      const recovery = await journal.recover(() => indexDao.reconcileIndex());
      assert.strictEqual(recovery.recovered.length, 1);
      assert.strictEqual(recovery.recovered[0].op, 'remember');
      assert.strictEqual(recovery.recovered[0].targetPath, 'memory/crashed-entry.md');
      assert.strictEqual(journal.list().length, 0, 'the journal is clean after recovery');

      const entry = indexDao.getIndex().index['memory/crashed-entry.md'];
      assert(entry, 'the index knows the recovered entry');

      // A second clean startup reports nothing.
      const second = await journal.recover(() => indexDao.reconcileIndex());
      assert.deepStrictEqual(
        { recovered: second.recovered.length, failed: second.failed.length },
        { recovered: 0, failed: 0 },
      );
    },
  },
  {
    name: 'index/structure-hash-size-sensitive',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-hash-');
      const store = new MemoryStore(storeRoot);
      const reconciler = new IndexReconciler(storeRoot, new IndexStore(storeRoot));

      const file = store.resolveFilePath('memory', 'hashcheck');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'same-mtime-different-size', 'utf8');
      // Pin the mtime so only the size can differ between the checks.
      fs.utimesSync(file, new Date(), new Date(2024, 0, 1));
      const hashBefore = reconciler.computeStructureHash();

      // Same mtime, different size: the hash must change.
      fs.writeFileSync(file, 'same-mtime-different-size-v2', 'utf8');
      fs.utimesSync(file, new Date(), new Date(2024, 0, 1));
      const hashAfter = reconciler.computeStructureHash();
      assert.notStrictEqual(
        hashBefore,
        hashAfter,
        'size changes are detected even when the mtime is pinned',
      );

      // Same mtime and size: the hash stays stable (no false positives).
      fs.writeFileSync(file, 'same-mtime-different-size', 'utf8');
      fs.utimesSync(file, new Date(), new Date(2024, 0, 1));
      assert.strictEqual(
        reconciler.computeStructureHash(),
        hashBefore,
        'identical structure yields an identical hash',
      );
    },
  },
  {
    name: 'memory/symlink-escape-rejected',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-symlink-');
      const store = new MemoryStore(storeRoot);

      // A memory path that is a symlink pointing outside the store must not
      // be writable (or overwritable). Symlink creation may require elevated
      // privileges on Windows; the test degrades to a no-op there.
      const outside = path.join(path.dirname(storeRoot), 'symlink-outside-secret.md');
      fs.writeFileSync(outside, 'secret', 'utf8');
      fs.mkdirSync(path.join(storeRoot, 'memory'), { recursive: true });
      const linkPath = path.join(storeRoot, 'memory', 'escape.md');
      let created = false;
      try {
        fs.symlinkSync(outside, linkPath, 'file');
        created = true;
      } catch {
        // Skip on systems without symlink privileges.
      }
      if (created) {
        assert.throws(
          () => store.writeWithResult('memory', 'escape', 'overwritten', []),
          'writing over a symlink escape is rejected',
        );
        assert.strictEqual(
          fs.readFileSync(outside, 'utf8'),
          'secret',
          'the file outside the store is untouched',
        );
        // Reads refuse to follow the link out of the store as well.
        const detail = store.readDetailed('memory', 'escape');
        assert.strictEqual(detail.status, 'corrupt');
        assert(/symbolic link/.test(String(detail.error)), 'the diagnosis names the symlink escape');
        assert.throws(
          () => store.deleteWithResult('memory', 'escape'),
          'deleting through a symlink escape is rejected before a trash copy is made',
        );
        assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'secret');
        assert.strictEqual(store.listTrash().length, 0);
        fs.unlinkSync(linkPath);

        const outsideDir = path.join(path.dirname(storeRoot), 'symlink-outside-dir');
        const outsideNested = path.join(outsideDir, 'nested');
        const outsideMemory = path.join(outsideNested, 'victim.md');
        fs.mkdirSync(outsideNested, { recursive: true });
        fs.writeFileSync(outsideMemory, 'outside memory', 'utf8');
        const linkedDir = path.join(storeRoot, 'memory', 'linked');
        let dirCreated = false;
        try {
          fs.symlinkSync(outsideNested, linkedDir, 'dir');
          dirCreated = true;
        } catch {
          // Skip on systems without symlink privileges.
        }
        if (dirCreated) {
          assert.throws(
            () => store.deleteWithResult('memory/linked', 'victim'),
            'an intermediate directory symlink cannot escape the store',
          );
          assert.strictEqual(fs.readFileSync(outsideMemory, 'utf8'), 'outside memory');
          assert.strictEqual(store.listTrash().length, 0);
          fs.unlinkSync(linkedDir);
        }
        fs.rmSync(outsideDir, { recursive: true, force: true });
      }
      fs.rmSync(outside, { force: true });
    },
  },
  {
    name: 'refine/concurrent-sqlite-writers',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-sqlite-');

      // Three writers hammer the same database in separate processes. Busy
      // timeouts must absorb the contention; no write may be lost.
      const writers = [
        runWorker(storeRoot, ['refine-write', 'session_a', '40', 'A']),
        runWorker(storeRoot, ['refine-write', 'session_b', '40', 'B']),
        runWorker(storeRoot, ['refine-write', 'session_c', '40', 'C']),
      ];
      const results = await Promise.all(writers);
      for (const result of results) {
        assert.strictEqual(result.code, 0, `writer exited cleanly: ${result.stderr.slice(0, 200)}`);
        const parsed = JSON.parse(result.stdout || '{}') as { ok: boolean; saved: number };
        assert.strictEqual(parsed.ok, true);
        assert.strictEqual(parsed.saved, 40);
      }

      const counter = await runWorker(storeRoot, ['refine-count']);
      const counted = JSON.parse(counter.stdout || '{}') as { count: number };
      assert.strictEqual(counted.count, 120, 'all three writers are present');

      // Writers on the same session: rows are upserted, not duplicated.
      const sameSession = await Promise.all([
        runWorker(storeRoot, ['refine-write', 'session_shared', '25', 'first']),
        runWorker(storeRoot, ['refine-write', 'session_shared', '25', 'second']),
      ]);
      for (const result of sameSession) {
        assert.strictEqual(result.code, 0, `shared-session writer exited cleanly: ${result.stderr.slice(0, 200)}`);
      }
      const finalCount = JSON.parse(
        (await runWorker(storeRoot, ['refine-count'])).stdout || '{}',
      ) as { count: number };
      assert.strictEqual(finalCount.count, 145, 'shared rows are upserted exactly once per turn');
    },
  },
  {
    name: 'themes/corrupt-structure-rejected',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-theme-corrupt-');
      const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
      fs.mkdirSync(path.join(storeRoot, 'themes'), { recursive: true });
      const themePath = path.join(storeRoot, 'themes', 'broken.json');
      fs.writeFileSync(themePath, JSON.stringify({ schemaVersion: 1, theme: 'broken' }), 'utf8');
      assert.throws(() => themeManager.loadTheme('broken'), CorruptDataError);
      await assert.rejects(
        () => themeManager.addThemeAssociation('broken', { memoryKey: 'x', folder: 'memory' }),
        CorruptDataError,
        'a malformed theme is never replaced with a blank association',
      );
      assert.strictEqual(JSON.parse(fs.readFileSync(themePath, 'utf8')).theme, 'broken');
    },
  },
  {
    name: 'themes/future-version-protected',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-theme-future-');
      const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
      fs.mkdirSync(path.join(storeRoot, 'themes'), { recursive: true });
      const themePath = path.join(storeRoot, 'themes', 'fromfuture.json');
      fs.writeFileSync(
        themePath,
        JSON.stringify({
          theme: 'fromfuture',
          displayName: 'From The Future',
          schemaVersion: 99,
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          turns: [],
          memories: [{ folder: 'memory', key: 'precious', title: 'Precious', status: 'active' }],
        }),
        'utf8',
      );

      // An older binary must not read the newer file…
      assert.strictEqual(themeManager.loadTheme('fromfuture'), null);
      // …and must refuse to overwrite it with a blank association.
      await assert.rejects(
        () => themeManager.addThemeAssociation('fromfuture', { memoryKey: 'x', folder: 'memory', title: 'X' }),
        UnsupportedVersionError,
        'a newer-schema theme is never silently overwritten',
      );
      const raw = JSON.parse(fs.readFileSync(themePath, 'utf8'));
      assert.strictEqual(raw.schemaVersion, 99, 'the future file is untouched');
      assert.strictEqual(raw.memories[0].key, 'precious', 'the newer data survives');
    },
  },
  {
    name: 'purge/derived-data-report',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-purge-');
      const ctx = makeCtx(storeRoot);

      // Authority data that must survive.
      ctx.memoryStore.writeWithResult('memory', 'keeper', 'authoritative content', ['keep']);
      fs.mkdirSync(path.join(storeRoot, 'essence'), { recursive: true });
      fs.writeFileSync(path.join(storeRoot, 'essence', 'essence.md'), '# Essence', 'utf8');

      // Derived data that must go.
      ctx.memoryStore.writeWithResult('memory', 'gone', 'temporary', []);
      await callTool(createMemoryTools(ctx), 'delete', { key: 'gone' }); // creates trash/
      fs.mkdirSync(path.join(storeRoot, 'searches'), { recursive: true });
      fs.writeFileSync(
        path.join(storeRoot, 'searches', 'search-v2-0123456789abcdef0123456789abcdef.json'),
        '{}',
        'utf8',
      );
      fs.mkdirSync(path.join(storeRoot, '.journal'), { recursive: true });
      fs.writeFileSync(path.join(storeRoot, '.journal', 'op-1.json'), '{}', 'utf8');
      fs.mkdirSync(path.join(storeRoot, 'themes'), { recursive: true });
      fs.writeFileSync(
        path.join(storeRoot, 'themes', 'some-theme.json'),
        JSON.stringify({ theme: 'some-theme' }),
        'utf8',
      );
      new RefinedManager(path.join(storeRoot, 'refined')).close();

      const lock = new WorkspaceLock(workspaceLockRoot(storeRoot));
      const guardPath = `${lock.lockPath(WORKSPACE_LOCK_KEY)}.claim-${process.pid}-active`;
      const now = new Date().toISOString();
      fs.mkdirSync(path.dirname(guardPath), { recursive: true });
      fs.writeFileSync(
        guardPath,
        JSON.stringify({
          version: 1,
          key: WORKSPACE_LOCK_KEY,
          pid: process.pid,
          hostname: 'test-host',
          ownerToken: 'active-claim',
          createdAt: now,
          heartbeatAt: now,
          leaseExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      );
      assert.throws(
        () => purgeDerivedData(storeRoot),
        /Refusing to purge/,
        'an active claim guard blocks purge even while the main lock is captured',
      );
      fs.unlinkSync(guardPath);

      const report = purgeDerivedData(storeRoot, { assumeLocked: true });

      const byCategory = (category: string) =>
        report.removed.find((item) => item.category.startsWith(category))?.removed ?? -1;
      assert(byCategory('trash') >= 1, 'the trash copy was removed');
      assert.strictEqual(byCategory('search views'), 1);
      // The delete above also journaled its own (committed) entry.
      assert(byCategory('write journal') >= 1);
      assert.strictEqual(byCategory('themes'), 1);
      assert(byCategory('refined turns') >= 1, 'the SQLite files were removed');

      assert(fs.existsSync(path.join(storeRoot, 'memory', 'keeper.md')), 'authority data survives');
      assert(fs.existsSync(path.join(storeRoot, 'essence', 'essence.md')), 'the essence survives');
      // clearDirectory removes the contents; the (now empty) directory remains.
      const searchesDir = path.join(storeRoot, 'searches');
      const searchFilesLeft = fs.existsSync(searchesDir) ? fs.readdirSync(searchesDir).length : 0;
      assert.strictEqual(searchFilesLeft, 0, 'search views are gone');
      assert.strictEqual(report.kept.length, 4, 'the report lists the kept authority data');

      // A live workspace lock must refuse the purge.
      const lockRoot = workspaceLockRoot(storeRoot);
      fs.mkdirSync(lockRoot, { recursive: true });
      fs.writeFileSync(
        path.join(lockRoot, 'foreign.lock'),
        JSON.stringify({
          version: 1,
          key: 'workspace',
          pid: process.pid,
          hostname: 'test',
          ownerToken: 'foreign-token',
          createdAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        }),
        'utf8',
      );
      assert.throws(
        () => purgeDerivedData(storeRoot),
        /workspace lock/,
        'a live lock refuses the purge',
      );
      fs.unlinkSync(path.join(lockRoot, 'foreign.lock'));
    },
  },
  {
    name: 'validation/reserved-device-names',
    run: async () => {
      assert.throws(() => assertValidKey('CON'), InvalidKeyError);
      assert.throws(() => assertValidKey('com1'), InvalidKeyError);
      assert.throws(() => assertValidKey('PRN.notes'), InvalidKeyError);
      assert.doesNotThrow(() => assertValidKey('console'), 'a prefix is not a device name');
      const storeRoot = makeTempDir('kimi-storage-reserved-');
      const store = new MemoryStore(storeRoot);
      assert.throws(
        () => store.writeWithResult('memory', 'con', 'x', []),
        InvalidKeyError,
        'remember rejects reserved device names',
      );
    },
  },
  {
    name: 'errors/taxonomy',
    run: async () => {
      const enoent = Object.assign(new Error('no file'), { code: 'ENOENT' });
      const mapped = toStorageError(enoent, 'recall');
      assert.strictEqual(mapped.code, 'not_found');
      assert.strictEqual(mapped.statusCode, 404);

      const eacces = Object.assign(new Error('no access'), { code: 'EACCES' });
      assert.strictEqual(toStorageError(eacces, 'write').code, 'permission_denied');

      const corrupt = new MemoryCorruptError('x.md', new Error('bad yaml'));
      assert.strictEqual(toStorageError(corrupt, 'read').code, 'corrupt_data');

      const http = errorToHttpStatus(eacces);
      assert.deepStrictEqual(
        { status: http.statusCode, code: http.code },
        { status: 403, code: 'permission_denied' },
      );
    },
  },
  {
    name: 'themes/schema-version',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-theme-schema-');
      const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
      await themeManager.addThemeAssociation('governed', {
        memoryKey: 'k1',
        folder: 'memory',
        title: 'K1',
      });
      const raw = JSON.parse(fs.readFileSync(path.join(storeRoot, 'themes', 'governed.json'), 'utf8'));
      assert.strictEqual(raw.schemaVersion, 1, 'new theme files carry schemaVersion');

      // A legacy file without schemaVersion loads fine and is upgraded on
      // the next save.
      fs.writeFileSync(
        path.join(storeRoot, 'themes', 'legacy.json'),
        JSON.stringify({
          theme: 'legacy',
          displayName: 'Legacy',
          createdAt: '2024-01-01T00:00:00.000Z',
          updatedAt: '2024-01-01T00:00:00.000Z',
          turns: [],
          memories: [{ folder: 'memory', key: 'k2', title: 'K2', status: 'active' }],
        }),
        'utf8',
      );
      assert(themeManager.loadTheme('legacy'), 'the legacy theme loads');
      await themeManager.addThemeAssociation('legacy', { memoryKey: 'k3', folder: 'memory', title: 'K3' });
      const upgraded = JSON.parse(fs.readFileSync(path.join(storeRoot, 'themes', 'legacy.json'), 'utf8'));
      assert.strictEqual(upgraded.schemaVersion, 1, 'the legacy theme is stamped on save');
    },
  },
  {
    name: 'index/stale-state-and-freshness',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-stale-');
      const indexDao = new IndexDao(storeRoot);

      assert.strictEqual(indexDao.getIndexState().state, 'empty');

      const store = new MemoryStore(storeRoot);
      store.writeWithResult('memory', 'fresh-a', 'content a', []);
      await indexDao.reconcileIndex();
      indexDao.invalidateFreshness();
      assert.strictEqual(indexDao.getIndexState().state, 'fresh');

      // External write on disk (not through the index) makes the index stale.
      store.writeWithResult('memory', 'fresh-b', 'content b', []);
      indexDao.invalidateFreshness();
      assert.strictEqual(
        indexDao.getIndexState().state,
        'stale',
        'an external file is detected as index drift',
      );

      const outcome = await indexDao.reconcileIndex();
      assert.strictEqual(outcome.synced, true);
      indexDao.invalidateFreshness();
      assert.strictEqual(indexDao.getIndexState().state, 'fresh', 'reconcile clears the stale state');
    },
  },
  {
    name: 'tools/remember-body-limit',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-limit-');
      const ctx = makeCtx(storeRoot);
      const tools = createMemoryTools(ctx);
      const oversized = 'x'.repeat(1024 * 1024 + 1);
      const rejected = await callTool(tools, 'remember', { key: 'big', content: oversized });
      assert.strictEqual(rejected.success, false);
      assert(/exceeds/.test(String(rejected.error)));
    },
  },
  {
    name: 'essence/rollback',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-rollback-');
      const ctx = makeCtx(storeRoot);
      const tools = createSystemTools(ctx);

      const v1 = '# Essence v1\n\noriginal content';
      const first = await callSystemTool(tools, 'organize_memories', { content: v1 });
      assert.strictEqual(first.success, true);
      assert.strictEqual(first.revision, 1);

      const v2 = '# Essence v2\n\nreorganized content';
      const second = await callSystemTool(tools, 'organize_memories', { content: v2 });
      assert.strictEqual(second.revision, 2);

      // Roll back to revision 1: the body returns, the revision stays monotonic.
      const rolled = await callSystemTool(tools, 'rollback_essence', { revision: 1 });
      assert.strictEqual(rolled.success, true, `rollback succeeded: ${rolled.error ?? ''}`);
      assert.strictEqual(rolled.restoredFrom, 1);
      assert.strictEqual(rolled.toRevision, 3, 'rollback archives the current and bumps the revision');

      const essence = fs.readFileSync(path.join(storeRoot, 'essence', 'essence.md'), 'utf8');
      assert(essence.includes('original content'), 'the v1 body is restored');
      assert(/generator: "rollback"/.test(essence), 'the rollback is recorded in the frontmatter');

      // Rolling back again without arguments targets the newest archive (v2).
      const again = await callSystemTool(tools, 'rollback_essence', {});
      assert.strictEqual(again.success, true);
      const essenceAfter = fs.readFileSync(path.join(storeRoot, 'essence', 'essence.md'), 'utf8');
      assert(essenceAfter.includes('reorganized content'), 'the default rollback restores the newest archive');

      // Rolling back to a non-existent revision fails clearly — and must
      // NOT leave a committed journal entry behind (review follow-up #2).
      const journalBefore = new WorkspaceJournal(storeRoot).list().length;
      const missing = await callSystemTool(tools, 'rollback_essence', { revision: 99 });
      assert.strictEqual(missing.success, false);
      assert(/No history copy/.test(String(missing.error)));
      const journalAfter = new WorkspaceJournal(storeRoot).list().length;
      assert.strictEqual(
        journalAfter,
        journalBefore,
        'a failed rollback does not produce a committed journal entry',
      );
    },
  },
  {
    name: 'maintenance/doctor-export-prune',
    run: async () => {
      const storeRoot = makeTempDir('kimi-storage-maint-');
      const store = new MemoryStore(storeRoot);
      store.writeWithResult('memory', 'modern', 'with identity', []);
      // Legacy memory without identity fields.
      const legacyFile = path.join(storeRoot, 'memory', 'legacy.md');
      fs.writeFileSync(
        legacyFile,
        ['---', "key: 'legacy'", "title: 'Legacy'", '---', '', 'legacy body'].join('\n'),
        'utf8',
      );
      // Trash copy backdated beyond the retention window.
      const removed = store.deleteWithResult('memory', 'modern');
      assert(removed?.trashPath);
      const trashParsed = parseFrontmatter(fs.readFileSync(removed.trashPath!, 'utf8'));
      const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      const backdated = stringifyFrontmatter({
        ...(trashParsed?.frontmatter ?? {}),
        deletedAt: oldDate,
      }) + (trashParsed?.body ?? '');
      fs.writeFileSync(removed.trashPath!, backdated, 'utf8');

      const indexDao = new IndexDao(storeRoot);
      const report = doctorReport(storeRoot, () => indexDao.getIndexState());
      assert.strictEqual(report.memories.missingId, 1, 'the legacy memory is reported');
      assert(report.pendingActions.some((a) => /backfill stable ids/.test(a)), 'the doctor lists the backfill action');
      assert.strictEqual(report.trash.entries, 1);

      // Export copies the authoritative data only.
      const exportDir = path.join(storeRoot, '..', 'export-target');
      const exportReport = exportWorkspaceData(storeRoot, exportDir);
      assert(fs.existsSync(path.join(exportDir, 'memory', 'legacy.md')));
      assert.strictEqual(exportReport.copied.find((c) => c.category === 'memory')?.files, 1);

      fs.writeFileSync(path.join(exportDir, 'memory', 'stale.md'), 'stale', 'utf8');
      const externalDir = path.join(storeRoot, '..', 'export-external');
      fs.mkdirSync(externalDir, { recursive: true });
      fs.writeFileSync(path.join(externalDir, 'outside.md'), 'outside', 'utf8');
      fs.symlinkSync(
        externalDir,
        path.join(storeRoot, 'memory', 'linked'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const secondExport = exportWorkspaceData(storeRoot, exportDir);
      assert(!fs.existsSync(path.join(exportDir, 'memory', 'stale.md')), 'stale export files are removed');
      assert(!fs.existsSync(path.join(exportDir, 'memory', 'linked')), 'source links are not copied');
      assert(secondExport.skipped.some((entry) => entry.includes('memory/linked')));

      const rootLinkTmp = makeTempDir('kimi-storage-root-links-');
      const linkedStore = path.join(rootLinkTmp, 'store');
      fs.mkdirSync(linkedStore, { recursive: true });
      fs.symlinkSync(
        externalDir,
        path.join(linkedStore, 'memory'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const linkedExport = path.join(rootLinkTmp, 'export');
      const linkedReport = exportWorkspaceData(linkedStore, linkedExport);
      assert(!fs.existsSync(path.join(linkedExport, 'memory', 'outside.md')), 'a source category root link is never followed');
      assert(linkedReport.skipped.some((entry) => entry.startsWith('memory (symbolic link')));

      const actualTarget = path.join(rootLinkTmp, 'actual-target');
      fs.mkdirSync(actualTarget, { recursive: true });
      const targetLink = path.join(rootLinkTmp, 'target-link');
      fs.symlinkSync(actualTarget, targetLink, process.platform === 'win32' ? 'junction' : 'dir');
      assert.throws(() => exportWorkspaceData(storeRoot, targetLink), /must not contain symbolic links/);
      assert(!fs.existsSync(path.join(actualTarget, 'memory', 'legacy.md')), 'a destination root link is never followed');

      const parentLink = path.join(rootLinkTmp, 'parent-link');
      fs.symlinkSync(actualTarget, parentLink, process.platform === 'win32' ? 'junction' : 'dir');
      const nestedTarget = path.join(parentLink, 'new-export');
      assert.throws(() => exportWorkspaceData(storeRoot, nestedTarget), /must not contain symbolic links/);
      assert(!fs.existsSync(path.join(actualTarget, 'new-export', 'memory', 'legacy.md')), 'a destination parent link is never followed');

      const overlapStore = path.join(rootLinkTmp, 'overlap-store');
      fs.mkdirSync(path.join(overlapStore, 'memory', 'export-parent'), { recursive: true });
      fs.writeFileSync(path.join(overlapStore, 'memory', 'entry.md'), 'entry', 'utf8');
      const overlapAlias = path.join(rootLinkTmp, 'overlap-alias');
      fs.symlinkSync(overlapStore, overlapAlias, process.platform === 'win32' ? 'junction' : 'dir');
      const aliasedSourceTarget = path.join(overlapAlias, 'memory', 'export-parent', 'export');
      assert.throws(() => exportWorkspaceData(overlapStore, aliasedSourceTarget), /must not overlap/);
      assert(!fs.existsSync(path.join(overlapStore, 'memory', 'export-parent', 'export', 'memory', 'entry.md')), 'an alias cannot hide source/target overlap');

      if (process.platform !== 'win32') {
        const brokenDestination = path.join(exportDir, 'memory', 'legacy.md');
        const outsideTarget = path.join(exportDir, 'must-not-be-created.md');
        fs.rmSync(brokenDestination);
        fs.symlinkSync(outsideTarget, brokenDestination, 'file');
        exportWorkspaceData(storeRoot, exportDir);
        assert(!fs.lstatSync(brokenDestination).isSymbolicLink(), 'a broken destination link is replaced');
        assert(!fs.existsSync(outsideTarget), 'a broken destination link is never followed');

        const indexStore = makeTempDir('kimi-storage-index-link-');
        fs.mkdirSync(indexStore, { recursive: true });
        fs.writeFileSync(path.join(indexStore, 'index-real.json'), '{}', 'utf8');
        fs.symlinkSync(path.join(indexStore, 'index-real.json'), path.join(indexStore, 'index.json'), 'file');
        const indexExport = path.join(indexStore, 'export');
        const indexReport = exportWorkspaceData(indexStore, indexExport);
        assert(!fs.existsSync(path.join(indexExport, 'index.json')), 'an index source link is never followed');
        assert(indexReport.skipped.some((entry) => entry.startsWith('index.json (symbolic link')));
      }

      assert.throws(
        () => exportWorkspaceData(storeRoot, path.join(storeRoot, 'memory', 'export')),
        /must not overlap/,
        'an export destination inside a source tree is rejected before copying',
      );
      assert(!fs.existsSync(path.join(storeRoot, 'memory', 'export')));

      // Retention pruning removes the backdated trash copy only.
      const prune = pruneByRetention(storeRoot, 30);
      assert.strictEqual(prune.trashRemoved, 1, 'the backdated trash entry is pruned');
      assert(!fs.existsSync(removed.trashPath!));

      // A prepared journal entry is NEVER pruned by age: it is the only
      // recovery clue for an interrupted write (review P2 #3).
      const journal = new WorkspaceJournal(storeRoot);
      const entry = journal.prepare('remember', { targetPath: 'memory/pending.md' });
      const entryPath = path.join(storeRoot, '.journal', `${entry.operationId}.json`);
      const rawEntry = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
      rawEntry.createdAt = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
      fs.writeFileSync(entryPath, JSON.stringify(rawEntry), 'utf8');
      const prune2 = pruneByRetention(storeRoot, 30);
      assert.strictEqual(prune2.journalRemoved, 0, 'prepared entries survive retention pruning');
      assert(fs.existsSync(entryPath), 'the prepared recovery clue is kept');

      // Backup snapshot keeps the authoritative data and prunes old ones.
      const { report: backupReport } = backupWorkspaceData(storeRoot, 2);
      assert(fs.existsSync(backupReport.targetDir));
    },
  },
  {
    name: 'background/indexer-drains-lag',
    run: async () => {
      const tmp = makeTempDir('kimi-storage-bgindex-');
      const sessionsRoot = path.join(tmp, 'sessions');
      const slugDir = `wd_bg_${computeWorkspaceHash(process.cwd().replace(/\\/g, '/'))}`;
      const wireDir = path.join(sessionsRoot, slugDir, 'session_bg_0001', 'agents', 'main');
      fs.mkdirSync(wireDir, { recursive: true });
      const lines: string[] = [];
      for (let i = 0; i < 5; i++) {
        const time = '2024-05-01T10:00:00.000Z';
        lines.push(JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: `bg probe ${i}` }], time }));
        lines.push(JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: i }, time }));
        lines.push(JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', turnId: i, part: { type: 'text', text: `bg answer ${i}` } }, time }));
      }
      fs.writeFileSync(path.join(wireDir, 'wire.jsonl'), `${lines.join('\n')}\n`, 'utf8');

      const previousSessionsRoot = process.env.MEMORY_SESSIONS_ROOT;
      process.env.MEMORY_SESSIONS_ROOT = sessionsRoot;
      try {
      const storeRoot = path.join(tmp, 'store');
      fs.mkdirSync(storeRoot, { recursive: true });
      const ctx = makeCtx(storeRoot);
      const refinedRoot = path.join(storeRoot, 'refined');
      ctx.refinedManager = new RefinedManager(refinedRoot);

        const indexer = new BackgroundIndexer(
          refinedRoot,
          // Workspace-scoped discovery, exactly like the search uses.
          () => findAllWorkspaceSessions().map((s) => ({ sessionId: s.sessionId, wire: s.wire })),
          (session, budget, signal) => refineSessionBatch(ctx, session, budget, signal),
          { intervalMs: 3_600_000, budgetTurns: 3 },
        );

        const lagBefore = await indexer.measureLag();
        assert.strictEqual(lagBefore, 5, 'five turns are unrefined');

        // A session in a foreign workspace (different slug hash) must be
        // invisible to this store's indexer.
        const foreignSlug = `wd_foreign_${'f'.repeat(12)}`;
        const foreignDir = path.join(sessionsRoot, foreignSlug, 'session_foreign_0001', 'agents', 'main');
        fs.mkdirSync(foreignDir, { recursive: true });
        const foreignLines: string[] = [];
        for (let i = 0; i < 7; i++) {
          const time = '2024-06-01T10:00:00.000Z';
          foreignLines.push(JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: `foreign probe ${i}` }], time }));
          foreignLines.push(JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: i }, time }));
          foreignLines.push(JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', turnId: i, part: { type: 'text', text: `foreign answer ${i}` } }, time }));
        }
        fs.writeFileSync(path.join(foreignDir, 'wire.jsonl'), `${foreignLines.join('\n')}\n`, 'utf8');
        assert.strictEqual(await indexer.measureLag(), 5, 'the foreign session is not counted');

        const refined = await indexer.runTick();
        assert.strictEqual(refined, 3, 'the tick respects the per-tick budget');

        const refinedAfter = indexer.runTick().then((n) => n);
        const second = await refinedAfter;
        assert.strictEqual(second, 2, 'the next tick drains the remaining lag');

        const lagAfter = await indexer.measureLag();
        assert.strictEqual(lagAfter, 0, 'the lag gauge reaches zero');

        // An already-drained session contributes nothing.
        const empty = await indexer.runTick();
        assert.strictEqual(empty, 0);

        await ctx.refinedManager.deleteRefinedTurns([{ sessionId: 'session_bg_0001', turnId: 0 }]);
        const rebuilt = await indexer.runTick();
        assert.strictEqual(rebuilt, 1, 'deleting a refined row invalidates the unchanged-wire shortcut');

        fs.appendFileSync(
          path.join(wireDir, 'wire.jsonl'),
          `${JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', turnId: 0, part: { type: 'text', text: 'late answer update' } }, time: '2024-05-01T10:00:00.000Z' })}\n`,
          'utf8',
        );
        assert.strictEqual(await indexer.measureLag(), 1, 'a changed existing turn counts as lag');
        assert.strictEqual(await indexer.runTick(), 1);

        const db = new DatabaseSync(ctx.refinedManager.getDbPath());
        db.prepare('UPDATE refined_turns SET extractor_version = ? WHERE session_id = ? AND turn_id = ?').run('0', 'session_bg_0001', 0);
        db.close();
        assert.strictEqual(await indexer.measureLag(), 1, 'an old extractor row counts as lag');
        assert.strictEqual(await indexer.runTick(), 1);
        assert.strictEqual(await indexer.measureLag(), 0);
      } finally {
        if (previousSessionsRoot === undefined) delete process.env.MEMORY_SESSIONS_ROOT;
        else process.env.MEMORY_SESSIONS_ROOT = previousSessionsRoot;
      }
    },
  },
  {
    name: 'wire/malformed-events-are-skipped',
    run: async () => {
      const tmp = makeTempDir('kimi-storage-wireguard-');
      const wire = path.join(tmp, 'wire.jsonl');
      const time = '2024-05-01T10:00:00.000Z';
      const lines = [
        JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'valid question' }], time }),
        JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', turnId: 0, part: { type: 'text', text: 'valid answer' } }, time }),
        'null',
        JSON.stringify({ type: 'turn.prompt', input: 'not-an-array', time }),
        JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', turnId: 1, part: { type: 'text', text: 'second answer' } }, time }),
        '{truncated',
      ];
      fs.writeFileSync(wire, `${lines.join('\n')}\n`, 'utf8');
      const parsed = await parseWireFile(wire);
      assert.strictEqual(parsed.turns.length, 2);
      assert.strictEqual(parsed.turns[0].agentText, 'valid answer');
      assert.strictEqual(parsed.turns[1].agentText, 'second answer');
    },
  },
  {
    name: 'background/refreshes-changed-and-orphaned-turns',
    run: async () => {
      const tmp = makeTempDir('kimi-storage-bgfresh-');
      const storeRoot = path.join(tmp, 'store');
      const wire = path.join(tmp, 'wire.jsonl');
      fs.mkdirSync(storeRoot, { recursive: true });
      const ctx = makeCtx(storeRoot);
      ctx.refinedManager = new RefinedManager(path.join(storeRoot, 'refined'));
      const session = { sessionId: 'session_freshness', wire };
      const time = '2024-05-01T10:00:00.000Z';
      const writeTurns = (turns: Array<{ user: string; answer?: string }>) => {
        const lines: string[] = [];
        turns.forEach((turn, turnId) => {
          lines.push(JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: turn.user }], time }));
          if (turn.answer !== undefined) {
            lines.push(JSON.stringify({
              type: 'context.append_loop_event',
              event: { type: 'content.part', turnId, part: { type: 'text', text: turn.answer } },
              time,
            }));
          }
        });
        fs.writeFileSync(wire, `${lines.join('\n')}\n`, 'utf8');
      };

      writeTurns([{ user: 'question before completion' }]);
      assert.strictEqual(await refineSessionBatch(ctx, session, 10), 1);
      assert(!ctx.refinedManager.loadRefinedTurn(session.sessionId, 0)?.summary.includes('finished answer'));

      writeTurns([{ user: 'question before completion', answer: 'finished answer with fresh details' }]);
      assert.strictEqual(await refineSessionBatch(ctx, session, 10), 1, 'a completed turn must refresh its existing row');
      assert(ctx.refinedManager.loadRefinedTurn(session.sessionId, 0)?.summary.includes('finished answer'));

      writeTurns([
        { user: 'question before completion', answer: 'finished answer with fresh details' },
        { user: 'appended question', answer: 'appended answer' },
      ]);
      assert.strictEqual(await refineSessionBatch(ctx, session, 10), 1, 'an appended turn must refine incrementally');
      assert(ctx.refinedManager.loadRefinedTurn(session.sessionId, 1)?.summary.includes('appended answer'));
      const appendedProgress = ctx.refinedManager.getSessionProgress(session.sessionId);
      assert.strictEqual(appendedProgress?.lastCompleteLineOffset, fs.statSync(wire).size);
      assert(appendedProgress!.lastCompleteLineOffset > 0);

      writeTurns([
        { user: 'rewritten early question', answer: 'rewritten early answer with more content' },
        { user: 'appended question', answer: 'appended answer' },
        { user: 'third question', answer: 'third answer' },
      ]);
      assert.strictEqual(
        await refineSessionBatch(ctx, session, 10),
        2,
        'an early rewrite plus an append must fall back and refresh the early row',
      );
      assert(ctx.refinedManager.loadRefinedTurn(session.sessionId, 0)?.summary.includes('rewritten early answer'));
      assert(ctx.refinedManager.loadRefinedTurn(session.sessionId, 2)?.summary.includes('third answer'));
      assert.strictEqual(await refineSessionBatch(ctx, session, 10), 0, 'the repaired checkpoint must be stable');

      writeTurns([
        { user: 'rewritten early question', answer: 'rewritten after legacy checkpoint' },
        { user: 'appended question', answer: 'appended answer' },
        { user: 'third question', answer: 'third answer' },
      ]);
      const legacyStats = fs.statSync(wire, { bigint: true });
      const legacyProgress = ctx.refinedManager.getSessionProgress(session.sessionId)!;
      await ctx.refinedManager.saveSessionProgress({
        ...legacyProgress,
        lastSize: Number(legacyStats.size),
        lastMtimeNs: legacyStats.mtimeNs.toString(),
        wireIdentity: JSON.stringify({ turnCount: 3, contentHash: 'legacy-without-prefix-hash' }),
      });
      assert.strictEqual(
        await refineSessionBatch(ctx, session, 10),
        1,
        'a legacy checkpoint without a prefix hash must not hide stale rows',
      );
      assert(ctx.refinedManager.loadRefinedTurn(session.sessionId, 0)?.summary.includes('rewritten after legacy checkpoint'));
      assert.strictEqual(await refineSessionBatch(ctx, session, 10), 0);

      writeTurns([
        { user: 'rewound question', answer: 'rewound answer' },
      ]);
      assert.strictEqual(await refineSessionBatch(ctx, session, 10), 1);
      assert.strictEqual(ctx.refinedManager.loadRefinedTurns(session.sessionId).length, 1, 'orphaned rows must be removed');
      assert(ctx.refinedManager.loadRefinedTurn(session.sessionId, 0)?.summary.includes('rewound answer'));

      const db = new DatabaseSync(ctx.refinedManager.getDbPath());
      db.prepare('UPDATE refined_turns SET extractor_version = ? WHERE session_id = ?').run('0', session.sessionId);
      db.close();
      assert.strictEqual(await refineSessionBatch(ctx, session, 10), 1, 'old extractor rows must be rebuilt');
      assert.strictEqual(ctx.refinedManager.listRefinedTurnStates(session.sessionId)[0].extractorVersion, '1');
      assert.strictEqual(await refineSessionBatch(ctx, session, 10), 0, 'a fresh stable checkpoint must skip work');
      ctx.refinedManager.close();
    },
  },
];

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  for (const suite of suites) {
    try {
      await suite.run();
      console.log(`✓ ${suite.name}`);
      passed++;
    } catch (err) {
      failed++;
      console.error(`✗ ${suite.name}`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      if (err instanceof Error && err.stack) {
        console.error(err.stack.split('\n').slice(1, 4).join('\n  '));
      }
    }
  }

  cleanup();
  console.log(`\n${passed} suite(s) passed, ${failed} suite(s) failed`);
  if (failed > 0) process.exitCode = 1;
}

void main();
