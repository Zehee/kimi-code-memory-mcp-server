// Each case runs in its own child so a crash is observable as a non-zero exit.
import { spawnSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ws6-'));
const child = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ws6-child.mts');
const good = JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'q' }], time: 1700000000000 });
const cases = {
  'baseline (valid line)': good,
  'truncated JSON line (handled today)': '{"type":"turn.prompt","input":[{"type":"text","text":"abc',
  'time = invalid string (the fix in this update)': JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'q' }], time: 'not a date' }),
  'time = 1e30 (out of range)': JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'q' }], time: 1e30 }),
  'line is null': 'null',
  'line is a number': '42',
  'line is a string': '"hello"',
  'line is an array': '[1,2]',
  'turn.prompt with input: "text" (not an array)': JSON.stringify({ type: 'turn.prompt', input: 'just a string', time: 1700000000000 }),
  'turn.prompt with input: {} (not an array)': JSON.stringify({ type: 'turn.prompt', input: {}, time: 1700000000000 }),
  'append_loop_event with event: "text"': JSON.stringify({ type: 'context.append_loop_event', event: 'text' }),
  'tool.call with args: null': JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Read', args: null, toolCallId: 'x', turnId: '0' } }),
  'tool.result with result: {content: {a:1}} (nested object)': JSON.stringify({ type: 'context.append_loop_event', event: { type: 'tool.result', toolCallId: 'x', result: { content: { a: 1 } } } }),
};
for (const [label, line] of Object.entries(cases)) {
  const wire = path.join(tmp, 'w.jsonl'); fs.writeFileSync(wire, line + '\n' + good + '\n');
  const r = spawnSync(process.execPath, ['--import', 'tsx', child, wire], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), encoding: 'utf8', env: { ...process.env, MEMORY_STORE_ROOT: path.join(tmp, 'store'), MEMORY_SESSIONS_ROOT: tmp } });
  const lines = (r.stderr || '').split('\n');
  const err = lines.find((l) => /^(TypeError|RangeError|SyntaxError|Error|ReferenceError)\b/.test(l.trim())) || lines.find((l) => /Error:/.test(l)) || '';
  console.log(`  ${r.status === 0 ? 'ok    ' : 'CRASH '} exit=${String(r.status).padEnd(3)} ${label}${r.status !== 0 ? `\n          -> ${err.trim().slice(0, 120)}  @ ${(lines.find((l) => /wire-context\.ts:\d+/.test(l)) || '').trim().slice(0, 90)}` : ''}`);
}
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
