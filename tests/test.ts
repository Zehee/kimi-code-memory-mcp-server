import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { RefinedManager } from '../src/refined-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

const testStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-code-memory-test-'));
process.env.MEMORY_STORE_ROOT = testStoreRoot;

function cleanup() {
  fs.rmSync(testStoreRoot, { recursive: true, force: true });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJsonResult(toolResult: unknown): any {
  const result = toolResult as { content: Array<{ type: string; text?: string }> };
  const text = result.content.find((c) => c.type === 'text')?.text;
  return JSON.parse(text as string);
}

async function withClient(fn: (client: Client) => Promise<unknown>) {
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', path.join(projectRoot, 'src', 'server.ts')],
  });
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

async function testGetCurrentWorkspace() {
  await withClient(async (client) => {
    const result = parseJsonResult(
      await client.callTool({ name: 'get_current_workspace', arguments: {} }),
    );
    assert(result.workspaceId.startsWith('workspace-'));
    assert(fs.existsSync(result.storePath), 'store path should exist');
  });
}

async function testRememberAndRecall() {
  await withClient(async (client) => {
    await client.callTool({
      name: 'remember',
      arguments: {
        key: 'test-decision',
        folder: 'memory/decisions',
        content: '# Test Decision\n\nWe chose A over B.',
        tags: ['decision', 'test'],
      },
    });

    const result = parseJsonResult(
      await client.callTool({
        name: 'recall',
        arguments: { key: 'test-decision', folder: 'memory/decisions' },
      }),
    );
    assert(result.found);
    assert(result.content.includes('We chose A over B'));
    assert(result.tags.includes('decision'));
  });
}

async function testSearch() {
  await withClient(async (client) => {
    await client.callTool({
      name: 'remember',
      arguments: {
        key: 'searchable-item',
        content: 'This contains unique_search_term_xyz.',
        tags: ['knowledge'],
      },
    });

    const result = parseJsonResult(
      await client.callTool({ name: 'search', arguments: { query: 'unique_search_term_xyz' } }),
    );
    assert(result.items.length >= 1);
    assert(result.items.some((i: { key: string }) => i.key === 'searchable-item'));
  });
}

async function testListAndTags() {
  await withClient(async (client) => {
    const listResult = parseJsonResult(await client.callTool({ name: 'list', arguments: {} }));
    assert(Array.isArray(listResult.items));
    assert(listResult.items.length >= 1);

    const tagsResult = parseJsonResult(await client.callTool({ name: 'list_tags', arguments: {} }));
    assert(Array.isArray(tagsResult.tags));
  });
}

async function testMoveAndDelete() {
  await withClient(async (client) => {
    await client.callTool({
      name: 'remember',
      arguments: { key: 'move-me', content: 'content', tags: ['move'] },
    });

    const moveResult = parseJsonResult(
      await client.callTool({
        name: 'move',
        arguments: { key: 'move-me', toFolder: 'memory/decisions', newKey: 'moved-item' },
      }),
    );
    assert(moveResult.success);

    const old = parseJsonResult(
      await client.callTool({ name: 'recall', arguments: { key: 'move-me' } }),
    );
    assert(!old.found);

    const moved = parseJsonResult(
      await client.callTool({
        name: 'recall',
        arguments: { key: 'moved-item', folder: 'memory/decisions' },
      }),
    );
    assert(moved.found);

    const deleteResult = parseJsonResult(
      await client.callTool({
        name: 'delete',
        arguments: { key: 'moved-item', folder: 'memory/decisions' },
      }),
    );
    assert(deleteResult.success);
  });
}

async function testOrganizeMemories() {
  await withClient(async (client) => {
    const prepare = parseJsonResult(
      await client.callTool({ name: 'organize_memories', arguments: {} }),
    );
    assert(prepare.stage === 'prepare');

    const store = parseJsonResult(
      await client.callTool({
        name: 'organize_memories',
        arguments: { content: '# Workspace Essence\n\nTest essence.' },
      }),
    );
    assert(store.success);
    assert(store.contentSize > 0);

    const bootstrap = parseJsonResult(
      await client.callTool({ name: 'bootstrap_workspace', arguments: {} }),
    );
    assert(bootstrap.essence.found);
    assert(bootstrap.memoryIndexTree.includes('memory/'));
  });
}

async function testSyncWorkspaceIndex() {
  await withClient(async (client) => {
    await client.callTool({
      name: 'remember',
      arguments: {
        key: 'index-test-item',
        content: 'index test content',
        tags: ['knowledge'],
      },
    });

    const result = parseJsonResult(
      await client.callTool({ name: 'sync_workspace_index', arguments: {} }),
    );
    assert(result.synced);
  });
}

async function testTagThemeAndTrace() {
  await withClient(async (client) => {
    await client.callTool({
      name: 'remember',
      arguments: {
        key: 'theme-memory',
        folder: 'memory/knowledge',
        content: 'A piece of knowledge tied to a theme.',
        tags: ['knowledge'],
      },
    });

    const tagResult = parseJsonResult(
      await client.callTool({
        name: 'tag_theme',
        arguments: {
          theme: 'test-theme',
          memoryKey: 'theme-memory',
          memoryFolder: 'memory/knowledge',
        },
      }),
    );
    assert(tagResult.success);
    assert(tagResult.ref.memoryKey === 'theme-memory');

    const traceResult = parseJsonResult(
      await client.callTool({
        name: 'trace_theme',
        arguments: { theme: 'test-theme' },
      }),
    );
    assert(traceResult.found);
    assert(traceResult.memoryCount >= 1);
  });
}

async function testListThemes() {
  await withClient(async (client) => {
    const empty = parseJsonResult(await client.callTool({ name: 'list_themes', arguments: {} }));
    assert(Array.isArray(empty.themes));

    await client.callTool({
      name: 'remember',
      arguments: { key: 'list-theme-memory', content: 'content', tags: ['test'] },
    });
    await client.callTool({
      name: 'tag_theme',
      arguments: { theme: 'listable-theme', memoryKey: 'list-theme-memory' },
    });

    const listed = parseJsonResult(await client.callTool({ name: 'list_themes', arguments: {} }));
    assert(listed.themes.includes('listable-theme'));
  });
}

async function testRefineSessionTurns() {
  await withClient(async (client) => {
    const result = parseJsonResult(
      await client.callTool({ name: 'refine_session_turns', arguments: {} }),
    );
    // Result depends on whether a current session wire exists. Both shapes are valid.
    if (result.success) {
      assert(typeof result.refinedCount === 'number');
      assert(typeof result.outputPath === 'string');
    } else {
      assert(result.error);
    }
  });
}

function testRefineTurnExtraction() {
  const manager = new RefinedManager('/tmp/refined-test');
  const turn = {
    turnId: 1,
    timestamp: '2026-06-24T12:00:00.000Z',
    user: 'Please review the migration',
    agentText: [
      '## Current Focus',
      '- Migration to TypeScript',
      '- Fix package-lock.json',
      '',
      '## 已完成',
      'Completed: tsconfig setup',
      '修复了：package-lock 同步问题',
      '',
      'Next step: push to GitHub',
      'I will verify CI after the push.',
    ].join('\n'),
    actions: [{ name: 'git_push', args: { cwd: '/workspace/project' }, result: 'ok' }],
  };

  const refined = manager.refineTurn(turn, 'session-1');
  assert.strictEqual(refined.turnId, 1);
  assert.strictEqual(refined.sessionId, 'session-1');
  assert(refined.summary.includes('git_push'), 'summary should include tool names');
  assert(
    refined.facts.some((f) => f.includes('TypeScript')),
    'should extract list items as facts',
  );
  assert(
    refined.facts.some((f) => f.includes('tsconfig setup')),
    'should extract English action sentences',
  );
  assert(
    refined.facts.some((f) => f.includes('package-lock')),
    'should extract Chinese action sentences',
  );
  assert(
    refined.categories.focus && refined.categories.focus.includes('Migration to TypeScript'),
    'should categorize items under Current Focus heading',
  );
  assert(
    refined.categories.completed && refined.categories.completed.some((f) => f.includes('tsconfig')),
    'should categorize items under 已完成 heading',
  );
  assert(
    refined.notes.some((n) => n.includes('verify CI')),
    'should keep short declarative fallback notes',
  );
}

async function testSearchContextEmpty() {
  await withClient(async (client) => {
    const result = parseJsonResult(
      await client.callTool({ name: 'search_context', arguments: { query: 'nonexistent-xyz' } }),
    );
    assert(Array.isArray(result.matches));
  });
}

async function testLoadWorkspaceContext() {
  await withClient(async (client) => {
    const result = parseJsonResult(
      await client.callTool({ name: 'load_workspace_context', arguments: {} }),
    );
    assert(result.workspace.workspaceId.startsWith('workspace-'));
    assert(result.workspace.storePath);
  });
}

async function testLoadMoreContextInvalid() {
  await withClient(async (client) => {
    const result = parseJsonResult(
      await client.callTool({ name: 'load_more_context', arguments: { before_turn_id: 0 } }),
    );
    assert(result.error);
  });
}

const tests = [
  testGetCurrentWorkspace,
  testRememberAndRecall,
  testSearch,
  testListAndTags,
  testMoveAndDelete,
  testOrganizeMemories,
  testSyncWorkspaceIndex,
  testTagThemeAndTrace,
  testListThemes,
  testRefineSessionTurns,
  testRefineTurnExtraction,
  testSearchContextEmpty,
  testLoadWorkspaceContext,
  testLoadMoreContextInvalid,
];

async function main() {
  try {
    for (const test of tests) {
      await test();
      console.log(`✓ ${test.name}`);
    }
    console.log('\nAll tests passed.');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\nTest failed: ${message}`);
    console.error(err instanceof Error ? err.stack : '');
    process.exitCode = 1;
  } finally {
    cleanup();
  }
}

main();
