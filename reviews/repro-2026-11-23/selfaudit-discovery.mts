/** Self-audit A: does workspace discovery include the session whose wire is being written right now? Read-only. */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
process.env.MEMORY_STORE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'review-sa-'));
const { findAllWorkspaceSessions } = await import(pathToFileURL('D:/workspace/kimi-code-memory-mcp-server/src/context/wire-context.ts').href);
const found = findAllWorkspaceSessions();
const slugDir = path.join(os.homedir(), '.kimi-code', 'sessions', 'wd_kimi-code-memory-mcp-server_10ab0c98de85');
const wires: string[] = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'wire.jsonl') wires.push(p); } })(slugDir);
wires.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
const norm = (p: string) => path.resolve(p).toLowerCase();
const known = new Set(found.map((s) => norm(s.wire)));
const missing = wires.filter((w) => !known.has(norm(w)));
console.log(`  wires on disk for this workspace: ${wires.length}; discovered by findAllWorkspaceSessions(): ${found.length}; not discovered: ${missing.length}`);
console.log(`  newest wire (the one most recently written) is discovered: ${known.has(norm(wires[0]))}`);
if (missing.length) console.log(`  undiscovered (relative paths): ${missing.map((w) => path.relative(slugDir, w).split(path.sep).slice(0, 2).join('/')).slice(0, 6).join(' | ')}`);
const assumed = found.filter((s) => s.identityAssumed).length;
console.log(`  entries flagged identityAssumed: ${assumed}`);
