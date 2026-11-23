/** Self-audit: recompute U-01 / U-06 statistics over ONLY the wires the indexer actually sees. */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.MEMORY_STORE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'review-sa-'));
const { findAllWorkspaceSessions } = await import(pathToFileURL('D:/workspace/kimi-code-memory-mcp-server/src/context/wire-context.ts').href);
const found = findAllWorkspaceSessions();
const all = [...found].sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0)).slice(0, 200);
let bytes = 0, lines = 0, prompts = 0; const durations: number[] = [];
const t0 = performance.now();
for (const s of all) {
  const st = fs.statSync(s.wire);
  if (st.size > 8 * 1024 * 1024) continue;               // the gauge only reads files <= 8 MiB
  const content = fs.readFileSync(s.wire, 'utf8'); bytes += st.size;
  let open = -1;
  for (const line of content.split('\n')) {
    if (!line.trim()) continue; lines++;
    if (!line.includes('turn.prompt') && !line.includes('turn.ended')) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'turn.prompt') { prompts++; open = new Date(ev.time).getTime(); }
    else if (ev.type === 'turn.ended' && open >= 0) { durations.push(new Date(ev.time).getTime() - open); open = -1; }
  }
}
const ms = performance.now() - t0;
durations.sort((a, b) => a - b);
const q = (p: number) => durations[Math.min(durations.length - 1, Math.floor(durations.length * p))];
const over60 = durations.filter((d) => d > 60_000).length;
const over10 = durations.filter((d) => d > 10_000).length;
// Expected frozen share if tick phase is uniform: min(1, duration / 60s) per turn.
const expectedFrozen = durations.reduce((acc, d) => acc + Math.min(1, d / 60_000), 0) / durations.length;
console.log(JSON.stringify({
  wiresSeenByIndexer: all.length, mibReadPerTick: +(bytes / 1024 / 1024).toFixed(1), synchronousMs: +ms.toFixed(0),
  trueTurns: prompts, linesOver3: Math.floor(lines / 3), overestimateFactor: +(Math.floor(lines / 3) / prompts).toFixed(1), linesPerTurn: +(lines / prompts).toFixed(1),
  measuredTurns: durations.length, medianMs: q(0.5), p90Ms: q(0.9), p99Ms: q(0.9),
  turnsOver60s: over60, pctOver60s: +(100 * over60 / durations.length).toFixed(1), pctOver10s: +(100 * over10 / durations.length).toFixed(1),
  expectedFrozenShareIfTickPhaseUniform: +(100 * expectedFrozen).toFixed(1) + '%',
}));
