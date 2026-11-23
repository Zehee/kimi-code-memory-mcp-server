// Key-shape probe for the three event types the parser keys on. Keys only.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const root = path.join(os.homedir(), '.kimi-code', 'sessions', 'wd_kimi-code-memory-mcp-server_10ab0c98de85');
const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'wire.jsonl') files.push(p); } })(root);
const shapes = new Map();
const note = (k, v) => shapes.set(k, (shapes.get(k) || 0) + v);
for (const f of files) for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
  if (!line.trim()) continue; let ev; try { ev = JSON.parse(line); } catch { continue; }
  if (!ev || typeof ev !== 'object') continue;
  if (ev.type === 'turn.prompt') note('turn.prompt keys=' + Object.keys(ev).sort().join(',') + ' timeType=' + typeof ev.time, 1);
  if (ev.type !== 'context.append_loop_event' || !ev.event) continue;
  const t = ev.event.type; if (!['step.begin', 'content.part', 'tool.call'].includes(t)) continue;
  note(`${t} outerKeys=${Object.keys(ev).sort().join(',')} | eventKeys=${Object.keys(ev.event).sort().join(',')} | event.turnId=${typeof ev.event.turnId} outer.turnId=${typeof ev.turnId} | timeType=${typeof ev.time}`, 1);
}
for (const [k, v] of [...shapes].sort((a, b) => b[1] - a[1])) console.log(String(v).padStart(6), k);
