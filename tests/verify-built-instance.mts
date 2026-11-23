/**
 * Real running-instance verification (review requirement).
 *
 * Spawns the BUILT dist/server.js as a real stdio MCP process against a
 * temporary store and exercises the core contract: handshake, remember with
 * revision, CAS conflict, restore, search. Unlike the integration tests
 * (which run the sources through tsx), this verifies the artifacts that are
 * actually shipped.
 *
 * Run after `npm run build`:
 *   npx tsx tests/verify-built-instance.mts
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync, spawn } from 'child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { computeWorkspaceId } from '../src/utils/paths.js';

const serverEntry = path.resolve('dist', 'server.js');
if (!fs.existsSync(serverEntry)) {
  console.error(`Built server not found at ${serverEntry}; run npm run build first.`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-built-instance-'));
const storeRoot = path.join(tmp, 'store');

function killProcessTree(pid: number): void {
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch {
    /* already gone */
  }
}

async function withClient(
  fn: (client: Client, stderrChunks: string[]) => Promise<void>,
): Promise<void> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverEntry],
    env: {
      ...process.env,
      MEMORY_STORE_ROOT: storeRoot,
      KIMI_MEMORY_BG_INDEX: '0',
      KIMI_MEMORY_AUTO_VIS: '0',
    },
  });
  const client = new Client({ name: 'built-instance-check', version: '0.0.0' });
  await client.connect(transport);
  try {
    await fn(client, []);
  } finally {
    try {
      await client.close();
    } catch {
      /* transport may already be closed */
    }
    const pid = (transport as unknown as { pid?: number }).pid;
    if (pid) killProcessTree(pid);
  }
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text = result.content?.[0]?.type === 'text' ? (result.content[0].text ?? '{}') : '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log(`Built instance: ${serverEntry}`);
  console.log(`Store: ${storeRoot}`);

  // Review round 4: a corrupt journal file must be REPORTED on real startup
  // stderr — never silently ignored (the exact repro from the review).
  // The journal lives inside the workspace bucket, exactly where the built
  // server looks for it.
  const workspaceId = computeWorkspaceId(process.cwd().replace(/\\/g, '/'));
  const journalDir = path.join(storeRoot, workspaceId, '.journal');
  fs.mkdirSync(journalDir, { recursive: true });
  fs.writeFileSync(path.join(journalDir, 'broken.json'), '{ not json', 'utf8');

  // The startup recovery runs before the server reads stdin, so a raw spawn
  // captures the report without any protocol traffic.
  const startup = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      MEMORY_STORE_ROOT: storeRoot,
      KIMI_MEMORY_BG_INDEX: '0',
      KIMI_MEMORY_AUTO_VIS: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const startupStderr: string[] = [];
  startup.stderr!.on('data', (chunk) => startupStderr.push(String(chunk)));
  // Poll until the corrupt report shows up (or a generous timeout on a
  // loaded machine), then kill the instance.
  let startupStderrText = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    startupStderrText = startupStderr.join('');
    if (/journal: CORRUPT entry broken\.json/.test(startupStderrText)) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (startup.pid) killProcessTree(startup.pid);
  assert(
    /journal: CORRUPT entry broken\.json/.test(startupStderrText),
    `startup stderr must report the corrupt journal entry; got: ${JSON.stringify(startupStderrText)}`,
  );
  assert(
    fs.existsSync(path.join(journalDir, 'broken.json')),
    'the corrupt file is kept on disk for inspection',
  );
  console.log('✓ corrupt journal reported on real startup stderr');

  // Doctor path: the built setup CLI must report the corrupt file too.
  const setupCli = path.resolve('dist', 'setup-cli.js');
  assert(fs.existsSync(setupCli), 'dist/setup-cli.js exists after build');
  const doctor = execSync(`"${process.execPath}" "${setupCli}" --doctor`, {
    encoding: 'utf8',
    cwd: process.cwd(),
    env: { ...process.env, MEMORY_STORE_ROOT: storeRoot },
  });
  assert(
    /CORRUPT entries: 1|corrupt: broken\.json/.test(doctor),
    `doctor output must report the corrupt journal entry; got: ${doctor}`,
  );
  assert(/need manual inspection/.test(doctor), 'doctor lists the corrupt entry as a pending action');
  console.log('✓ corrupt journal reported by built doctor CLI');

  await withClient(async (client) => {
    const tools = await client.listTools();
    assert(
      tools.tools.some((t) => t.name === 'restore_memory'),
      'the built instance exposes the v0.6.0 tool set',
    );

    const ws = (await call(client, 'get_current_workspace', {})) as {
      workspaceId?: string;
      storePath?: string;
    };
    assert(ws.workspaceId, 'handshake works and workspace resolves');
    assert(
      path.resolve(String(ws.storePath)).toLowerCase() ===
        path.join(storeRoot, String(ws.workspaceId)).toLowerCase(),
      'MEMORY_STORE_ROOT override reaches the built instance',
    );

    const remember = (await call(client, 'remember', {
      key: 'built-check',
      folder: 'memory/decisions',
      content: 'written by the built instance',
      tags: ['verify'],
    })) as { success: boolean; revision: number; id: string };
    assert.strictEqual(remember.success, true);
    assert.strictEqual(remember.revision, 1);

    // CAS: a stale revision (the file is at 1) must be rejected.
    const conflict = (await call(client, 'remember', {
      key: 'built-check',
      folder: 'memory/decisions',
      content: 'second write',
      expectedRevision: 5,
    })) as { success: boolean; error?: string };
    assert.strictEqual(conflict.success, false, 'a stale CAS is rejected by the built instance');
    assert.strictEqual(conflict.error, 'RevisionConflict');

    const del = (await call(client, 'delete', {
      key: 'built-check',
      folder: 'memory/decisions',
    })) as { success: boolean; recoverable: boolean };
    assert.strictEqual(del.success, true);
    assert.strictEqual(del.recoverable, true, 'delete soft-deletes into trash');

    const restored = (await call(client, 'restore_memory', {
      key: 'built-check',
      folder: 'memory/decisions',
    })) as { success: boolean };
    assert.strictEqual(restored.success, true, 'restore works on the built instance');

    const search = (await call(client, 'search', { query: 'built instance' })) as {
      items?: Array<{ key?: string }>;
    };
    assert(
      Array.isArray(search.items) && search.items.length > 0,
      'search finds the restored memory on the built instance',
    );
  });

  console.log('Built-instance verification passed.');
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* best effort */
  }
}

main().catch((err) => {
  console.error('Built-instance verification FAILED:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
