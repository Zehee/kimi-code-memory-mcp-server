/**
 * Baseline performance benchmark (audit acceptance matrix scenario 26).
 *
 * Generates a fixed corpus inside a temporary directory — 1,000 memory
 * entries, 100 sessions with 10,000 turns, ten sessions with oversized turns
 * — and reports latency distributions for `searchWireContext` and a full
 * index reconcile.
 *
 * The numbers are a BASELINE for the current machine, not an SLO. Compare
 * runs against each other; do not treat them as universal constants.
 *
 * Run:  npm run bench
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { MemoryStore } from '../src/dao/memory-store.js';
import { IndexDao } from '../src/dao/index.js';
import { searchWireContext } from '../src/context/wire-context.js';
import { computeWorkspaceHash } from '../src/utils/paths.js';

const MEMORY_COUNT = Number(process.env.BENCH_MEMORIES ?? 1_000);
const SESSION_COUNT = Number(process.env.BENCH_SESSIONS ?? 100);
const TURNS_PER_SESSION = Number(process.env.BENCH_TURNS ?? 100);

function writeSessionWire(
  sessionsRoot: string,
  slugDir: string,
  sessionId: string,
  turns: number,
  oversized: boolean,
): void {
  const dir = path.join(sessionsRoot, slugDir, sessionId, 'agents', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < turns; i++) {
    const time = new Date(Date.UTC(2024, 0, 1 + (i % 28), 10, i % 60)).toISOString();
    const filler = oversized ? ' padding '.repeat(300) : '';
    lines.push(
      JSON.stringify({
        type: 'turn.prompt',
        input: [{ type: 'text', text: `bench turn ${i}: discussed the deploy pipeline and rollback plan${filler}` }],
        time,
      }),
    );
    lines.push(
      JSON.stringify({ type: 'context.append_loop_event', event: { type: 'step.begin', turnId: i }, time }),
    );
    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        event: {
          type: 'content.part',
          part: { type: 'text', text: `bench answer ${i}: changed src/config.ts and ran the tests${filler}` },
          turnId: i,
        },
      }),
    );
  }
  fs.writeFileSync(path.join(dir, 'wire.jsonl'), `${lines.join('\n')}\n`, 'utf8');
}

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-bench-'));
  const storeRoot = path.join(tmp, 'store');
  const sessionsRoot = path.join(tmp, 'sessions');
  fs.mkdirSync(storeRoot, { recursive: true });
  fs.mkdirSync(sessionsRoot, { recursive: true });
  process.env.MEMORY_STORE_ROOT = storeRoot;
  process.env.MEMORY_SESSIONS_ROOT = sessionsRoot;

  // The session directory must embed the same cwd hash the host uses so the
  // discovery (wd_<slug>_<hash>) actually finds the benchmark sessions.
  const slugDir = `wd_bench_${computeWorkspaceHash(process.cwd().replace(/\\/g, '/'))}`;

  console.log(`Corpus: ${MEMORY_COUNT} memories, ${SESSION_COUNT} sessions × ${TURNS_PER_SESSION} turns`);
  console.log('Generating…');

  const genStart = Date.now();
  const store = new MemoryStore(storeRoot);
  for (let i = 0; i < MEMORY_COUNT; i++) {
    store.writeWithResult(
      `memory/bulk/bucket${i % 20}`,
      `entry-${i}`,
      `# Entry ${i}\n\nDecision ${i}: deploy the ${['auth', 'cache', 'search', 'ui', 'cli'][i % 5]} module with a staged rollout and rollback plan.`,
      ['bench'],
    );
  }
  for (let s = 0; s < SESSION_COUNT; s++) {
    writeSessionWire(sessionsRoot, slugDir, `session_bench_${String(s).padStart(4, '0')}`, TURNS_PER_SESSION, s % 10 === 0);
  }
  console.log(`Generation took ${((Date.now() - genStart) / 1000).toFixed(1)}s\n`);

  const queries = [
    'deploy rollback',
    'auth decision',
    'cache rollout',
    'typescript error config',
    'completely unrelated gibberish query',
  ];

  console.log('searchWireContext (limit 10):');
  for (const query of queries) {
    const samples: number[] = [];
    let matchCount = 0;
    let isComplete = true;
    for (let run = 0; run < 3; run++) {
      const start = Date.now();
      const result = await searchWireContext(query, { limit: 10 });
      samples.push(Date.now() - start);
      matchCount = result.matchCount;
      isComplete = result.isComplete;
    }
    console.log(
      `  ${JSON.stringify(query).padEnd(40)} median ${percentile(samples, 50).toString().padStart(6)}ms  ` +
        `p95 ${percentile(samples, 95).toString().padStart(6)}ms  matches ${matchCount}  complete ${isComplete}`,
    );
  }

  const indexDao = new IndexDao(storeRoot);
  const reconcileStart = Date.now();
  const report = await indexDao.reconcileIndex();
  const reconcileMs = Date.now() - reconcileStart;
  console.log(
    `\nreconcileIndex over the corpus: ${reconcileMs}ms (scanned ${report.report.scannedFiles} files, ` +
      `${report.report.addedEntries} added, corrupt ${report.corruptFiles.length})`,
  );

  const rss = (process.memoryUsage().rss / 1024 / 1024).toFixed(0);
  console.log(`Peak RSS of this process: ${rss} MiB`);
  console.log('\nBaseline only — rerun on the same machine to compare, do not read as an SLO.');

  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Best effort.
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
