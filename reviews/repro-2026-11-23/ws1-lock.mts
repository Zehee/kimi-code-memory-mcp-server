/** S4b/S4c: isolate (b) the checkpoint write without busy retry and (c) the full save-retry stall. */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const REPO = 'D:/workspace/kimi-code-memory-mcp-server/src';
const imp = (rel: string) => import(pathToFileURL(path.join(REPO, rel)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ws1b-'));
process.env.MEMORY_STORE_ROOT = path.join(tmp, 'store');
process.env.MEMORY_SESSIONS_ROOT = path.join(tmp, 'sessions');
const { RefinedManager } = await imp('refined-manager.ts');
const { refineSessionBatch } = await imp('background/refine-batch.ts');
const { metrics } = await imp('utils/metrics.ts');
const t0 = 1_760_000_000_000;
const complete = (i: number) => [
  JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: `question ${i}` }], turnId: String(i), time: t0 + i * 60_000 }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: String(i) }, time: t0 + i * 60_000 + 5 }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: `answer ${i}` }, turnId: String(i) }, time: t0 + i * 60_000 + 1000 }),
];
const mk = (sid: string) => {
  const wire = path.join(tmp, `${sid}.jsonl`);
  fs.writeFileSync(wire, [...complete(0), ...complete(1)].join('\n') + '\n');
  return { sessionId: sid, wire, mtime: 0 };
};
const mgr = new RefinedManager(path.join(tmp, 'refined'));
const ctx: any = { refinedManager: mgr };
const dbPath = path.join(tmp, 'refined', 'refined.sqlite');

console.log('=== S4c: saveRefinedTurns while another process holds the write lock ===');
const a = mk('session_a');
let loopBeats = 0; const beat = setInterval(() => { loopBeats++; }, 10);
const holder = new DatabaseSync(dbPath);
holder.exec('BEGIN IMMEDIATE');
let t = Date.now();
try { await refineSessionBatch(ctx, a as any, 200); console.log('  no error'); }
catch (err: any) { console.log(`  threw after ${Date.now() - t}ms -> ${err.name} (retryable=${err.retryable}): ${String(err.message).slice(0, 60)}`); }
holder.exec('ROLLBACK'); holder.close();
const beatsDuringStall = loopBeats; clearInterval(beat);
console.log(`  event-loop heartbeats (10ms timer) observed during the stall: ${beatsDuringStall}`);
console.log(`  metrics: refined_busy_retry=${(metrics as any).get?.('refined_busy_retry') ?? JSON.stringify((metrics as any).snapshot?.()?.counters?.refined_busy_retry)} refined_busy_exhausted=${JSON.stringify((metrics as any).snapshot?.()?.counters?.refined_busy_exhausted)}`);

console.log('=== S4b: checkpoint write only (all rows present, checkpoint missing = upgrade shape) ===');
const b = mk('session_b');
await refineSessionBatch(ctx, b as any, 200);
const holder2 = new DatabaseSync(dbPath);
holder2.exec(`DELETE FROM refined_session_progress WHERE session_id = 'session_b'`);
holder2.exec('BEGIN IMMEDIATE');
t = Date.now();
try { await refineSessionBatch(ctx, b as any, 200); console.log('  no error'); }
catch (err: any) { console.log(`  threw after ${Date.now() - t}ms -> name=${err.name} retryable=${err.retryable} message=${String(err.message).slice(0, 60)}`); }
holder2.exec('ROLLBACK'); holder2.close();
t = Date.now();
const again = await refineSessionBatch(ctx, b as any, 200);
console.log(`  after the lock is released: returned ${again} in ${Date.now() - t}ms (self-heals)`);
mgr.close();
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
