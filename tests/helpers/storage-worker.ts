/**
 * Helper process for the storage concurrency tests.
 *
 * Usage: node --import tsx storage-worker.ts <storeRoot> <mode> [args...]
 *
 * Modes:
 *   write <key> <content>            — plain write under the workspace lock
 *   cas <key> <content> <expected>   — compare-and-swap write
 *   read-id <key>                    — print the stable id / revision
 *   hold-lock <ms>                   — hold the workspace lock for a while
 *   remember-tool <key> <content>    — write through the MCP remember handler
 *                                      (journal + fault injection enabled)
 *   refine-write <session> <count>   — save <count> refined turns to SQLite
 *   refine-count                     — print the total refined row count
 */

import fs from 'fs';
import path from 'path';
import { MemoryStore } from '../../src/dao/memory-store.js';
import { IndexDao } from '../../src/dao/index.js';
import { ThemeManager } from '../../src/theme-manager.js';
import { RefinedManager } from '../../src/refined-manager.js';
import { createMemoryTools } from '../../src/tools/memory-tools.js';
import {
  WorkspaceLock,
  WORKSPACE_LOCK_KEY,
  workspaceLockRoot,
} from '../../src/utils/workspace-lock.js';
import type { Ctx } from '../../src/types.js';

const [storeRoot, mode, ...rest] = process.argv.slice(2);

async function main(): Promise<void> {
  const store = new MemoryStore(storeRoot);
  const lock = new WorkspaceLock(workspaceLockRoot(storeRoot));

  if (mode === 'write') {
    const [key, content] = rest;
    const result = await lock.withLock(WORKSPACE_LOCK_KEY, () =>
      store.writeWithResult('memory', key, content ?? '', ['worker']),
    );
    process.stdout.write(JSON.stringify({ ok: true, revision: result.revision, id: result.id }));
    return;
  }

  if (mode === 'cas') {
    const [key, content, expected] = rest;
    try {
      const result = await lock.withLock(WORKSPACE_LOCK_KEY, () =>
        store.writeWithResult('memory', key, content ?? '', ['worker'], {
          expectedRevision: Number(expected),
        }),
      );
      process.stdout.write(JSON.stringify({ ok: true, revision: result.revision }));
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.name : String(err),
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      process.exitCode = 3;
    }
    return;
  }

  if (mode === 'read-id') {
    const [key] = rest;
    const result = store.read('memory', key ?? '');
    process.stdout.write(
      JSON.stringify(
        result
          ? { ok: true, id: result.id, revision: result.revision }
          : { ok: false, error: 'NotFound' },
      ),
    );
    return;
  }

  if (mode === 'hold-lock') {
    const ms = Number(rest[0] ?? 1000);
    await lock.withLock(WORKSPACE_LOCK_KEY, async () => {
      process.stdout.write('LOCKED');
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    return;
  }

  if (mode === 'stall-lock') {
    // Hold the lock, then rewrite the lock file with an EXPIRED lease while
    // this process stays alive (simulates a stalled owner: GC pause, slow
    // disk). Used to prove that a live owner is never taken over even when
    // its lease expired (review P1 #1).
    const ms = Number(rest[0] ?? 1000);
    const lockPath = lock.lockPath(WORKSPACE_LOCK_KEY);
    await lock.withLock(WORKSPACE_LOCK_KEY, async () => {
      process.stdout.write('LOCKED');
      const current = fs.readFileSync(lockPath, 'utf8');
      const owner = JSON.parse(current) as { ownerToken: string; hostname: string; pid: number };
      const stalled = {
        version: 1,
        key: WORKSPACE_LOCK_KEY,
        pid: owner.pid,
        hostname: owner.hostname,
        ownerToken: owner.ownerToken,
        createdAt: new Date().toISOString(),
        heartbeatAt: new Date(Date.now() - 3600_000).toISOString(),
        leaseExpiresAt: new Date(Date.now() - 1800_000).toISOString(),
      };
      fs.writeFileSync(lockPath, JSON.stringify(stalled, null, 2), 'utf8');
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
    return;
  }

  if (mode === 'contend-lock') {
    // Multi-waiter reclaim race: ROUNDS critical sections of HOLD_MS each.
    // Emits JSON lines {pid, event, t} so the parent can detect overlap.
    const rounds = Number(rest[0] ?? 2);
    const holdMs = Number(rest[1] ?? 120);
    for (let r = 0; r < rounds; r++) {
      await lock.withLock(WORKSPACE_LOCK_KEY, async () => {
        process.stdout.write(
          JSON.stringify({ pid: process.pid, event: 'enter', t: Date.now() }) + '\n',
        );
        const until = Date.now() + holdMs;
        while (Date.now() < until) {
          // Busy-wait: guarantees the critical section really lasts holdMs.
        }
        process.stdout.write(
          JSON.stringify({ pid: process.pid, event: 'exit', t: Date.now() }) + '\n',
        );
      });
    }
    return;
  }

  if (mode === 'remember-tool') {
    // Exercises the full MCP remember flow: journal + fault injection.
    const [key, content] = rest;
    const indexDao = new IndexDao(storeRoot);
    const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
    const ctx: Ctx = {
      cwd: storeRoot,
      workspaceId: 'worker-workspace',
      storeRoot,
      indexDao,
      memoryStore: store,
      themeManager,
      refinedManager: {} as Ctx['refinedManager'],
    };
    const tools = createMemoryTools(ctx);
    const remember = tools.find((t) => t.name === 'remember');
    if (!remember) throw new Error('remember tool missing');
    const result = await remember.handler({ key, content: content ?? '', tags: ['worker'] });
    process.stdout.write(result.content[0]?.text ?? '{}');
    return;
  }

  if (mode === 'move-tool') {
    // Exercises the full MCP move flow, including the destination rollback
    // when the source cannot be removed (fault injection).
    const [key, toFolder] = rest;
    const indexDao = new IndexDao(storeRoot);
    const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
    const ctx: Ctx = {
      cwd: storeRoot,
      workspaceId: 'worker-workspace',
      storeRoot,
      indexDao,
      memoryStore: store,
      themeManager,
      refinedManager: {} as Ctx['refinedManager'],
    };
    const tools = createMemoryTools(ctx);
    const move = tools.find((t) => t.name === 'move');
    if (!move) throw new Error('move tool missing');
    const result = await move.handler({ key, folder: 'memory', toFolder: toFolder ?? 'memory' });
    process.stdout.write(result.content[0]?.text ?? '{}');
    return;
  }

  if (mode === 'refine-write') {
    const [sessionId, countArg, seed] = rest;
    const count = Number(countArg ?? 10);
    const manager = new RefinedManager(path.join(storeRoot, 'refined'));
    const rawTurns = [];
    for (let i = 1; i <= count; i++) {
      rawTurns.push({
        turnId: i,
        timestamp: '2024-05-01T10:00:00.000Z',
        user: `worker question ${i} ${seed ?? ''}`,
        agentText: `worker answer ${i} ${seed ?? ''}`,
        actions: [],
      });
    }
    const refinedTurns = rawTurns.map((turn) => manager.refineTurn(turn, sessionId));
    await manager.saveRefinedTurns(sessionId, refinedTurns);
    manager.close();
    process.stdout.write(JSON.stringify({ ok: true, saved: refinedTurns.length }));
    return;
  }

  if (mode === 'refine-count') {
    const manager = new RefinedManager(path.join(storeRoot, 'refined'));
    const count = manager.countAll();
    manager.close();
    process.stdout.write(JSON.stringify({ ok: true, count }));
    return;
  }

  process.stderr.write(`unknown mode: ${mode}\n`);
  process.exitCode = 2;
}

void main();
