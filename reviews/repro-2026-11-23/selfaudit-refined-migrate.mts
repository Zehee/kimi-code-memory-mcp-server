/** Upgrade path: a SYNTHETIC v0.5.1-shaped refined database opened by the repo's RefinedManager. */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-migrate-'));
process.env.MEMORY_STORE_ROOT = path.join(tmp, 'store');
const { RefinedManager, RefinedStoreBusyError } = await import(pathToFileURL('D:/workspace/kimi-code-memory-mcp-server/src/refined-manager.ts').href);
const refinedRoot = path.join(tmp, 'refined'); fs.mkdirSync(refinedRoot, { recursive: true });
const dbPath = path.join(refinedRoot, 'refined.sqlite');

// 1. Build exactly the v0.5.1 schema (taken from `git show HEAD:src/refine/store.ts`).
const old = new DatabaseSync(dbPath);
old.exec(`
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
  CREATE INDEX idx_refined_session ON refined_turns(session_id);
  CREATE INDEX idx_refined_timestamp ON refined_turns(timestamp);`);
const ins = old.prepare('INSERT INTO refined_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
ins.run('s_old', 0, '2026-10-01T00:00:00.000Z', 'legacy summary about locking', '["fact one"]', '[]', '{"files":[],"tools":[],"errors":[]}', '{}');
ins.run('s_old', 1, '2026-10-02T00:00:00.000Z', 'second legacy turn', '[]', '["note"]', '{"files":["a.ts"],"tools":["Read"],"errors":[]}', '{"decisions":["decide A"]}');
ins.run('s_old', 2, null, 'turn without timestamp', '[]', '[]', '{"files":[],"tools":[],"errors":[]}', '{}');
ins.run('s_bad', 7, '2026-10-03T00:00:00.000Z', 'row with a corrupt facts column', '{not json', '[]', '{"files":[],"tools":[],"errors":[]}', '{}');
const before = (old.prepare('SELECT user_version FROM pragma_user_version').get() as any).user_version;
const journalBefore = (old.prepare('PRAGMA journal_mode').get() as any).journal_mode;
old.close();

// 2. Open with the repo code.
const mgr = new RefinedManager(refinedRoot);
const probe = new DatabaseSync(dbPath, { readOnly: true });
const cols = (probe.prepare('PRAGMA table_info(refined_turns)').all() as any[]).map((c) => c.name);
const tables = (probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((t) => t.name);
const rows = probe.prepare('SELECT session_id, turn_id, summary, extractor_version, source_content_hash, source_freshness FROM refined_turns ORDER BY session_id, turn_id').all() as any[];
const progressCols = (probe.prepare('PRAGMA table_info(refined_session_progress)').all() as any[]).map((c) => c.name);
console.log(`schema: user_version ${before} -> ${mgr.getSchemaVersion()}; journal_mode ${journalBefore} -> ${(probe.prepare('PRAGMA journal_mode').get() as any).journal_mode}`);
console.log(`freshness columns added: ${['extractor_version', 'source_size', 'source_mtime_ns', 'source_content_hash', 'refined_at', 'source_freshness'].every((c) => cols.includes(c))}; tables: ${tables.join(', ')}`);
console.log(`progress table columns: ${progressCols.join(', ')}`);
console.log(`legacy rows kept: ${rows.length}/4; marked unknown: ${rows.filter((r) => r.extractor_version === 'unknown' && r.source_content_hash === 'unknown' && r.source_freshness === 'unknown').length}/4; summaries intact: ${rows.find((r) => r.session_id === 's_old' && r.turn_id === 0)?.summary === 'legacy summary about locking' && rows.find((r) => r.session_id === 's_old' && r.turn_id === 1)?.summary === 'second legacy turn' && rows.find((r) => r.session_id === 's_bad' && r.turn_id === 7)?.summary === 'row with a corrupt facts column'}`);
probe.close();

// 3. Behavior on the migrated store.
const search = mgr.searchRefinedTurnsDetailed({ query: 'locking' });
console.log(`search on legacy rows: matches=${search.matches.length} facts=${JSON.stringify(search.matches[0]?.facts)} entities intact=${JSON.stringify(mgr.loadRefinedTurn('s_old', 1)?.entities)}`);
const bad = mgr.searchRefinedTurnsDetailed({ query: 'corrupt facts column' });
console.log(`corrupt legacy row is reported, not hidden: corruptRows=${bad.corruptRows.length} (${bad.corruptRows[0]?.sessionId}:${bad.corruptRows[0]?.turnId}, column "${bad.corruptRows[0]?.column}")`);
const turn = mgr.refineTurn({ turnId: '0', user: 'legacy summary about locking', agentText: 'Updated by a later refinement.', actions: [] }, 's_old');
await mgr.saveRefinedTurns('s_old', [turn]);
const after = mgr.loadRefinedTurn('s_old', 0);
console.log(`UPSERT on a legacy row: summary now "${after?.summary}"; id preserved by key (s_old:0)=${after?.sessionId === 's_old' && after?.turnId === 0}`);
await mgr.saveSessionProgress({ sessionId: 's_old', wireIdentity: '{"refinedCount":3}', lastOffset: 0, lastCompleteLineOffset: 0, lastSize: 1234, lastMtimeNs: '1795415899299579648', lastIndexedAt: new Date().toISOString(), extractorVersion: '1' });
console.log(`progress round trip after migration: ${mgr.getSessionProgress('s_old')?.lastMtimeNs}`);
const reopened = new RefinedManager(refinedRoot);
console.log(`second open is a no-op migration: schema=${reopened.getSchemaVersion()} rows=${reopened.countAll()}`);
mgr.close(); reopened.close();
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
