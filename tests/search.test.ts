/**
 * Search, search view and session identity tests.
 *
 * These tests exercise the merged refined/raw retrieval path, the partial
 * scan semantics, the strict search view key format and the shared-reference
 * protection of refined turns.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import {
  searchWireContext,
  parseWireFile,
  findAllWorkspaceSessions,
  getCurrentSessionWirePath,
  findPreviousSession,
  resolveSearchLimit,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
} from '../src/context/wire-context.js';
import { RefinedManager } from '../src/refined-manager.js';
import { ThemeManager } from '../src/theme-manager.js';
import { MemoryStore } from '../src/dao/memory-store.js';
import {
  SearchViewRepository,
  InvalidSearchViewKeyError,
  SearchViewNotFoundError,
  SearchViewAccessError,
  SEARCH_VIEW_KEY_PATTERN,
} from '../src/search/search-view-repository.js';
import { computeWorkspaceHash } from '../src/utils/paths.js';
import {
  normalizeWorkDir,
  workDirHashCandidates,
  resolveWorkspaceDescriptors,
  resolveHostHome,
} from '../src/search/host-workspace.js';
import type { RefinedTurn } from '../src/refine/types.js';
import type { Ctx } from '../src/types.js';
import type { ToolResult } from '../src/tools/types.js';

interface TestTurn {
  user: string;
  agent?: string;
  time?: string;
}

function makeTurn(
  sessionId: string,
  turnId: number,
  text: string,
  timestamp?: string,
): RefinedTurn {
  return {
    sessionId,
    turnId,
    timestamp,
    summary: text,
    facts: [text],
    notes: [],
    entities: { files: [], tools: [], errors: [] },
    categories: {},
  };
}

function setupWorkspace(): {
  tmp: string;
  sessionsRoot: string;
  storeRoot: string;
  slugDir: string;
  cleanup: () => void;
} {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-search-test-'));
  const sessionsRoot = path.join(tmp, 'sessions');
  const storeRoot = path.join(tmp, 'store');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.mkdirSync(storeRoot, { recursive: true });

  // The legacy cwd hash (slashes only) must keep working: this is the
  // directory name the host wrote for an implicit workspace.
  const legacyHash = computeWorkspaceHash(process.cwd().replace(/\\/g, '/'));
  const slugDir = `wd_project_${legacyHash}`;
  fs.mkdirSync(path.join(sessionsRoot, slugDir), { recursive: true });

  process.env.MEMORY_SESSIONS_ROOT = sessionsRoot;
  process.env.MEMORY_STORE_ROOT = storeRoot;
  delete process.env.KIMI_MEMORY_SESSION_ID;

  return {
    tmp,
    sessionsRoot,
    storeRoot,
    slugDir,
    cleanup: () => {
      delete process.env.MEMORY_SESSIONS_ROOT;
      delete process.env.MEMORY_STORE_ROOT;
      delete process.env.KIMI_MEMORY_SESSION_ID;
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Temporary directory cleanup is best effort (a file handle may still
        // be open on Windows).
      }
    },
  };
}

function writeSession(
  sessionsRoot: string,
  slugDir: string,
  sessionId: string,
  turns: TestTurn[],
): string {
  const dir = path.join(sessionsRoot, slugDir, sessionId, 'agents', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  turns.forEach((turn, index) => {
    const time = turn.time ?? '2024-05-01T10:00:00.000Z';
    lines.push(
      JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: turn.user }], time }),
    );
    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        event: { type: 'step.begin', turnId: index },
        time,
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          part: { type: 'text', text: turn.agent ?? '' },
          turnId: index,
        },
      }),
    );
  });
  const wire = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(wire, `${lines.join('\n')}\n`, 'utf8');
  return wire;
}

interface ManagedFixture {
  tmp: string;
  sessionsRoot: string;
  workDir: string;
  workspaceId: string;
  sessionId: string;
  restore: () => void;
}

/**
 * Build a managed host workspace (`wm_<uuid>`) with optional `projects.json`
 * and `session_index.jsonl`, and switch the process into its work directory.
 */
function setupManagedWorkspace(options: {
  withProjects?: boolean;
  withIndex?: boolean;
  primaryRoot?: 'current' | 'other';
}): ManagedFixture {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-managed-test-'));
  const sessionsRoot = path.join(tmp, 'sessions');
  const workDir = path.join(tmp, 'project');
  const otherRoot = path.join(tmp, 'other-primary');
  fs.mkdirSync(sessionsRoot, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(otherRoot, { recursive: true });

  const workspaceId = 'wm_11111111-2222-3333-4444-555555555555';
  const sessionId = 'session_managed-0001';
  const otherSessionId = 'session_managed-0002';
  writeSession(sessionsRoot, workspaceId, sessionId, [
    { user: 'managed workspace session', agent: 'sqlite cache inside a managed workspace' },
  ]);
  writeSession(sessionsRoot, workspaceId, otherSessionId, [
    { user: 'second managed session', agent: '' },
  ]);

  const projectRoot = options.primaryRoot === 'other' ? otherRoot : workDir;
  if (options.withProjects) {
    fs.writeFileSync(
      path.join(tmp, 'projects.json'),
      JSON.stringify({
        schema_version: 2,
        projects: {
          [workspaceId]: {
            root: projectRoot.replace(/\\/g, '/'),
            name: 'managed-project',
            kind: 'managed',
            created_at: '2024-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );
  }
  if (options.withIndex) {
    const rows = [sessionId, otherSessionId].map((id) =>
      JSON.stringify({
        sessionId: id,
        sessionDir: path.join(sessionsRoot, workspaceId, id).replace(/\\/g, '/'),
        workDir: workDir.replace(/\\/g, '/'),
      }),
    );
    fs.writeFileSync(path.join(tmp, 'session_index.jsonl'), `${rows.join('\n')}\n`, 'utf8');
  }

  const previousCwd = process.cwd();
  process.chdir(workDir);
  process.env.MEMORY_SESSIONS_ROOT = sessionsRoot;
  delete process.env.KIMI_MEMORY_SESSION_ID;

  return {
    tmp,
    sessionsRoot,
    workDir,
    workspaceId,
    sessionId,
    restore: () => {
      try {
        process.chdir(previousCwd);
      } catch {
        // Ignore a failed restore.
      }
      delete process.env.MEMORY_SESSIONS_ROOT;
      delete process.env.KIMI_MEMORY_SESSION_ID;
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        // Best effort cleanup.
      }
    },
  };
}

async function runTests(): Promise<void> {
  /* ---------------------------------------------------------------- */
  /* Mixed refined / raw retrieval                                     */
  /* ---------------------------------------------------------------- */
  {
    const ws = setupWorkspace();
    try {
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_alpha', [
        {
          user: 'fix the sqlite cache',
          agent: 'updating the sqlite cache now',
          time: '2024-05-01T10:00:00.000Z',
        },
      ]);

      const manager = new RefinedManager(path.join(ws.storeRoot, 'refined'));
      // Refined row for the same turn: must be de-duplicated, the wire wins.
      await manager.saveRefinedTurns('session_alpha', [
        makeTurn('session_alpha', 0, 'sqlite cache work', '2024-05-01T10:00:00.000Z'),
      ]);
      // Refined row for a session whose wire is gone: refined-only fallback.
      await manager.saveRefinedTurns('session_beta', [
        makeTurn('session_beta', 7, 'sqlite cache warmup plan', '2024-05-02T10:00:00.000Z'),
      ]);
      // Refined-only candidate that only matches one of the two terms: the
      // refined path uses the same AND rule as the raw path.
      await manager.saveRefinedTurns('session_gamma', [
        makeTurn('session_gamma', 1, 'sqlite only, nothing else', '2024-05-03T10:00:00.000Z'),
      ]);

      const result = await searchWireContext('sqlite cache', { refinedManager: manager });

      assert.strictEqual(result.matchCount, 2, 'both the raw and the refined-only match are found');
      assert.strictEqual(result.matches.length, 2);
      assert.strictEqual(result.isComplete, true);
      assert.strictEqual(result.totalMatches, 2);

      const raw = result.matches.find((m) => m.sessionId === 'session_alpha');
      const refinedOnly = result.matches.find((m) => m.sessionId === 'session_beta');
      assert(raw, 'the raw match is present');
      assert.strictEqual(raw.source, 'wire');
      assert(refinedOnly, 'the refined-only match is present');
      assert.strictEqual(refinedOnly.source, 'refined-only');
      assert.strictEqual(refinedOnly.turnId, 7);

      // hits only contain the returned matches that have an original turn.
      assert.strictEqual(result.hits.length, 1);
      assert.strictEqual(result.hits[0].sessionId, 'session_alpha');

      manager.close();
    } finally {
      ws.cleanup();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Corrupted refined rows are reported and break the completeness claim */
  /* ---------------------------------------------------------------- */
  {
    const ws = setupWorkspace();
    try {
      const manager = new RefinedManager(path.join(ws.storeRoot, 'refined'));
      await manager.saveRefinedTurns('session_corrupt', [
        makeTurn('session_corrupt', 0, 'sqlite cache row', '2024-05-02T10:00:00.000Z'),
      ]);

      const db = new DatabaseSync(path.join(ws.storeRoot, 'refined', 'refined.sqlite'));
      db.prepare('UPDATE refined_turns SET facts = ? WHERE session_id = ?').run(
        '{broken-json',
        'session_corrupt',
      );
      db.close();

      const result = await searchWireContext('sqlite cache', { refinedManager: manager });
      assert.strictEqual(result.corruptRefinedRows, 1, 'corrupted rows are counted');
      assert.strictEqual(result.isComplete, false, 'a corrupt row breaks the completeness claim');
      assert.strictEqual(result.truncationReason, 'corrupt-refined-rows');
      assert.strictEqual(result.totalMatches, undefined);

      manager.close();
    } finally {
      ws.cleanup();
    }
  }

  /* ---------------------------------------------------------------- */
  /* A refined hit must not hide an unrefined raw match (RET-01)        */
  /* ---------------------------------------------------------------- */
  {
    const ws = setupWorkspace();
    try {
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_delta', [
        { user: 'sqlite cache issue', agent: 'first mention', time: '2024-05-01T10:00:00.000Z' },
        {
          user: 'another sqlite cache mention',
          agent: 'second mention',
          time: '2024-05-01T10:05:00.000Z',
        },
      ]);

      const manager = new RefinedManager(path.join(ws.storeRoot, 'refined'));
      await manager.saveRefinedTurns('session_delta', [
        makeTurn('session_delta', 0, 'sqlite cache issue', '2024-05-01T10:00:00.000Z'),
      ]);

      const result = await searchWireContext('sqlite cache', { refinedManager: manager });
      assert.strictEqual(
        result.matchCount,
        2,
        'the unrefined raw match must not be swallowed by the refined hit',
      );
      assert.deepStrictEqual(
        result.matches.map((m) => m.turnId).sort((a, b) => a - b),
        [0, 1],
      );
      manager.close();
    } finally {
      ws.cleanup();
    }
  }

  /* ---------------------------------------------------------------- */
  /* The wire is authoritative when it exists                           */
  /* ---------------------------------------------------------------- */
  {
    const ws = setupWorkspace();
    try {
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_eps', [
        {
          user: 'nothing relevant in this turn',
          agent: 'still nothing',
          time: '2024-05-01T10:00:00.000Z',
        },
      ]);

      const manager = new RefinedManager(path.join(ws.storeRoot, 'refined'));
      // The refined summary claims a match the original turn does not have.
      await manager.saveRefinedTurns('session_eps', [
        makeTurn('session_eps', 0, 'sqlite cache', '2024-05-01T10:00:00.000Z'),
      ]);

      const result = await searchWireContext('sqlite cache', { refinedManager: manager });
      assert.strictEqual(
        result.matchCount,
        0,
        'the original turn decides the match when the wire exists',
      );
      manager.close();
    } finally {
      ws.cleanup();
    }
  }

  /* ---------------------------------------------------------------- */
  /* AND semantics and limit                                            */
  /* ---------------------------------------------------------------- */
  {
    const ws = setupWorkspace();
    try {
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_zeta', [
        { user: 'only sqlite here', agent: '' },
        { user: 'only cache here', agent: '' },
        { user: 'sqlite and cache together', agent: '' },
      ]);

      const result = await searchWireContext('sqlite cache', {});
      assert.strictEqual(result.matchCount, 1, 'all terms must match (AND)');
      assert.strictEqual(result.matches[0].turnId, 2);

      assert.strictEqual(resolveSearchLimit(undefined), DEFAULT_SEARCH_LIMIT);
      assert.strictEqual(resolveSearchLimit(1000), MAX_SEARCH_LIMIT);
      assert.strictEqual(resolveSearchLimit(0), 1);
      assert.strictEqual(resolveSearchLimit(-5), 1);
    } finally {
      ws.cleanup();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Partial scan when the byte budget is exhausted                     */
  /* ---------------------------------------------------------------- */
  {
    const ws = setupWorkspace();
    try {
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_eta', [
        { user: 'sqlite cache inside the budget', agent: '' },
      ]);
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_theta', [
        { user: 'sqlite cache in another session', agent: '' },
      ]);

      const etaWire = path.join(
        ws.sessionsRoot,
        ws.slugDir,
        'session_eta',
        'agents',
        'main',
        'wire.jsonl',
      );
      const thetaWire = path.join(
        ws.sessionsRoot,
        ws.slugDir,
        'session_theta',
        'agents',
        'main',
        'wire.jsonl',
      );
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(etaWire, old, old);

      const result = await searchWireContext('sqlite cache', {
        maxScanBytes: fs.statSync(thetaWire).size,
      });
      assert.strictEqual(result.isComplete, false, 'an exhausted budget yields a partial result');
      assert.strictEqual(result.truncationReason, 'scan-budget-exceeded');
      assert.deepStrictEqual(result.skippedSessionIds, ['session_eta']);
      assert.strictEqual(result.totalMatches, undefined, 'a partial scan must not claim a total');
      assert.strictEqual(result.nextCursor, 'session_eta');
      assert.strictEqual(result.matchCount, 1);
      assert.strictEqual(result.matches[0].sessionId, 'session_theta');
      assert(result.hits.every((hit) => hit.wire === thetaWire));

      const resumed = await searchWireContext('sqlite cache', {
        cursor: result.nextCursor,
        maxScanBytes: 1024 * 1024,
      });
      assert.strictEqual(resumed.isComplete, true);
      assert.strictEqual(resumed.matchCount, 1, 'the cursor scans only unfinished sessions');
      assert.strictEqual(resumed.matches[0].sessionId, 'session_eta');
      assert.strictEqual(resumed.totalMatches, undefined, 'a cursor page has no global total');

      const invalid = await searchWireContext('sqlite cache', { cursor: 'session_missing' });
      assert.strictEqual(invalid.isComplete, false);
      assert.strictEqual(invalid.truncationReason, 'invalid-cursor');
      assert.strictEqual(invalid.matchCount, 0);

      // The same query without a budget limit is complete.
      const complete = await searchWireContext('sqlite cache', {});
      assert.strictEqual(complete.isComplete, true);
      assert.strictEqual(complete.matchCount, 2);
      assert.strictEqual(complete.totalMatches, 2);
    } finally {
      ws.cleanup();
    }
  }

  {
    // An oversized session (larger than the whole budget) must be skipped
    // permanently while the cursor still advances: no duplicate results and
    // no stuck nextCursor (the review repro).
    const ws = setupWorkspace();
    try {
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_small1', [
        { user: 'cursor probe target one', agent: 'answer one', time: '2024-05-01T10:00:00.000Z' },
      ]);
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_big', [
        { user: `cursor probe target ${'x'.repeat(3 * 1024 * 1024)}`, agent: 'big', time: '2024-05-01T10:01:00.000Z' },
      ]);
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_small2', [
        { user: 'cursor probe target two', agent: 'answer two', time: '2024-05-01T10:02:00.000Z' },
      ]);

      const page1 = await searchWireContext('cursor probe target', { maxScanBytes: 1024 * 1024 });
      assert.strictEqual(page1.isComplete, false);
      assert.strictEqual(page1.truncationReason, 'scan-budget-exceeded');
      assert.deepStrictEqual(page1.skippedSessionIds, ['session_big'], 'the oversized session is reported');
      assert(
        page1.matches.some((m) => m.sessionId === 'session_small2'),
        'sessions after the oversized one are scanned on the same page',
      );
      // No budget-stop happened: the cursor must NOT stall on the oversized
      // session (the review repro returned the same nextCursor forever).
      assert.strictEqual(page1.nextCursor, undefined);

      // A follow-up scan without a cursor covers everything scannable and
      // completes — no stuck pagination state.
      const page2 = await searchWireContext('cursor probe target', { maxScanBytes: 1024 * 1024 });
      assert.strictEqual(page2.isComplete, false, 'the skipped session still prevents a total');
      assert.deepStrictEqual(page2.skippedSessionIds, ['session_big']);
      const ids = page1.matches.map((m) => m.sessionId);
      assert.strictEqual(new Set(ids).size, ids.length, 'no duplicate sessions within a page');
    } finally {
      ws.cleanup();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Search view keys                                                   */
  /* ---------------------------------------------------------------- */
  {
    const ws = setupWorkspace();
    try {
      const repo = new SearchViewRepository(ws.storeRoot);

      const valid = ['search-abcdef123456', 'search-v2-0123456789abcdef0123456789abcdef'];
      for (const key of valid) {
        assert(SEARCH_VIEW_KEY_PATTERN.test(key), `${key} must be valid`);
        assert.doesNotThrow(() => repo.resolveKey(key));
      }

      const invalid = [
        '../../mcp-config',
        '../../../.kimi-code/mcp',
        '..%2F..%2Fmcp-config',
        'search-abcdef123456.json',
        'search-ABCDEF123456',
        'search-v2-0123456789abcdef0123456789abcdef'.toUpperCase(),
        'search-v2-0123456789ABCDEF0123456789abcdef',
        'search-../index',
        'search-',
        'search-abcdef12345',
        'search-v2-0123456789abcdef0123456789abcde',
        'search-abcdef123456/../../escape',
        '',
      ];
      for (const key of invalid) {
        assert(!SEARCH_VIEW_KEY_PATTERN.test(key), `${key} must be rejected`);
        assert.throws(() => repo.resolveKey(key), InvalidSearchViewKeyError, `${key} must throw`);
      }

      // New views always use the v2 format and keep the parameters in the file.
      const saved = repo.save({
        query: 'sqlite cache',
        filters: {
          dateFrom: '2024-01-01',
          dateTo: null,
          limit: 5,
          clusterGapSeconds: 60,
          maxClusterSize: 10,
        },
        counts: {
          totalMatches: 3,
          matchCount: 3,
          isComplete: true,
          totalRefined: 1,
          skippedSessionIds: [],
        },
        clusters: [
          {
            sessionId: 'session_alpha',
            hitTurnId: 1,
            memberCount: 1,
            refinedCount: 1,
            members: [{ sessionId: 'session_alpha', turnId: 1 }],
          },
        ],
      });
      assert(/^search-v2-[a-f0-9]{32}$/.test(saved.key), 'new views use a v2 key');
      assert.strictEqual(saved.schemaVersion, 1);

      const loaded = repo.load(saved.key);
      assert.strictEqual(loaded.query, 'sqlite cache');
      assert.strictEqual(loaded.filters.limit, 5);
      assert.strictEqual(loaded.counts.matchCount, 3);
      assert.strictEqual(loaded.clusters.length, 1);
      assert.strictEqual(loaded.clusters[0].members[0].turnId, 1);

      assert.throws(() => repo.load('search-000000000000'), SearchViewNotFoundError);
      assert.throws(() => repo.delete('search-000000000000'), SearchViewNotFoundError);

      // Legacy views stay readable and deletable.
      const legacyDir = path.join(ws.storeRoot, 'searches');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyDir, 'search-0123456789ab.json'),
        JSON.stringify({
          query: 'legacy query',
          createdAt: '2024-01-01T00:00:00.000Z',
          totalMatches: 2,
          totalRefined: 0,
          gapSeconds: 90,
          maxClusterSize: 15,
          skippedSessions: [],
          clusters: [],
        }),
        'utf8',
      );
      const legacy = repo.load('search-0123456789ab');
      assert.strictEqual(legacy.query, 'legacy query');
      assert.strictEqual(legacy.counts.totalMatches, 2);
      assert.strictEqual(legacy.filters.clusterGapSeconds, 90);
      assert.strictEqual(legacy.legacy, true);

      const listed = repo.list();
      assert(
        listed.some((v) => v.key === 'search-0123456789ab'),
        'legacy views are listed',
      );
      assert(
        listed.some((v) => v.key === saved.key),
        'v2 views are listed',
      );

      repo.delete(saved.key);
      assert.throws(() => repo.load(saved.key), SearchViewNotFoundError);

      // A view file that is a symlink is rejected (no escape through links).
      const outside = path.join(ws.tmp, 'outside.json');
      fs.writeFileSync(outside, JSON.stringify({ query: 'outside' }), 'utf8');
      const linkKey = 'search-abcdefabcdef';
      const linkPath = path.join(ws.storeRoot, 'searches', `${linkKey}.json`);
      let linkCreated = false;
      try {
        fs.symlinkSync(outside, linkPath, 'file');
        linkCreated = true;
      } catch {
        // Symlink creation may require elevated privileges on Windows.
      }
      if (linkCreated) {
        assert.throws(() => repo.load(linkKey), SearchViewAccessError, 'symlinks are rejected');
        assert.throws(() => repo.delete(linkKey), SearchViewAccessError);
      }
    } finally {
      ws.cleanup();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Shared refined references are not deleted                          */
  /* ---------------------------------------------------------------- */
  {
    const ws = setupWorkspace();
    try {
      const manager = new RefinedManager(path.join(ws.storeRoot, 'refined'));
      const themeManager = new ThemeManager(path.join(ws.storeRoot, 'themes'));
      const ctx = {
        cwd: process.cwd(),
        workspaceId: 'workspace-test',
        storeRoot: ws.storeRoot,
        indexDao: {} as Ctx['indexDao'],
        memoryStore: new MemoryStore(ws.storeRoot),
        themeManager,
        refinedManager: manager,
      } as unknown as Ctx;

      const { createContextTools } = await import('../src/tools/context-tools.js');
      const tools = createContextTools(ctx);
      const deleteTool = tools.find((t) => t.name === 'delete_search_view')!;

      await manager.saveRefinedTurns('session_shared', [
        makeTurn('session_shared', 3, 'shared refined turn', '2024-05-01T10:00:00.000Z'),
      ]);

      const repo = new SearchViewRepository(ws.storeRoot);
      const viewA = repo.save({
        query: 'shared refined turn',
        counts: {
          totalMatches: 1,
          matchCount: 1,
          isComplete: true,
          totalRefined: 0,
          skippedSessionIds: [],
        },
        clusters: [
          {
            sessionId: 'session_shared',
            hitTurnId: 3,
            memberCount: 1,
            refinedCount: 0,
            members: [{ sessionId: 'session_shared', turnId: 3 }],
          },
        ],
      });
      const viewB = repo.save({
        query: 'shared refined turn',
        counts: {
          totalMatches: 1,
          matchCount: 1,
          isComplete: true,
          totalRefined: 0,
          skippedSessionIds: [],
        },
        clusters: [
          {
            sessionId: 'session_shared',
            hitTurnId: 3,
            memberCount: 1,
            refinedCount: 0,
            members: [{ sessionId: 'session_shared', turnId: 3 }],
          },
        ],
      });

      // Deleting the first view must not remove the shared refined turn.
      const first = JSON.parse(
        ((await deleteTool.handler({ key: viewA.key, deleteRefinedTurns: true })) as ToolResult)
          .content[0].text,
      );
      assert.strictEqual(first.success, true);
      assert.strictEqual(first.deletedRefinedTurns, 0, 'shared refined turns are not deleted');
      assert.strictEqual(first.skippedSharedRefinedTurns, 1);
      assert.strictEqual(
        manager.loadRefinedTurn('session_shared', 3)?.summary,
        'shared refined turn',
      );

      // A theme reference also protects the row.
      await themeManager.addThemeAssociation('shared-theme', {
        sessionId: 'session_shared',
        turnId: 3,
      });
      const second = JSON.parse(
        ((await deleteTool.handler({ key: viewB.key, deleteRefinedTurns: true })) as ToolResult)
          .content[0].text,
      );
      assert.strictEqual(second.success, true);
      assert.strictEqual(second.deletedRefinedTurns, 0);
      assert.strictEqual(second.skippedSharedRefinedTurns, 1);
      assert(manager.loadRefinedTurn('session_shared', 3), 'the theme reference keeps the row');

      // Invalid keys are rejected before any file is touched.
      const invalid = JSON.parse(
        (
          (await deleteTool.handler({
            key: '../../escape',
            deleteRefinedTurns: true,
          })) as ToolResult
        ).content[0].text,
      );
      assert.strictEqual(invalid.success, false);
      assert.strictEqual(invalid.code, 'invalid_search_view_key');

      const missing = JSON.parse(
        ((await deleteTool.handler({ key: 'search-000000000000' })) as ToolResult).content[0].text,
      );
      assert.strictEqual(missing.success, false);
      assert.strictEqual(missing.code, 'search_view_not_found');

      manager.close();
    } finally {
      ws.cleanup();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Tool output: match counters, save_view and output truncation        */
  /* ---------------------------------------------------------------- */
  {
    const ws = setupWorkspace();
    try {
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_tool', [
        {
          user: 'sqlite cache needs a fix',
          agent: 'a'.repeat(400),
          time: '2024-05-01T10:00:00.000Z',
        },
        { user: 'sqlite cache again', agent: 'b'.repeat(400), time: '2024-05-01T10:01:00.000Z' },
        {
          user: 'sqlite cache once more',
          agent: 'c'.repeat(400),
          time: '2024-05-01T10:02:00.000Z',
        },
      ]);

      const manager = new RefinedManager(path.join(ws.storeRoot, 'refined'));
      const themeManager = new ThemeManager(path.join(ws.storeRoot, 'themes'));
      const ctx = {
        cwd: process.cwd(),
        workspaceId: 'workspace-test',
        storeRoot: ws.storeRoot,
        indexDao: {} as Ctx['indexDao'],
        memoryStore: new MemoryStore(ws.storeRoot),
        themeManager,
        refinedManager: manager,
      } as unknown as Ctx;

      const { createContextTools } = await import('../src/tools/context-tools.js');
      const tools = createContextTools(ctx);
      const searchTool = tools.find((t) => t.name === 'search_context')!;
      const repo = new SearchViewRepository(ws.storeRoot);

      // save_view: false must not create a view.
      const noView = JSON.parse(
        (
          (await searchTool.handler({
            query: 'sqlite cache',
            detail: 'compact',
            save_view: false,
          })) as ToolResult
        ).content[0].text,
      );
      assert.strictEqual(noView.matchCount, 3, 'the scan count is reported');
      assert.strictEqual(noView.returnedMatches, 3);
      assert.strictEqual(noView.isComplete, true);
      assert.strictEqual(noView.totalMatches, 3);
      assert.strictEqual(noView.savedViewKey, null);
      assert.strictEqual(repo.list().length, 0, 'save_view: false does not write a view');

      const invalidCursorResult = (await searchTool.handler({
        query: 'sqlite cache',
        cursor: 'session_missing',
      })) as ToolResult;
      const invalidCursor = JSON.parse(invalidCursorResult.content[0].text);
      assert.strictEqual(invalidCursorResult.isError, true);
      assert.strictEqual(invalidCursor.truncationReason, 'invalid-cursor');
      assert.strictEqual(repo.list().length, 0, 'an invalid cursor does not save an empty view');

      // save_view defaults to true.
      const withView = JSON.parse(
        ((await searchTool.handler({ query: 'sqlite cache', detail: 'compact' })) as ToolResult)
          .content[0].text,
      );
      assert(withView.savedViewKey, 'a view is saved by default');
      assert(/^search-v2-[a-f0-9]{32}$/.test(withView.savedViewKey));
      assert.strictEqual(repo.list().length, 1);

      // limit applies after the merge; hits stay proportional to the response.
      const limited = JSON.parse(
        (
          (await searchTool.handler({
            query: 'sqlite cache',
            limit: 1,
            detail: 'compact',
          })) as ToolResult
        ).content[0].text,
      );
      assert.strictEqual(limited.returnedMatches, 1);
      assert.strictEqual(limited.matchCount, 3, 'the scan count is not affected by the limit');

      // Trimming the payload must not rewrite the scan counters.
      const trimmed = JSON.parse(
        (
          (await searchTool.handler({
            query: 'sqlite cache',
            detail: 'normal',
            max_output_chars: 500,
          })) as ToolResult
        ).content[0].text,
      );
      assert.strictEqual(trimmed.outputTruncated, true, 'a trimmed payload is flagged');
      assert.strictEqual(trimmed.matchCount, 3, 'trimming does not change the scan count');
      assert.strictEqual(trimmed.totalMatches, 3);

      manager.close();
    } finally {
      ws.cleanup();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Host workspace resolution (wd_* / wm_*, projects + session index)  */
  /* ---------------------------------------------------------------- */
  {
    // The hash must stay compatible with the legacy (slashes only) variant
    // and with the host variant (slashes + trimmed trailing slash).
    const candidates = workDirHashCandidates('D:/workspace/app');
    assert(
      candidates.includes(computeWorkspaceHash('D:/workspace/app')),
      'the host hash is a candidate',
    );
    const withSlash = workDirHashCandidates('D:/workspace/app/');
    assert(
      withSlash.includes(computeWorkspaceHash('D:/workspace/app')),
      'the trimmed (host) hash is a candidate',
    );
    assert(
      withSlash.includes(computeWorkspaceHash('D:/workspace/app/')),
      'the legacy slash-only hash stays a candidate',
    );
    assert.strictEqual(normalizeWorkDir('D:\\workspace\\app\\'), 'D:/workspace/app');
  }

  {
    // Managed workspace (wm_<uuid>) resolved through projects.json.
    const fixture = setupManagedWorkspace({ withProjects: true, withIndex: false });
    try {
      const sessions = findAllWorkspaceSessions();
      assert(
        sessions.some((s) => s.sessionId === fixture.sessionId),
        'a managed workspace session is discovered through projects.json',
      );
      const descriptors = resolveWorkspaceDescriptors(
        normalizeWorkDir(fixture.workDir),
        fixture.sessionsRoot,
      );
      assert(
        descriptors.some((d) => d.id === fixture.workspaceId && d.kind === 'managed'),
        'the managed workspace descriptor is resolved',
      );
    } finally {
      fixture.restore();
    }
  }

  {
    // Managed workspace resolved through session_index.jsonl only.
    const fixture = setupManagedWorkspace({ withProjects: false, withIndex: true });
    try {
      const sessions = findAllWorkspaceSessions();
      assert(
        sessions.some((s) => s.sessionId === fixture.sessionId),
        'a managed workspace session is discovered through the session index',
      );
    } finally {
      fixture.restore();
    }
  }

  {
    // The primary directory changed but the workspace id stayed the same:
    // projects.json points at another root, the session index still records
    // the session under the current work directory.
    const fixture = setupManagedWorkspace({
      withProjects: true,
      withIndex: true,
      primaryRoot: 'other',
    });
    try {
      const sessions = findAllWorkspaceSessions();
      assert(
        sessions.some((s) => s.sessionId === fixture.sessionId),
        'a session is found even when the primary directory changed',
      );
    } finally {
      fixture.restore();
    }
  }

  {
    // Missing host metadata: the legacy cwd hash discovery still works.
    const fixture = setupManagedWorkspace({ withProjects: false, withIndex: false });
    try {
      assert.strictEqual(
        resolveHostHome(fixture.sessionsRoot),
        null,
        'no host metadata is reported when the index files are missing',
      );
      const sessions = findAllWorkspaceSessions();
      assert(
        !sessions.some((s) => s.sessionId === fixture.sessionId),
        'an unknown managed workspace cannot be guessed',
      );

      // The legacy implicit workspace is still discovered.
      const legacyHash = computeWorkspaceHash(process.cwd().replace(/\\/g, '/'));
      writeSession(fixture.sessionsRoot, `wd_project_${legacyHash}`, 'session_legacy', [
        { user: 'legacy implicit session', agent: '' },
      ]);
      const withLegacy = findAllWorkspaceSessions();
      assert(
        withLegacy.some((s) => s.sessionId === 'session_legacy'),
        'the legacy hash discovery is the fallback',
      );
    } finally {
      fixture.restore();
    }
  }

  {
    // Corrupted host metadata: the legacy cwd hash discovery still works.
    const fixture = setupManagedWorkspace({ withProjects: false, withIndex: false });
    try {
      fs.writeFileSync(path.join(fixture.tmp, 'projects.json'), '{ this is not json', 'utf8');
      fs.writeFileSync(
        path.join(fixture.tmp, 'session_index.jsonl'),
        'not-json\n{"broken": true}\n',
        'utf8',
      );
      const legacyHash = computeWorkspaceHash(process.cwd().replace(/\\/g, '/'));
      writeSession(fixture.sessionsRoot, `wd_project_${legacyHash}`, 'session_legacy_corrupt', [
        { user: 'legacy implicit session', agent: '' },
      ]);
      const sessions = findAllWorkspaceSessions();
      assert(
        sessions.some((s) => s.sessionId === 'session_legacy_corrupt'),
        'corrupted metadata falls back to the legacy discovery',
      );
    } finally {
      fixture.restore();
    }
  }

  {
    // Explicit session override (manual / test only) inside a managed
    // workspace.
    const fixture = setupManagedWorkspace({ withProjects: true, withIndex: true });
    try {
      process.env.KIMI_MEMORY_SESSION_ID = fixture.sessionId;
      const current = getCurrentSessionWirePath();
      assert(current);
      assert.strictEqual(current.sessionId, fixture.sessionId);
      assert.strictEqual(current.identityAssumed, false, 'an explicit id is not assumed');

      const previous = findPreviousSession();
      assert(previous);
      assert.notStrictEqual(previous.sessionId, fixture.sessionId);
      delete process.env.KIMI_MEMORY_SESSION_ID;
    } finally {
      fixture.restore();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Session identity                                                   */
  /* ---------------------------------------------------------------- */
  {
    const ws = setupWorkspace();
    try {
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_current', [
        { user: 'current session', agent: '' },
      ]);
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_previous', [
        { user: 'previous session', agent: '' },
      ]);
      // Make the previous session older than the current one.
      const previousWire = path.join(
        ws.sessionsRoot,
        ws.slugDir,
        'session_previous',
        'agents',
        'main',
        'wire.jsonl',
      );
      const old = new Date(Date.now() - 60_000);
      fs.utimesSync(previousWire, old, old);

      // Without an explicit id the session is guessed (low confidence).
      const guessed = getCurrentSessionWirePath();
      assert(guessed, 'a session is discovered');
      assert.strictEqual(guessed.identityAssumed, true, 'mtime guessing is marked as assumed');

      // With an explicit id the session is authoritative.
      process.env.KIMI_MEMORY_SESSION_ID = 'session_previous';
      const explicit = getCurrentSessionWirePath();
      assert(explicit);
      assert.strictEqual(explicit.sessionId, 'session_previous');
      assert.strictEqual(explicit.identityAssumed, false, 'an explicit id is not assumed');

      // findPreviousSession must exclude the explicitly selected session.
      const previous = findPreviousSession();
      assert(previous);
      assert.notStrictEqual(previous.sessionId, 'session_previous');

      const sessions = findAllWorkspaceSessions();
      assert.strictEqual(sessions.length, 2);
      assert(sessions.every((s) => typeof s.mtime === 'number'));

      delete process.env.KIMI_MEMORY_SESSION_ID;
    } finally {
      ws.cleanup();
    }
  }

  {
    // Stable merged ordering: identical scores and timestamps must fall back
    // to (sessionId, turnId) deterministically across repeated runs.
    const ws = setupWorkspace();
    try {
      for (const sessionId of ['session_alpha', 'session_beta', 'session_gamma']) {
        writeSession(ws.sessionsRoot, ws.slugDir, sessionId, [
          { user: 'ordering probe target', agent: 'ordering probe target', time: '2024-05-01T10:00:00.000Z' },
          { user: 'unrelated chatter', agent: 'nothing here', time: '2024-05-01T10:01:00.000Z' },
        ]);
      }

      const first = await searchWireContext('ordering probe target', {});
      assert.strictEqual(first.matchCount, 3, 'one matching turn per session');
      const orderKey = (m: { sessionId: string; turnId: number }) => `${m.sessionId}:${m.turnId}`;
      const expectedOrder = [...first.matches].sort((a, b) =>
        orderKey(a) < orderKey(b) ? -1 : orderKey(a) > orderKey(b) ? 1 : 0,
      );
      assert.deepStrictEqual(
        first.matches.map((m) => orderKey(m)),
        expectedOrder.map((m) => orderKey(m)),
        'ties are ordered by sessionId and turnId',
      );

      const second = await searchWireContext('ordering probe target', {});
      assert.deepStrictEqual(
        second.matches.map((m) => orderKey(m)),
        first.matches.map((m) => orderKey(m)),
        'repeated runs produce the same order',
      );
    } finally {
      ws.cleanup();
    }
  }

  {
    // v0.5.1 data migration: legacy search views, memory files without a
    // stable id and legacy theme path references keep working after upgrade.
    const ws = setupWorkspace();
    try {
      writeSession(ws.sessionsRoot, ws.slugDir, 'session_legacy', [
        { user: 'legacy migration probe', agent: 'migrated content', time: '2024-05-01T10:00:00.000Z' },
      ]);

      // Legacy memory: no id / revision / contentHash / schemaVersion.
      const legacyDir = path.join(ws.storeRoot, 'memory', 'decisions');
      fs.mkdirSync(legacyDir, { recursive: true });
      const legacyFile = path.join(legacyDir, 'legacy-note.md');
      fs.writeFileSync(
        legacyFile,
        ['---', "key: 'legacy-note'", "title: 'Legacy Note'", 'tags:', '  - decision', '---', '', 'Legacy body'].join('\n'),
        'utf8',
      );

      // Legacy theme referencing the memory by path only.
      const themesDir = path.join(ws.storeRoot, 'themes');
      fs.mkdirSync(themesDir, { recursive: true });
      fs.writeFileSync(
        path.join(themesDir, 'legacy-theme.json'),
        JSON.stringify({
          theme: 'legacy-theme',
          displayName: 'Legacy Theme',
          createdAt: '2024-05-01T10:00:00.000Z',
          updatedAt: '2024-05-01T10:00:00.000Z',
          turns: [{ sessionId: 'session_legacy', turnId: 0, status: 'active' }],
          memories: [
            { folder: 'memory/decisions', key: 'legacy-note', title: 'Legacy Note', status: 'active' },
          ],
        }),
        'utf8',
      );

      // Legacy search view: pre-v2 schema with top-level gapSeconds.
      const searchesDir = path.join(ws.storeRoot, 'searches');
      fs.mkdirSync(searchesDir, { recursive: true });
      const legacyKey = 'search-abcdef123456';
      fs.writeFileSync(
        path.join(searchesDir, `${legacyKey}.json`),
        JSON.stringify({
          query: 'legacy migration probe',
          gapSeconds: 90,
          maxClusterSize: 15,
          totalMatches: 1,
          createdAt: '2024-05-01T10:00:00.000Z',
          clusters: [
            {
              sessionId: 'session_legacy',
              hitTurnId: 0,
              memberCount: 1,
              members: [{ sessionId: 'session_legacy', turnId: 0 }],
            },
          ],
        }),
        'utf8',
      );

      // Backfill: reconcile assigns a stable id and persists it.
      const { IndexDao } = await import('../src/dao/index.js');
      const indexDao = new IndexDao(ws.storeRoot);
      const report = await indexDao.reconcileIndex();
      assert.strictEqual(report.corruptFiles.length, 0);

      const store = new MemoryStore(ws.storeRoot);
      const firstRead = store.readDetailed('memory/decisions', 'legacy-note');
      assert.strictEqual(firstRead.status, 'ok');
      assert(firstRead.memory?.id, 'the legacy memory received a stable id');
      const backfilledId = firstRead.memory.id;

      const secondReport = await indexDao.reconcileIndex();
      assert.strictEqual(secondReport.revisionsBumped, 0, 'a second reconcile is stable');
      const secondRead = store.readDetailed('memory/decisions', 'legacy-note');
      assert.strictEqual(secondRead.memory?.id, backfilledId, 'the id does not change on re-read');

      // The legacy theme reference still resolves after the backfill.
      const themeManager = new ThemeManager(themesDir);
      const updated = await themeManager.updateMemoryReferences({
        previousFolder: 'memory/decisions',
        previousKey: 'legacy-note',
        key: 'legacy-note',
        folder: 'memory/decisions',
        memoryId: backfilledId,
        title: 'Legacy Note',
      });
      assert.strictEqual(updated, 1, 'the legacy path reference was found and updated');
      const theme = themeManager.loadTheme('legacy-theme');
      const ref = theme?.memories?.[0];
      assert.strictEqual(ref?.memoryId, backfilledId, 'the legacy ref now carries the stable id');

      // The legacy search view loads through the strict key parser and is
      // normalized onto the v2 shape without being rewritten on disk.
      const repository = new SearchViewRepository(ws.storeRoot);
      const record = repository.load(legacyKey);
      assert.strictEqual(record.key, legacyKey);
      assert.strictEqual(record.legacy, true, 'the view is marked legacy');
      assert.strictEqual(record.filters.clusterGapSeconds, 90, 'gapSeconds was mapped');
      assert.strictEqual(record.counts.totalMatches, 1, 'legacy totals were mapped');
      assert.strictEqual(record.clusters.length, 1);
      const rawOnDisk = JSON.parse(fs.readFileSync(path.join(searchesDir, `${legacyKey}.json`), 'utf8'));
      assert.strictEqual(rawOnDisk.schemaVersion, undefined, 'legacy views are not silently rewritten');

      // Deleting the legacy view still works through the shared repository.
      repository.delete(legacyKey);
      assert(!fs.existsSync(path.join(searchesDir, `${legacyKey}.json`)));
    } finally {
      ws.cleanup();
    }
  }

  {
    const ws = setupWorkspace();
    try {
      const wire = path.join(ws.tmp, 'invalid-time.jsonl');
      fs.writeFileSync(
        wire,
        `${JSON.stringify({ type: 'turn.prompt', time: 'not-a-date', input: [{ type: 'text', text: 'still readable' }] })}\n`,
        'utf8',
      );
      const parsed = await parseWireFile(wire);
      assert.strictEqual(parsed.turns.length, 1);
      assert.strictEqual(parsed.turns[0].user, 'still readable');
      assert.strictEqual(parsed.turns[0].timestamp, null, 'invalid timestamps degrade to missing metadata');
    } finally {
      ws.cleanup();
    }
  }

  {
    // MCP request cancellation: a pre-aborted signal yields a partial result
    // instead of a completed-looking scan.
    const ws = setupWorkspace();
    try {
      for (const sessionId of ['session_cancel_a', 'session_cancel_b']) {
        writeSession(ws.sessionsRoot, ws.slugDir, sessionId, [
          { user: 'cancel probe target', agent: 'cancel probe target', time: '2024-05-01T10:00:00.000Z' },
        ]);
      }
      const controller = new AbortController();
      controller.abort();
      const result = await searchWireContext('cancel probe target', { signal: controller.signal });
      assert.strictEqual(result.isComplete, false, 'a cancelled scan is not complete');
      assert.strictEqual(result.truncationReason, 'request-cancelled');
      assert.strictEqual(
        (result as { totalMatches?: number }).totalMatches,
        undefined,
        'no total is fabricated for a cancelled scan',
      );
    } finally {
      ws.cleanup();
    }
  }
}

// Standalone execution: `npx tsx tests/search.test.ts`
if (process.argv[1] && /search\.test\.ts$/.test(process.argv[1])) {
  runTests()
    .then(() => console.log('✓ search'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}

export default runTests;
