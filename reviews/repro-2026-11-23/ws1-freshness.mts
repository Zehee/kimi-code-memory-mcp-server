/** Target doc §增量索引的新鲜度: rules for shrink / identity change / extractor version change. */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const REPO = 'D:/workspace/kimi-code-memory-mcp-server/src';
const imp = (rel: string) => import(pathToFileURL(path.join(REPO, rel)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ws1c-'));
process.env.MEMORY_STORE_ROOT = path.join(tmp, 'store'); process.env.MEMORY_SESSIONS_ROOT = tmp;
const { RefinedManager } = await imp('refined-manager.ts');
const { refineSessionBatch } = await imp('background/refine-batch.ts');
const t0 = 1_760_000_000_000;
const turn = (i: number, q: string, a: string) => [
  JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: q }], turnId: String(i), time: t0 + i * 60_000 }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: String(i) }, time: t0 + i * 60_000 + 5 }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: a }, turnId: String(i) }, time: t0 + i * 60_000 + 1000 }),
];
const sessionId = 'session_rewind';
const wire = path.join(tmp, 'wire.jsonl');
const mgr = new RefinedManager(path.join(tmp, 'refined'));
const ctx: any = { refinedManager: mgr };
const session = { sessionId, wire, mtime: 0 };
const summaries = () => mgr.listRefinedTurnIds(sessionId).sort((a, b) => a - b).map((id) => `${id}:${JSON.stringify(mgr.loadRefinedTurn(sessionId, id)?.summary.slice(0, 34))}`).join('  ');

console.log('=== rule: "wire 变小或身份变化：该 session 索引作废并重建" ===');
fs.writeFileSync(wire, [0, 1, 2, 3].map((i) => turn(i, `question ${i} about topic${i}`, `answer ${i} about topic${i}`)).flat().join('\n') + '\n');
await refineSessionBatch(ctx, session, 200);
console.log(`  indexed 4 turns: ${summaries()}`);
// The host rewinds the session: the wire is rewritten with a shorter, different history.
fs.writeFileSync(wire, [0, 1].map((i) => turn(i, `REWOUND question ${i} about something else`, `REWOUND answer ${i}`)).flat().join('\n') + '\n');
const n = await refineSessionBatch(ctx, session, 200);
const db = new DatabaseSync(path.join(tmp, 'refined', 'refined.sqlite'));
const stored = (db.prepare('SELECT turn_id, summary FROM refined_turns WHERE session_id = ? ORDER BY turn_id').all(sessionId)) as any[];
console.log(`  wire shrank 4 -> 2 turns; next batch call refined ${n} turn(s)`);
console.log(`  refined rows now: ${stored.map((r) => `${r.turn_id}:${JSON.stringify(String(r.summary).slice(0, 30))}`).join('  ')}`);
console.log(`  -> row for turn 1 describes the OLD turn 1 while the wire now says "REWOUND question 1"; rows 2-3 are orphaned: ${stored.length > 2 ? 'yes' : 'no'}`);
console.log(`  -> refined search for vanished content "topic3": ${mgr.searchRefinedTurns({ query: 'topic3' }).length} match(es)`);

console.log('=== rule: "extractor 版本变化：后台逐步重建，不让新旧摘要静默混用" ===');
db.exec("UPDATE refined_turns SET extractor_version = '0'");            // rows built by an older extractor
db.exec("UPDATE refined_session_progress SET extractor_version = '0'"); // checkpoint written by it too
db.close();
const m = await refineSessionBatch(ctx, session, 200);
const db2 = new DatabaseSync(path.join(tmp, 'refined', 'refined.sqlite'));
const versions = (db2.prepare('SELECT extractor_version AS v, COUNT(*) AS c FROM refined_turns GROUP BY extractor_version').all()) as any[];
console.log(`  extractor version changed 0 -> 1; background call refined ${m} turn(s)`);
console.log(`  rows by extractor_version afterwards: ${JSON.stringify(versions)}  (checkpoint says: ${mgr.getSessionProgress(sessionId)?.extractorVersion})`);
console.log(`  -> checkpoint is stamped with the NEW version while every row still carries the old one: ${mgr.getSessionProgress(sessionId)?.extractorVersion === '1' && versions.every((r) => r.v === '0') ? 'yes (old summaries now exempt from any rebuild)' : 'no'}`);
db2.close(); mgr.close();
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
