/**
 * WS1 repro — background indexer / refine-batch, driven through the REAL
 * refineSessionBatch + BackgroundIndexer + RefinedManager (sources via tsx).
 * Wire lines use the shapes observed in real wire.jsonl files
 * (event.turnId is a string INSIDE `event`; `time` is epoch ms).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const REPO = 'D:/workspace/kimi-code-memory-mcp-server/src';
const imp = (rel: string) => import(pathToFileURL(path.join(REPO, rel)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ws1-'));
process.env.MEMORY_STORE_ROOT = path.join(tmp, 'store');
process.env.MEMORY_SESSIONS_ROOT = path.join(tmp, 'sessions');

const { RefinedManager } = await imp('refined-manager.ts');
const { refineSessionBatch } = await imp('background/refine-batch.ts');
const { BackgroundIndexer } = await imp('background/indexer.ts');
const { parseWireFile } = await imp('context/wire-context.ts');

const t0 = 1_760_000_000_000;
const prompt = (text: string, i: number) => JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text }], turnId: String(i), time: t0 + i * 60_000 });
const stepBegin = (i: number) => JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: String(i) }, time: t0 + i * 60_000 + 5 });
const toolCall = (i: number, name: string, filePath: string) => JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', name, args: { file_path: filePath }, toolCallId: `tc_${i}_${name}` , turnId: String(i) }, time: t0 + i * 60_000 + 500 });
const toolResult = (i: number, name: string) => JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: `tc_${i}_${name}`, result: { ok: true } }, time: t0 + i * 60_000 + 900 });
const content = (i: number, text: string) => JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text }, turnId: String(i) }, time: t0 + i * 60_000 + 1000 });

const sessionId = 'session_review_0001';
const wire = path.join(tmp, 'wire.jsonl');
const write = (lines: string[]) => fs.writeFileSync(wire, lines.join('\n') + '\n', 'utf8');
const ctx: any = { refinedManager: new RefinedManager(path.join(tmp, 'refined')) };
const sessions = [{ sessionId, wire, mtime: 0 }];
const indexer = new BackgroundIndexer(
  path.join(tmp, 'refined'),
  () => sessions,
  (session: any, budget: number, signal?: AbortSignal) => refineSessionBatch(ctx, session, budget, signal),
  { intervalMs: 3_600_000, budgetTurns: 200 },
);
const row = (id: number) => ctx.refinedManager.loadRefinedTurn(sessionId, id);
const show = (label: string, r: any) => console.log(`  ${label}: summary=${JSON.stringify(r?.summary)} facts=${JSON.stringify(r?.facts)} files=${JSON.stringify(r?.entities?.files)} tools=${JSON.stringify(r?.entities?.tools)}`);

console.log('\n=== S1: turn in flight when the tick lands ===');
// The host writes turn.prompt first; the agent works for minutes.
write([prompt('how do I fix the flaky lock test', 0), stepBegin(0)]);
await indexer.runTick();
show('row 0 after tick DURING the turn', row(0));
// ...the turn completes: tool calls + the agent's answer are appended.
write([
  prompt('how do I fix the flaky lock test', 0), stepBegin(0),
  toolCall(0, 'Edit', 'src/utils/workspace-lock.ts'), toolResult(0, 'Edit'),
  content(0, 'Implemented death detection in the workspace lock.\n- Added isLockStale gate before rename-claim'),
]);
const n = await indexer.runTick();
console.log(`  turn completed -> next tick refined ${n} turn(s); lag gauge = ${await indexer.measureLag()}`);
show('row 0 AFTER the turn completed', row(0));
const hits = ctx.refinedManager.searchRefinedTurns({ query: 'isLockStale' });
console.log(`  refined search "isLockStale": ${hits.length} match(es)`);
const truth = await parseWireFile(wire);
console.log(`  (wire turn 0 agentText starts with: ${JSON.stringify(truth.turns[0].agentText.slice(0, 32))})`);

console.log('\n=== S2: deliberately deleted refined rows ===');
await ctx.refinedManager.deleteRefinedTurns([{ sessionId, turnId: 0 }]);
console.log(`  rows after deleteRefinedTurns: ${ctx.refinedManager.listRefinedTurnIds(sessionId).length}`);
const rebuilt = await indexer.runTick();
console.log(`  next tick rebuilt ${rebuilt} row(s) -> rows now: ${ctx.refinedManager.listRefinedTurnIds(sessionId).length}`);

console.log('\n=== S3: reading existing turn ids fails (busy/locked db) ===');
const real = ctx.refinedManager;
let savedIds: number[] = [];
ctx.refinedManager = {
  ...real,
  listRefinedTurnStates: () => { throw new Error('Refined database is busy (retryable): database is locked'); },
  refineTurn: real.refineTurn.bind(real),
  saveRefinedTurns: async (sid: string, turns: any[]) => { savedIds = turns.map((t) => t.turnId); },
  getSessionProgress: real.getSessionProgress.bind(real),
  saveSessionProgress: async () => {},
};
// Make the checkpoint stale so the shortcut cannot hide the path.
fs.appendFileSync(wire, prompt('second question', 1) + '\n' + stepBegin(1) + '\n', 'utf8');
try {
  const r = await refineSessionBatch(ctx, { sessionId, wire } as any, 200);
  console.log(`  unexpected success ${r}; saveRefinedTurns was called for turn ids ${JSON.stringify(savedIds)}`);
} catch (err: any) {
  console.log(`  state-read failure propagated as expected: ${err.message}`);
}

console.log('\n=== S4: progress checkpoint write vs. a held write lock (upgrade shape: rows exist, no checkpoint) ===');
ctx.refinedManager = real;
const db = new DatabaseSync(path.join(tmp, 'refined', 'refined.sqlite'));
db.exec('BEGIN IMMEDIATE'); // another process holds the write lock
const started = Date.now();
try {
  await refineSessionBatch(ctx, { sessionId, wire } as any, 200);
  console.log('  no error');
} catch (err: any) {
  console.log(`  threw after ${Date.now() - started}ms: ${err.name}: ${String(err.message).slice(0, 70)}`);
} finally {
  db.exec('ROLLBACK'); db.close();
}

console.log('\n=== S5: the test-suite fixture shape (content.part turnId at the OUTER level) ===');
const fixtureWire = path.join(tmp, 'fixture.jsonl');
fs.writeFileSync(fixtureWire, [
  JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'bg probe 0' }], time: '2024-05-01T10:00:00.000Z' }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: 0 }, time: '2024-05-01T10:00:00.000Z' }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'bg answer 0' } }, turnId: 0, time: '2024-05-01T10:00:00.000Z' }),
].join('\n') + '\n', 'utf8');
const parsed = await parseWireFile(fixtureWire);
console.log(`  parser result: turnCount=${parsed.turns.length} agentText=${JSON.stringify(parsed.turns[0]?.agentText)}  <- the fixture's answer is never attached`);

ctx.refinedManager.close();
fs.rmSync(tmp, { recursive: true, force: true });
