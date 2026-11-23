/** WS2: metadataHash stability across write paths, external metadata edit, legacy backfill reporting, key ordering. */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
const REPO = 'D:/workspace/kimi-code-memory-mcp-server/src';
const imp = (rel: string) => import(pathToFileURL(path.join(REPO, rel)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ws2-'));
process.env.MEMORY_STORE_ROOT = path.join(tmp, 'store');
const { MemoryStore, RevisionConflictError, hashContent } = await imp('dao/memory-store.ts');
const { IndexDao } = await imp('dao/index.ts');
const { parseFrontmatter } = await imp('utils/frontmatter.ts');
const storeRoot = path.join(tmp, 'store');
const store = new MemoryStore(storeRoot);
const dao = new IndexDao(storeRoot);

const storedMetaHash = (p: string) => { const parsed = parseFrontmatter(fs.readFileSync(p, 'utf8'))!; return String(parsed.frontmatter.metadataHash).slice(0, 14); };
const stable = async (label: string, folder: string, key: string, expectRevision: number) => {
  const a = store.syncIdentity(folder, key); const b = store.syncIdentity(folder, key); const c = store.syncIdentity(folder, key);
  const file = store.findExistingFile(folder, key)!;
  const ok = !a.changed && !b.changed && !c.changed && a.identity!.revision === expectRevision;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label.padEnd(44)} revision=${a.identity!.revision} (expected ${expectRevision}) changed=${a.changed}/${b.changed}/${c.changed} metadataHash=${storedMetaHash(file)}`);
  return ok;
};

console.log('=== A. every write path must leave a file whose stored metadataHash equals the recomputed one (no drift, no spurious revision bump) ===');
let r = store.writeWithResult('memory/decisions', 'alpha', 'body alpha', ['decision']);
await stable('remember (new)', 'memory/decisions', 'alpha', r.revision);
r = store.writeWithResult('memory/decisions', 'alpha', 'body alpha v2', ['decision', 'fix'], { expectedRevision: r.revision });
await stable('remember (update + tags)', 'memory/decisions', 'alpha', r.revision);
r = store.writeWithResult('memory/decisions', 'alpha', 'body alpha v3', undefined, { sourceRefs: ['s1:3'], supersedes: 'mem_old', sensitivity: 'private', title: 'He said: "hi" #1 — 中文' });
await stable('remember (governance + tricky title)', 'memory/decisions', 'alpha', r.revision);
r = store.writeWithResult('memory/decisions', 'alpha', 'body alpha v4', []);   // clears tags
await stable('remember (tags cleared)', 'memory/decisions', 'alpha', r.revision);
const moved = store.moveWithResult('memory/decisions', 'alpha', 'memory/rules', 'alpha-renamed');
await stable('move + rename', 'memory/rules', 'alpha-renamed', moved.revision);
const del = store.deleteWithResult('memory/rules', 'alpha-renamed');
const restored = store.restoreWithResult('memory/rules', 'alpha-renamed');
await stable('delete -> restore', 'memory/rules', 'alpha-renamed', restored!.revision);

console.log('=== B. external metadata-only edit (tags edited by hand, body untouched) ===');
const file = store.findExistingFile('memory/rules', 'alpha-renamed')!;
const before = store.syncIdentity('memory/rules', 'alpha-renamed').identity!;
const raw = fs.readFileSync(file, 'utf8').replace('tags: []', 'tags: ["rule", "edited-by-hand"]');
fs.writeFileSync(file, raw, 'utf8');
await dao.reconcileIndex();
const after = store.syncIdentity('memory/rules', 'alpha-renamed').identity!;
console.log(`  revision ${before.revision} -> ${after.revision}; tags on disk now: ${JSON.stringify(parseFrontmatter(fs.readFileSync(file, 'utf8'))!.frontmatter.tags)}; contentHash unchanged=${before.contentHash === after.contentHash}`);
let conflict = 'no conflict';
try { store.writeWithResult('memory/rules', 'alpha-renamed', 'stale writer', undefined, { expectedRevision: before.revision }); } catch (e: any) { conflict = e instanceof RevisionConflictError ? 'RevisionConflictError' : `other: ${e.name}`; }
console.log(`  CAS write with the pre-edit revision: ${conflict}`);
const again = await dao.reconcileIndex(); const third = await dao.reconcileIndex();
console.log(`  reconcile reports: first-after-edit revisionsBumped=${(await dao.reconcileIndex()).revisionsBumped} (steady state), third skipped=${third.skipped}`);

console.log('=== C. legacy file (v0.5.1 shape: no id / contentHash / metadataHash) ===');
fs.mkdirSync(path.join(storeRoot, 'memory', 'knowledge'), { recursive: true });
fs.writeFileSync(path.join(storeRoot, 'memory', 'knowledge', 'legacy.md'), '---\ntitle: "Legacy"\ntags: ["knowledge"]\ncreatedAt: "2026-01-01T00:00:00.000Z"\nupdatedAt: "2026-01-01T00:00:00.000Z"\nrevision: 5\n---\n\nlegacy body\n', 'utf8');
const o1 = await dao.reconcileIndex();
const legacyIdentity = store.syncIdentity('memory/knowledge', 'legacy').identity!;
console.log(`  first reconcile: revisionsBumped=${o1.revisionsBumped} but the file's revision number is still ${legacyIdentity.revision} (was 5) -> the counter reports identity BACKFILLS, not revision changes`);
console.log(`  second reconcile: revisionsBumped=${(await dao.reconcileIndex()).revisionsBumped}`);

console.log('=== D. canonical key ordering used by hashMetadata (String.localeCompare with no locale argument) ===');
const keys = ['id', 'key', 'title', 'tags', 'createdAt', 'schemaVersion', 'sources', 'sourceRefs', 'supersedes', 'sensitivity', 'generator', 'generatedAt', 'deletedAt', 'deletedFrom'];
const orders = new Map<string, string[]>();
for (const loc of ['und', 'en', 'en-US', 'de', 'sv', 'tr', 'ja', 'zh', 'es', 'da']) { const sorted = [...keys].sort((a, b) => a.localeCompare(b, loc)); orders.set(loc, sorted); }
const distinct = new Set([...orders.values()].map((o) => o.join(',')));
console.log(`  distinct orderings across 10 locales: ${distinct.size}`);
const tricky = ['sourceRefs', 'source_refs', 'Source', 'source', 'a_b', 'ab', 'a-b', 'İd', 'id'];
const t2 = new Set(['und', 'en', 'sv', 'tr', 'de', 'lt'].map((loc) => [...tricky].sort((a, b) => a.localeCompare(b, loc)).join(' ')));
console.log(`  mixed-case/underscore key set: distinct orderings=${t2.size}`); for (const o of t2) console.log(`    ${o}`);
const cp = [...tricky].sort().join(' ');
console.log(`  code-point order for reference: ${cp}`);
store['lock']?.close?.();
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
