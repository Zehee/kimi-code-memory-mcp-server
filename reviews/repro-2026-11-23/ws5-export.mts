/** WS5: export overlap detection and link handling. */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { exportWorkspaceData, backupWorkspaceData } = await import(pathToFileURL('D:/workspace/kimi-code-memory-mcp-server/src/maintenance.ts').href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ws5-'));
const storeRoot = path.join(tmp, 'Store');
fs.mkdirSync(path.join(storeRoot, 'memory', 'decisions'), { recursive: true });
fs.writeFileSync(path.join(storeRoot, 'memory', 'decisions', 'a.md'), '---\nid: "mem_a"\n---\nbody a\n');
fs.writeFileSync(path.join(storeRoot, 'index.json'), '{}');
const attempt = (label: string, fn: () => unknown) => { try { const r: any = fn(); console.log(`  ${label}: ok -> ${r}`); } catch (e: any) { console.log(`  ${label}: ${e.code || ''} ${String(e.message).slice(0, 95)}`); } };
console.log('=== overlap detection ===');
attempt('target = <store>/memory/export               ', () => exportWorkspaceData(storeRoot, path.join(storeRoot, 'memory', 'export')));
attempt('target = <store> (self)                      ', () => exportWorkspaceData(storeRoot, storeRoot));
attempt('target = <store> with different letter case  ', () => exportWorkspaceData(storeRoot, storeRoot.toUpperCase()));
attempt('target = parent of <store>                   ', () => exportWorkspaceData(storeRoot, tmp));
attempt('target = <store>/memory/../memory2 (sibling) ', () => { const r = exportWorkspaceData(storeRoot, path.join(storeRoot, 'memory', '..', 'memory2')); return `copied ${r.copied.map((c) => `${c.category}:${c.files}`).join(' ')} -> inside the store root but outside scanned dirs`; });
attempt('target = relative path resolved from cwd     ', () => exportWorkspaceData(storeRoot, path.resolve('Store/memory/decisions/../export')));
console.log('=== stale target ===');
const target = path.join(tmp, 'out');
exportWorkspaceData(storeRoot, target);
fs.writeFileSync(path.join(target, 'memory', 'decisions', 'deleted-long-ago.md'), 'stale leftover');
fs.rmSync(path.join(storeRoot, 'memory', 'decisions', 'a.md'));
const again = exportWorkspaceData(storeRoot, target);
console.log(`  re-export after deleting a.md: report says memory:${again.copied[0].files} file(s); target still contains ${fs.readdirSync(path.join(target, 'memory', 'decisions')).join(', ')}`);
console.log('=== link inside the source tree (directory junction, no admin needed on Windows) ===');
const outside = path.join(tmp, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.txt'), 'OUTSIDE-CONTENT');
const link = path.join(storeRoot, 'memory', 'linked');
try { fs.symlinkSync(outside, link, 'junction'); } catch (e: any) { console.log(`  could not create junction: ${e.code}`); }
if (fs.existsSync(link)) {
  attempt('export with a junction inside memory/        ', () => { const r = exportWorkspaceData(storeRoot, path.join(tmp, 'out2')); return `copied ${r.copied.map((c) => `${c.category}:${c.files}`).join(' ')}`; });
  const copied = path.join(tmp, 'out2', 'memory', 'linked');
  console.log(`  export target has memory/linked: ${fs.existsSync(copied)}${fs.existsSync(copied) ? ` -> ${fs.statSync(copied).isDirectory() ? 'directory' : 'file'}` : ''}`);
  if (fs.existsSync(path.join(copied, 'secret.txt'))) console.log(`  >>> content from OUTSIDE the store was exported: ${fs.readFileSync(path.join(copied, 'secret.txt'), 'utf8')}`);
  else if (fs.existsSync(copied) && !fs.statSync(copied).isDirectory()) console.log(`  >>> junction copied as a file: ${fs.readFileSync(copied, 'utf8').slice(0, 40)}`);
  fs.rmSync(link, { recursive: true, force: true });
}
console.log('=== backup ===');
attempt('backupWorkspaceData                          ', () => { const r = backupWorkspaceData(storeRoot, 2); return `copied ${r.report.copied.map((c) => `${c.category}:${c.files}`).join(' ')} into ${path.relative(storeRoot, r.report.targetDir)}`; });
attempt('second backup does not nest the first        ', () => { const r = backupWorkspaceData(storeRoot, 5); return `backups/: ${fs.readdirSync(path.join(storeRoot, 'backups')).length} entries; memory files per backup: ${r.report.copied[0].files}`; });
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
