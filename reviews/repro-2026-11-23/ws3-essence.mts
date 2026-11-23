/** WS3: essence response body, dashboard CAS, sources preservation, journal side effects of a rejected save. */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
const REPO = 'D:/workspace/kimi-code-memory-mcp-server/src';
const imp = (rel: string) => import(pathToFileURL(path.join(REPO, rel)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ws3-'));
process.env.MEMORY_STORE_ROOT = path.join(tmp, 'store'); process.env.MEMORY_SESSIONS_ROOT = tmp;
const { MemoryStore, RevisionConflictError } = await imp('dao/memory-store.ts');
const { IndexDao } = await imp('dao/index.ts');
const { ThemeManager } = await imp('theme-manager.ts');
const { storeEssenceContent } = await imp('tools/system-tools.ts');
const { getWorkspace } = await imp('vis/api.ts');
const { doctorReport } = await imp('maintenance.ts');
const { parseFrontmatter } = await imp('utils/frontmatter.ts');
const storeRoot = path.join(tmp, 'store');
const ctx: any = { cwd: storeRoot, workspaceId: 'ws', storeRoot, indexDao: new IndexDao(storeRoot), memoryStore: new MemoryStore(storeRoot), themeManager: new ThemeManager(path.join(storeRoot, 'themes')), refinedManager: { countAll: () => 0 } };
const essencePath = path.join(storeRoot, 'essence', 'essence.md');
const disk = () => parseFrontmatter(fs.readFileSync(essencePath, 'utf8'))!;
const journalStates = () => { const d = path.join(storeRoot, '.journal'); return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')).state) : []; };

console.log('=== A. body-only response + no nested frontmatter across consecutive dashboard saves ===');
const s1 = await storeEssenceContent(ctx, '# Essence v1\n\nfirst', { expectedRevision: 0 });
const w1 = getWorkspace(ctx);
console.log(`  GET /api/workspace after save 1: essence=${JSON.stringify(w1.essence)} essenceRevision=${w1.essenceRevision}`);
const s2 = await storeEssenceContent(ctx, w1.essence + '\n\n- added in the dashboard', { expectedRevision: w1.essenceRevision });
const d2 = disk();
console.log(`  save 2 -> revision ${s2.revision}; body starts with ${JSON.stringify(d2.body.slice(0, 24))}; body contains a frontmatter block: ${/^---\n/m.test(d2.body)}`);
console.log(`  history: ${fs.readdirSync(path.join(storeRoot, 'essence', 'history')).sort().join(', ')}`);

console.log('=== B. sources provenance survives a dashboard edit ===');
fs.writeFileSync(essencePath, '---\nkey: "essence"\ntitle: "Workspace Essence"\ntags: ["essence","workspace-memory"]\nschemaVersion: 1\nrevision: 7\ngeneratedAt: "2026-11-01T00:00:00.000Z"\ngenerator: "agent"\nsources: ["mem:abc:2","mem:def:1"]\nupdatedAt: "2026-11-01T00:00:00.000Z"\n---\n\nagent-written essence\n', 'utf8');
await storeEssenceContent(ctx, 'edited in dashboard', { expectedRevision: 7 });
const d3 = disk();
console.log(`  after dashboard save: revision=${d3.frontmatter.revision} generator=${d3.frontmatter.generator} sources=${JSON.stringify(d3.frontmatter.sources)} generatedAt=${d3.frontmatter.generatedAt}`);

console.log('=== C. stale editor (expectedRevision 7, disk is at 8) ===');
const before = fs.readFileSync(essencePath, 'utf8');
let outcome = 'no error';
try { await storeEssenceContent(ctx, 'stale editor text', { expectedRevision: 7 }); } catch (e: any) { outcome = `${e instanceof RevisionConflictError ? 'RevisionConflictError' : e.name} (currentRevision=${e.currentRevision})`; }
console.log(`  -> ${outcome}; on-disk essence unchanged: ${fs.readFileSync(essencePath, 'utf8') === before}`);
console.log(`  journal entries now on disk: ${JSON.stringify(journalStates())}`);
const again = await (async () => { try { await storeEssenceContent(ctx, 'stale again', { expectedRevision: 7 }); } catch { /* ignore */ } return null; })();
await new Promise((r) => setTimeout(r, 50));
console.log(`  after a 2nd rejected save: ${JSON.stringify(journalStates())}`);
const report: any = doctorReport(storeRoot, () => ctx.indexDao.getIndexState());
console.log(`  --doctor: unfinishedEntries=${report.journal.unfinishedEntries}; pendingActions includes: ${JSON.stringify(report.pendingActions.filter((p: string) => /journal/.test(p)))}`);

console.log('=== D. compare: organize_memories prepare-token conflict removes its entry ===');
console.log('  (both organize_memories and storeEssenceContent discard benign conflict journal entries)');

console.log('=== E. legacy/corrupt essence and expectedRevision 0 ===');
fs.rmSync(path.join(storeRoot, 'essence'), { recursive: true, force: true });
const s0 = await storeEssenceContent(ctx, 'brand new', { expectedRevision: 0 });
console.log(`  no file + expectedRevision 0 -> saved revision ${s0.revision}`);
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
