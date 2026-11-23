/** Verify the audit's search_context claims against the repo source (default detail, trimming, unreadable wire, corrupt line, dates, cluster cap). */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
const REPO = 'D:/workspace/kimi-code-memory-mcp-server';
const imp = (rel: string) => import(pathToFileURL(path.join(REPO, 'src', rel)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ws9-'));
const storeRoot = path.join(tmp, 'store'); fs.mkdirSync(storeRoot, { recursive: true });
process.env.MEMORY_STORE_ROOT = storeRoot; process.env.MEMORY_SESSIONS_ROOT = path.join(tmp, 'sessions');
const { MemoryStore } = await imp('dao/memory-store.ts');
const { ThemeManager } = await imp('theme-manager.ts');
const { RefinedManager } = await imp('refined-manager.ts');
const { createContextTools } = await imp('tools/context-tools.ts');
const { computeWorkspaceHash } = await imp('utils/paths.ts');
const { metrics } = await imp('utils/metrics.ts');
const sessionsRoot = path.join(tmp, 'sessions');
const slug = `wd_review_${computeWorkspaceHash(REPO)}`;
const t0 = 1_760_000_000_000;
const writeSession = (id: string, turnCount: number, needle: string, agentLen: number) => {
  const dir = path.join(sessionsRoot, slug, id, 'agents', 'main'); fs.mkdirSync(dir, { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < turnCount; i++) {
    lines.push(JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: `${needle} question ${i}` }], turnId: String(i), time: t0 + i * 60_000 }));
    lines.push(JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: `${needle} answer ${i} `.padEnd(agentLen, 'x') }, turnId: String(i) }, time: t0 + i * 60_000 + 1 }));
  }
  fs.writeFileSync(path.join(dir, 'wire.jsonl'), lines.join('\n') + '\n', 'utf8');
};
const manager = new RefinedManager(path.join(tmp, 'refined'));
const ctx: any = { cwd: tmp, workspaceId: 'ws', storeRoot, indexDao: {}, memoryStore: new MemoryStore(storeRoot), themeManager: new ThemeManager(path.join(storeRoot, 'themes')), refinedManager: manager };
const tool = createContextTools(ctx).find((t) => t.name === 'search_context')!;
const call = async (args: Record<string, unknown>) => { try { const r: any = await tool.handler({ save_view: false, ...args }); return JSON.parse(r.content[0].text); } catch (e: any) { return { __threw: `${e.name}: ${String(e.message).split('\n')[0].slice(0, 90)}` }; } };
const brief = (r: any) => r.__threw ? `THREW ${r.__threw}` : `matches=${r.matches?.length} returnedMatches=${r.returnedMatches} matchCount=${r.matchCount} totalMatches=${r.totalMatches} isComplete=${r.isComplete} truncationReason=${r.truncationReason} nextCursor=${r.nextCursor} outputTruncated=${r.outputTruncated} refinedCount=${r.refinedCount}`;

console.log('=== S1: default detail, default output budget ===');
writeSession('session_a', 10, 'needle', 400);
const s1 = await call({ query: 'needle' });
console.log(`  ${brief(s1)}`);
if (!s1.__threw) console.log(`  -> ${s1.returnedMatches - s1.matches.length} match(es) dropped from the payload; reported as returned: ${s1.returnedMatches}; resume cursor offered: ${s1.nextCursor ?? 'none'}`);

console.log('=== S2: corrupt JSON line that contains the keyword ===');
{ const wire = path.join(sessionsRoot, slug, 'session_a', 'agents', 'main', 'wire.jsonl'); fs.appendFileSync(wire, '{"type":"turn.prompt","input":[{"type":"text","text":"zzqunique torn line'); }
const before = (metrics.snapshot() as any).counters['wire_parse_corrupt_lines'] ?? 0;
const s2 = await call({ query: 'zzqunique', detail: 'compact' });
console.log(`  ${brief(s2)}  corruptLinesCounter+=${((metrics.snapshot() as any).counters['wire_parse_corrupt_lines'] ?? 0) - before}`);

console.log('=== S3: unreadable wire (a directory named wire.jsonl) in another session ===');
fs.mkdirSync(path.join(sessionsRoot, slug, 'session_b', 'agents', 'main', 'wire.jsonl'), { recursive: true });
const s3 = await call({ query: 'needle', detail: 'compact' });
console.log(`  ${brief(s3)}`);

console.log('=== S4: invalid date strings ===');
fs.rmSync(path.join(sessionsRoot, slug, 'session_b'), { recursive: true, force: true });
for (const d of ['2025-01-01', '2024-5-1', '2024-13-45', 'not-a-date']) { const r = await call({ query: 'needle', detail: 'compact', date_from: d }); console.log(`  date_from=${JSON.stringify(d).padEnd(14)} -> ${r.__threw ? 'THREW' : `success=${r.success !== false} matchCount=${r.matchCount} error=${r.error ?? 'none'}`}`); }

console.log('=== S5: cluster candidates / refinement side effects per request ===');
writeSession('session_c', 300, 'clneedle', 120);
const s5a = await call({ query: 'clneedle', detail: 'compact', limit: 100 });
console.log(`  limit=100, default cluster size -> ${brief(s5a)}  clusterMembers=${(s5a.clusters ?? []).reduce((n: number, c: any) => n + (c.memberCount ?? 0), 0)}`);
const s5b = await call({ query: 'clneedle', detail: 'compact', limit: 100, max_cluster_size: 100000 });
console.log(`  limit=100, max_cluster_size=100000 -> accepted=${!s5b.__threw && s5b.success !== false} clusterMembers=${(s5b.clusters ?? []).reduce((n: number, c: any) => n + (c.memberCount ?? 0), 0)} rowsInStore=${manager.countAll()}`);
manager.close();
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
process.exit(0);
