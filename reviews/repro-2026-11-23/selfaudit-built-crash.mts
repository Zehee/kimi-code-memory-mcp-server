/** Self-audit C: the REAL built instance (dist/server.js) meeting a bad wire line. */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const REPO = 'D:/workspace/kimi-code-memory-mcp-server';
const require = createRequire(path.join(REPO, 'package.json'));
const sdkUrl = (rel: string) => pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/${rel}`)).href;
const { Client } = await import(sdkUrl('client/index.js'));
const { StdioClientTransport } = await import(sdkUrl('client/stdio.js'));
const { computeWorkspaceHash } = await import(pathToFileURL(path.join(REPO, 'src/utils/paths.ts')).href);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-built-'));
const sessionsRoot = path.join(tmp, 'sessions');
const slugDir = `wd_review_${computeWorkspaceHash(REPO)}`;
const wireDir = path.join(sessionsRoot, slugDir, 'session_review_0001', 'agents', 'main');
fs.mkdirSync(wireDir, { recursive: true });
const t = 1_760_000_000_000;
const mode = process.argv[2] ?? 'null';
const badLine = mode === 'input-string'
  ? JSON.stringify({ type: 'turn.prompt', input: 'a plain string', turnId: '1', time: t + 2 })
  : mode === 'none' ? '' : mode;
const lines = [
  JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'earlier question' }], turnId: '0', time: t }),
  JSON.stringify({ type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: 'earlier answer' }, turnId: '0' }, time: t + 1 }),
];
if (badLine) lines.push(badLine);
fs.writeFileSync(path.join(wireDir, 'wire.jsonl'), lines.join('\n') + '\n', 'utf8');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Call = (client: Client) => Promise<unknown>;
const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, sleep(ms).then(() => { throw new Error(what); })]);

async function probe(label: string, call: Call) {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(REPO, 'dist', 'server.js')],
    env: { ...process.env, MEMORY_STORE_ROOT: path.join(tmp, 'store'), MEMORY_SESSIONS_ROOT: sessionsRoot, KIMI_MEMORY_BG_INDEX: '0', KIMI_MEMORY_AUTO_VIS: '0' },
    stderr: 'pipe',
  });
  const stderr: string[] = [];
  transport.stderr?.on('data', (c) => stderr.push(String(c)));
  const client = new Client({ name: 'selfaudit', version: '0.0.0' });
  let outcome: string;
  let alive = 'no';
  try {
    await withTimeout(client.connect(transport), 10_000, 'connect timeout');
    try {
      const result = await withTimeout(call(client), 8_000, 'HANGING: no response within 8s');
      outcome = `responded (${result instanceof Object && 'tools' in result ? `${(result as { tools: unknown[] }).tools.length} tools` : 'isError=' + String((result as { isError?: boolean }).isError)})`;
    } catch (err) {
      outcome = `FAILED: ${String((err as Error).message).split('\n')[0].slice(0, 80)}`;
    }
    try { await withTimeout(client.ping().then(() => { alive = 'yes'; }), 2_000, 'x'); } catch { alive = 'no'; }
  } catch (err) {
    outcome = `connect failed: ${String((err as Error).message).split('\n')[0].slice(0, 80)}`;
  }
  const crash = (stderr.join('').match(/(TypeError|RangeError): [^\n]*/) || [''])[0].slice(0, 95);
  console.log(`  ${label.padEnd(30)} -> ${outcome}; ping after: ${alive}${crash ? `\n      server stderr: ${crash}` : ''}`);
  try { await client.close(); } catch { /* gone */ }
  const pid = (transport as unknown as { pid?: number }).pid;
  if (pid) { try { process.kill(pid); } catch { /* gone */ } }
}

console.log(`wire tail line: ${badLine ? badLine.slice(0, 70) : '(none — control run)'}`);
await probe('control: listTools', (c) => c.listTools());
await probe('bootstrap_workspace', (c) => c.callTool({ name: 'bootstrap_workspace', arguments: {} }));
await probe('search_context', (c) => c.callTool({ name: 'search_context', arguments: { query: 'earlier' } }));
await probe('get_context (resume)', (c) => c.callTool({ name: 'get_context', arguments: {} }));
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
process.exit(0);
