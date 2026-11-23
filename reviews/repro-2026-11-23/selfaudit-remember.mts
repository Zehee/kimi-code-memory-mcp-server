/** Self-audit F-16: does `remember` return a revision that is already stale on the next read? */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-f16-'));
process.env.MEMORY_STORE_ROOT = path.join(tmp, 'store');
const { MemoryStore, RevisionConflictError } = await import(pathToFileURL('D:/workspace/kimi-code-memory-mcp-server/src/dao/memory-store.ts').href);
const store = new MemoryStore(path.join(tmp, 'store'));
const cases: Array<[string, string]> = [
  ['plain body', 'Decision: use A.'],
  ['body starts with one newline', '\nDecision: use B.'],
  ['body starts with two newlines', '\n\nDecision: use C.'],
  ['body with CRLF line endings', 'line one\r\nline two'],
  ['body with a blank line inside', 'para one\n\npara two'],
];
for (const [label, content] of cases) {
  const key = label.replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');
  const w = store.writeWithResult('memory/decisions', key, content, ['decision']);
  const s1 = store.syncIdentity('memory/decisions', key);
  const s2 = store.syncIdentity('memory/decisions', key);
  let followUp = 'ok';
  try { store.writeWithResult('memory/decisions', key, 'follow-up edit', undefined, { expectedRevision: w.revision }); } catch (e) { followUp = e instanceof RevisionConflictError ? 'RevisionConflictError' : (e as Error).name; }
  console.log(`  ${label.padEnd(34)} remember returned revision ${w.revision}; next read: revision=${s1.identity!.revision} changed=${s1.changed}; read again: changed=${s2.changed}; immediate follow-up write with expectedRevision=${w.revision}: ${followUp}`);
}
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
