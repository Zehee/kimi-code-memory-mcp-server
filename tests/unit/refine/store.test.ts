/**
 * Refined store tests: WAL, busy timeout, migrations, UPSERT semantics,
 * corruption reporting and AND-consistent search.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { RefinedStore } from '../../../src/refine/store.js';
import { RefinedCorruptRowError } from '../../../src/refine/adapter.js';
import { REFINED_SCHEMA_VERSION, SQLITE_BUSY_TIMEOUT_MS } from '../../../src/refine/constants.js';
import type { RefinedTurn } from '../../../src/refine/types.js';

function makeTurn(sessionId: string, turnId: number, text: string, timestamp?: string): RefinedTurn {
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

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-refined-store-'));
}

export default async function runTests(): Promise<void> {
  /* ---------------------------------------------------------------- */
  /* Connection setup: WAL + busy timeout                             */
  /* ---------------------------------------------------------------- */
  {
    const root = tempRoot();
    const store = new RefinedStore(root);
    assert.strictEqual(store.getPragma('journal_mode'), 'wal', 'journal_mode should be WAL');
    assert.strictEqual(
      Number(store.getPragma('busy_timeout')),
      SQLITE_BUSY_TIMEOUT_MS,
      'busy_timeout should be configured',
    );
    assert.strictEqual(store.getSchemaVersion(), REFINED_SCHEMA_VERSION);
    store.close();
    // close() must be idempotent.
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- */
  /* saveRefinedTurns UPSERTs only the given rows                     */
  /* ---------------------------------------------------------------- */
  {
    const root = tempRoot();
    const store = new RefinedStore(root);

    store.saveRefinedTurns('s1', [makeTurn('s1', 1, 'alpha'), makeTurn('s1', 2, 'beta')]);
    assert.deepStrictEqual(
      store.loadRefinedTurns('s1').map((t) => t.turnId),
      [1, 2],
    );

    // Saving turn 3 must not drop turns 1 and 2 (no read-modify-write of the
    // whole session).
    store.saveRefinedTurns('s1', [makeTurn('s1', 3, 'gamma')]);
    assert.deepStrictEqual(
      store.loadRefinedTurns('s1').map((t) => t.turnId),
      [1, 2, 3],
    );
    assert.strictEqual(store.countAll(), 3);

    // A second save of the same turn updates it in place.
    store.saveRefinedTurns('s1', [makeTurn('s1', 2, 'beta updated')]);
    assert.strictEqual(store.countAll(), 3);
    assert.strictEqual(store.loadRefinedTurn( 's1', 2)?.summary, 'beta updated');

    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- */
  /* Source provenance and freshness state                             */
  /* ---------------------------------------------------------------- */
  {
    const root = tempRoot();
    const store = new RefinedStore(root);
    store.saveRefinedTurns('s1', [{
      ...makeTurn('s1', 1, 'alpha'),
      source: { size: 123, mtimeNs: '1795415899299579648', contentHash: 'hash-1' },
    }]);
    assert.deepStrictEqual(store.listRefinedTurnStates('s1'), [{
      turnId: 1,
      extractorVersion: '1',
      sourceContentHash: 'hash-1',
    }]);
    const db = new DatabaseSync(path.join(root, 'refined.sqlite'));
    const row = db.prepare('SELECT source_size, source_mtime_ns, source_freshness FROM refined_turns').get() as Record<string, unknown>;
    db.close();
    assert.strictEqual(Number(row.source_size), 123);
    assert.strictEqual(row.source_mtime_ns, '1795415899299579648');
    assert.strictEqual(row.source_freshness, 'fresh');
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- */
  /* Legacy database migration                                         */
  /* ---------------------------------------------------------------- */
  {
    const root = tempRoot();
    const dbPath = path.join(root, 'refined.sqlite');
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE refined_turns (
        session_id TEXT NOT NULL,
        turn_id INTEGER NOT NULL,
        timestamp TEXT,
        summary TEXT,
        facts TEXT,
        notes TEXT,
        entities TEXT,
        categories TEXT,
        PRIMARY KEY (session_id, turn_id)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO refined_turns (session_id, turn_id, timestamp, summary, facts, notes, entities, categories)
         VALUES ('legacy', 1, '2024-01-01T00:00:00.000Z', 'legacy row', '["a"]', '[]', '{"files":[],"tools":[],"errors":[]}', '{}')`,
      )
      .run();
    legacy.close();

    const store = new RefinedStore(root);
    assert.strictEqual(store.getSchemaVersion(), REFINED_SCHEMA_VERSION);
    const turns = store.loadRefinedTurns('legacy');
    assert.strictEqual(turns.length, 1, 'legacy rows survive the migration');
    assert.strictEqual(turns[0].summary, 'legacy row');

    const db = new DatabaseSync(dbPath);
    const row = db
      .prepare('SELECT extractor_version, source_content_hash, source_freshness FROM refined_turns')
      .get() as Record<string, unknown>;
    db.close();
    assert.strictEqual(row.extractor_version, 'unknown', 'legacy rows are marked unknown');
    assert.strictEqual(row.source_content_hash, 'unknown');
    assert.strictEqual(row.source_freshness, 'unknown');

    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- */
  /* Corrupted JSON columns raise an explicit error                    */
  /* ---------------------------------------------------------------- */
  {
    const root = tempRoot();
    const store = new RefinedStore(root);
    store.saveRefinedTurns('s1', [makeTurn('s1', 1, 'alpha')]);

    const db = new DatabaseSync(path.join(root, 'refined.sqlite'));
    db.prepare('UPDATE refined_turns SET facts = ? WHERE session_id = ? AND turn_id = ?').run(
      '{not-json',
      's1',
      1,
    );
    db.close();

    let caught: unknown = null;
    try {
      store.loadRefinedTurns('s1');
    } catch (err) {
      caught = err;
    }
    assert(caught instanceof RefinedCorruptRowError, 'corrupted JSON must raise an explicit error');
    assert.strictEqual((caught as RefinedCorruptRowError).column, 'facts');
    assert.strictEqual((caught as RefinedCorruptRowError).sessionId, 's1');

    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- */
  /* Search: AND semantics and no early SQL truncation                */
  /* ---------------------------------------------------------------- */
  {
    const root = tempRoot();
    const store = new RefinedStore(root);

    store.saveRefinedTurns('s1', [
      makeTurn('s1', 1, 'sqlite cache warmup', '2024-01-01T00:00:00.000Z'),
      makeTurn('s1', 2, 'sqlite only', '2024-01-02T00:00:00.000Z'),
      makeTurn('s1', 3, 'cache only', '2024-01-03T00:00:00.000Z'),
    ]);

    const both = store.searchRefinedTurns({ query: 'sqlite cache' });
    assert.deepStrictEqual(
      both.map((m) => m.turnId),
      [1],
      'both terms must be required (AND)',
    );

    const single = store.searchRefinedTurns({ query: 'sqlite' });
    assert.deepStrictEqual(
      single.map((m) => m.turnId).sort((a, b) => a - b),
      [1, 2],
      'a single term matches both rows',
    );

    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- */
  /* Search: a small limit must not hide higher scoring candidates     */
  /* ---------------------------------------------------------------- */
  {
    const root = tempRoot();
    const store = new RefinedStore(root);

    // The best candidate is the oldest row; a SQL LIMIT would cut it off.
    store.saveRefinedTurns('s1', [
      makeTurn('s1', 1, 'sqlite sqlite sqlite cache', '2024-01-01T00:00:00.000Z'),
    ]);
    for (let i = 2; i <= 8; i++) {
      store.saveRefinedTurns('s1', [
        makeTurn('s1', i, 'sqlite', `2024-01-${String(i).padStart(2, '0')}T00:00:00.000Z`),
      ]);
    }

    const top = store.searchRefinedTurns({ query: 'sqlite cache', limit: 1 });
    assert.strictEqual(top.length, 1);
    assert.strictEqual(top[0].turnId, 1, 'the highest scoring candidate must survive the limit');

    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }

  /* ---------------------------------------------------------------- */
  /* Session progress table                                             */
  /* ---------------------------------------------------------------- */
  {
    const root = tempRoot();
    const store = new RefinedStore(root);
    assert.strictEqual(store.getSessionProgress('s1'), null);
    store.saveSessionProgress({
      sessionId: 's1',
      wireIdentity: 'identity-1',
      lastOffset: 128,
      lastCompleteLineOffset: 96,
      lastSize: 1024,
      lastMtimeNs: '1795415899299579648',
      lastIndexedAt: new Date().toISOString(),
      extractorVersion: '1',
    });
    const progress = store.getSessionProgress('s1');
    assert(progress);
    assert.strictEqual(progress.lastOffset, 128);
    assert.strictEqual(progress.wireIdentity, 'identity-1');
    assert.strictEqual(progress.lastMtimeNs, '1795415899299579648', 'nanosecond mtimes survive exactly');

    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Standalone execution: `npx tsx tests/unit/refine/store.test.ts`
if (process.argv[1] && /store\.test\.ts$/.test(process.argv[1])) {
  runTests()
    .then(() => console.log('✓ refine/store'))
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
