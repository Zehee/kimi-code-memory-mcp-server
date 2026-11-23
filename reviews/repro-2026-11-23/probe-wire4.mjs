// Is turn.prompt persisted BEFORE the turn ends? Look at the most recently
// modified wire and report, for the last few turns, the line index of
// turn.prompt vs turn.ended and whether an open (un-ended) turn exists now.
import fs from 'node:fs'; import path from 'node:path'; import os from 'node:os';
const root = path.join(os.homedir(), '.kimi-code', 'sessions', 'wd_kimi-code-memory-mcp-server_10ab0c98de85');
const files = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'wire.jsonl') files.push(p); } })(root);
files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
for (const f of files.slice(0, 3)) {
  const lines = fs.readFileSync(f, 'utf8').split('\n'); const marks = [];
  lines.forEach((line, i) => { if (!line.trim()) return; let ev; try { ev = JSON.parse(line); } catch { return; } if (ev && (ev.type === 'turn.prompt' || ev.type === 'turn.ended')) marks.push(`${i}:${ev.type}${ev.turnId !== undefined ? '#' + ev.turnId : ''}`); });
  const lastPrompt = marks.map((m) => m.split(':')[1]).lastIndexOf('turn.prompt');
  console.log(`${path.relative(root, f).split(path.sep)[0].slice(0, 20)} lines=${lines.length} lastMarks=[${marks.slice(-5).join(' ')}] openTurnNow=${lastPrompt === marks.length - 1 ? (marks[lastPrompt].split(':')[1] === 'turn.prompt') : marks.length && marks[marks.length - 1].split(':')[1] === 'turn.prompt'}`);
}
