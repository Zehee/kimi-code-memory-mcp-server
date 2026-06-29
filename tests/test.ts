import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import assert from 'assert';
import { RefinedManager } from '../src/refined-manager.js';
import { computeWorkspaceHash } from '../src/utils/paths.js';
import { runSetup } from '../src/setup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.join(__dirname, '..');

cleanupTempDirectories();

const testStoreRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-code-memory-test-'));
process.env.MEMORY_STORE_ROOT = testStoreRoot;

function cleanupTempDirectories() {
  // Clean up any leftover test temp directories from previous interrupted runs.
  const prefix = 'kimi-code-';
  for (const entry of fs.readdirSync(os.tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(os.tmpdir(), entry.name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Ignore Windows lock cleanup issues.
    }
  }
}

function cleanup() {
  try {
    fs.rmSync(testStoreRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Ignore Windows lock cleanup issues.
  }
  cleanupTempDirectories();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseJsonResult(toolResult: unknown): any {
  const result = toolResult as { content: Array<{ type: string; text?: string }> };
  const text = result.content.find((c) => c.type === 'text')?.text;
  return JSON.parse(text as string);
}

async function withClient(fn: (client: Client) => Promise<unknown>) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', path.join(projectRoot, 'src', 'server.ts')],
    env,
  });
  const client = new Client({ name: 'test-client', version: '0.1.0' });
  await client.connect(transport);

  try {
    return await fn(client);
  } finally {
    await transport.close();
  }
}

function createTempSessionWire(
  sessionsRoot: string,
  workspaceDirName: string,
  sessionId: string,
  turns: Array<{ user: string; agent: string; timestamp: string }>,
) {
  const sessionDir = path.join(sessionsRoot, workspaceDirName, sessionId, 'agents', 'main');
  fs.mkdirSync(sessionDir, { recursive: true });
  const wirePath = path.join(sessionDir, 'wire.jsonl');
  const lines: string[] = [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    lines.push(
      JSON.stringify({
        type: 'turn.prompt',
        time: turn.timestamp,
        input: [{ type: 'text', text: turn.user }],
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        time: turn.timestamp,
        event: { type: 'step.begin', turnId: i },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'context.append_loop_event',
        time: turn.timestamp,
        event: { type: 'content.part', turnId: i, part: { type: 'text', text: turn.agent } },
      }),
    );
  }
  fs.writeFileSync(wirePath, lines.join('\n') + '\n', 'utf8');
  return wirePath;
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

async function testRefinedManagerSQLite() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refined-sqlite-'));
  let manager: RefinedManager | null = null;
  try {
    manager = new RefinedManager(tmpRoot);
    const turn = {
      turnId: 1,
      timestamp: '2026-06-24T12:00:00.000Z',
      user: 'Decide on auth',
      agentText: '- Chose JWT\n- Use httpOnly cookie for refresh',
      actions: [{ name: 'git_commit' }],
    };
    const refined = manager.refineTurn(turn, 'sess-a');
    await manager.saveRefinedTurns('sess-a', [refined]);

    const loaded = manager.loadRefinedTurns('sess-a');
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].turnId, 1);
    assert.strictEqual(loaded[0].sessionId, 'sess-a');
    assert(loaded[0].facts.length >= 2);

    const single = manager.loadRefinedTurn('sess-a', 1);
    assert(single);
    assert.strictEqual(single.summary, refined.summary);

    assert(fs.existsSync(path.join(tmpRoot, 'refined.sqlite')));
    manager.close();
    manager = null;
  } finally {
    if (manager) manager.close();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may briefly retain the SQLite file lock after close; ignore cleanup failure.
    }
  }
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
    assert(Array.isArray(result.clusters));
    assert.strictEqual(result.refinedCount, 0);
  });
}

async function testRefinedSearchDirectly() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'refined-search-test-'));
  let manager: RefinedManager | null = null;
  try {
    manager = new RefinedManager(tmpRoot);
    const turn = {
      turnId: 1,
      timestamp: '2026-06-24T12:00:00.000Z',
      user: 'Talk about sqlite search',
      agentText: '- Implemented SQLite search for refined turns.',
      actions: [],
    };
    const refined = manager.refineTurn(turn, 'sess-search');
    await manager.saveRefinedTurns('sess-search', [refined]);

    const matches = manager.searchRefinedTurns({ query: 'sqlite search', limit: 10 });
    assert(matches.length >= 1);
    assert(matches.some((m) => m.sessionId === 'sess-search' && m.turnId === 1));
    assert(matches[0].score > 0);
  } finally {
    if (manager) manager.close();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may retain SQLite lock briefly.
    }
  }
}

async function testSearchContextUsesRefined() {
  await withClient(async (client) => {
    // Create a memory entry whose content will appear in refined turns after refinement.
    await client.callTool({
      name: 'remember',
      arguments: {
        key: 'refined-search-test',
        content: '# Refined Search Test\n\nWe implemented sqlite refined search.',
        tags: ['test'],
      },
    });

    // Refine current session turns. This session's wire exists because we are running inside it.
    const refineResult = parseJsonResult(
      await client.callTool({ name: 'refine_session_turns', arguments: {} }),
    );

    // If no current session wire is found, skip the refined-search assertion.
    if (refineResult.success && refineResult.refinedCount > 0) {
      const searchResult = parseJsonResult(
        await client.callTool({
          name: 'search_context',
          arguments: { query: 'sqlite refined search', limit: 10 },
        }),
      );
      assert(Array.isArray(searchResult.matches));
      assert(searchResult.matches.length >= 1, 'search_context should find refined turns');
      assert.strictEqual(typeof searchResult.refinedCount, 'number');
    }
  });
}

async function testConfigurableSessionsRoot() {
  const tmpSessions = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-code-sessions-test-'));
  const cwd = process.cwd().replace(/\\/g, '/');
  const hash = computeWorkspaceHash(cwd);
  const workspaceDirName = `wd_${path.basename(cwd)}_${hash}`;

  createTempSessionWire(tmpSessions, workspaceDirName, 'session_configurable', [
    {
      user: 'What is configurable sessions root?',
      agent: 'It allows MEMORY_SESSIONS_ROOT to override the default sessions path.',
      timestamp: '2026-06-24T12:00:00.000Z',
    },
  ]);

  const previousSessionsRoot = process.env.MEMORY_SESSIONS_ROOT;
  process.env.MEMORY_SESSIONS_ROOT = tmpSessions;
  try {
    await withClient(async (client) => {
      const result = parseJsonResult(
        await client.callTool({
          name: 'search_context',
          arguments: { query: 'MEMORY_SESSIONS_ROOT override' },
        }),
      );
      assert(Array.isArray(result.matches));
      assert(result.matches.length >= 1, 'search_context should find turn in configurable sessions root');
      assert(result.matches.some((m: { sessionId: string }) => m.sessionId === 'session_configurable'));
    });
  } finally {
    if (previousSessionsRoot === undefined) {
      delete process.env.MEMORY_SESSIONS_ROOT;
    } else {
      process.env.MEMORY_SESSIONS_ROOT = previousSessionsRoot;
    }
    fs.rmSync(tmpSessions, { recursive: true, force: true });
  }
}

async function testClusterMaxSize() {
  const tmpSessions = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-code-cluster-test-'));
  const cwd = process.cwd().replace(/\\/g, '/');
  const hash = computeWorkspaceHash(cwd);
  const workspaceDirName = `wd_${path.basename(cwd)}_${hash}`;

  const turns: Array<{ user: string; agent: string; timestamp: string }> = [];
  for (let i = 0; i < 10; i++) {
    turns.push({
      user: i === 5 ? 'cluster keyword here' : `turn ${i}`,
      agent: `agent response ${i}`,
      timestamp: `2026-06-24T12:00:0${i}.000Z`,
    });
  }
  createTempSessionWire(tmpSessions, workspaceDirName, 'session_cluster', turns);

  const previousSessionsRoot = process.env.MEMORY_SESSIONS_ROOT;
  process.env.MEMORY_SESSIONS_ROOT = tmpSessions;
  try {
    await withClient(async (client) => {
      // Refine the target session first so search_context can build clusters from
      // its wire, instead of being hijacked by stale refined records from earlier tests.
      const refineResult = parseJsonResult(
        await client.callTool({
          name: 'refine_session_turns',
          arguments: { sessionId: 'session_cluster' },
        }),
      );
      assert(refineResult.success, 'refine_session_turns should succeed');

      const result = parseJsonResult(
        await client.callTool({
          name: 'search_context',
          arguments: { query: 'cluster keyword', max_cluster_size: 3 },
        }),
      );
      assert(Array.isArray(result.clusters));
      assert(result.clusters.length >= 1);
      for (const cluster of result.clusters) {
        assert(cluster.memberCount <= 3, `cluster size ${cluster.memberCount} exceeds max_cluster_size 3`);
      }
    });
  } finally {
    if (previousSessionsRoot === undefined) {
      delete process.env.MEMORY_SESSIONS_ROOT;
    } else {
      process.env.MEMORY_SESSIONS_ROOT = previousSessionsRoot;
    }
    fs.rmSync(tmpSessions, { recursive: true, force: true });
  }
}

async function testSearchContextReturnsRefinedForMissingWire() {
  const tmpSessions = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-code-missing-sessions-'));
  const cwd = process.cwd().replace(/\\/g, '/');
  const hash = computeWorkspaceHash(cwd);
  const workspaceDirName = `wd_${path.basename(cwd)}_${hash}`;
  const sessionId = 'session_missing_wire';

  // Create a temporary wire so the server can refine it.
  const wirePath = createTempSessionWire(tmpSessions, workspaceDirName, sessionId, [
    {
      user: 'missing session turn',
      agent: 'This session has no wire file.',
      timestamp: '2026-06-24T12:00:00.000Z',
    },
  ]);

  const previousSessionsRoot = process.env.MEMORY_SESSIONS_ROOT;
  process.env.MEMORY_SESSIONS_ROOT = tmpSessions;
  try {
    await withClient(async (client) => {
      // Refine the session through the server; this writes into the server's refined DB.
      const refineResult = parseJsonResult(
        await client.callTool({ name: 'refine_session_turns', arguments: { sessionId } }),
      );
      assert(refineResult.success, 'refine_session_turns should succeed');

      // Now delete the wire file so the session is missing during search.
      fs.rmSync(wirePath, { force: true });

      const result = parseJsonResult(
        await client.callTool({
          name: 'search_context',
          arguments: { query: 'missing session turn' },
        }),
      );
      assert(Array.isArray(result.matches));
      assert(
        result.matches.some((m: { sessionId: string }) => m.sessionId === sessionId),
        'search_context should return refined match even when wire is gone',
      );
      assert(
        !result.skippedSessions.includes(sessionId),
        'missing wire should not be reported as skipped when refined data exists',
      );
    });
  } finally {
    if (previousSessionsRoot === undefined) {
      delete process.env.MEMORY_SESSIONS_ROOT;
    } else {
      process.env.MEMORY_SESSIONS_ROOT = previousSessionsRoot;
    }
    try {
      fs.rmSync(tmpSessions, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Ignore Windows lock cleanup issues.
    }
  }
}

async function testListSearchViews() {
  await withClient(async (client) => {
    const result = parseJsonResult(await client.callTool({ name: 'list_search_views', arguments: {} }));
    assert(Array.isArray(result.views));
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

async function testSetupIntegration() {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-code-home-test-'));
  try {
    // Dry run should not create anything.
    const dryRunResult = await runSetup({ kimiCodeHome: tmpHome, dryRun: true });
    assert(!fs.existsSync(path.join(tmpHome, 'AGENTS.md')));
    assert(!fs.existsSync(path.join(tmpHome, 'mcp.json')));
    assert(dryRunResult.actions.every((a) => typeof a === 'string'));

    // Run setup for real.
    const setupResult = await runSetup({ kimiCodeHome: tmpHome });
    assert(setupResult.actions.some((a) => a.includes('Injected')));

    const agentsMdPath = path.join(tmpHome, 'AGENTS.md');
    const mcpJsonPath = path.join(tmpHome, 'mcp.json');
    const skillPath = path.join(tmpHome, 'skills', 'memory-manage');

    assert(fs.existsSync(agentsMdPath));
    assert(fs.existsSync(mcpJsonPath));
    assert(fs.existsSync(skillPath));

    const agentsContent = fs.readFileSync(agentsMdPath, 'utf8');
    assert(agentsContent.includes('<!-- KIMI-MEMORY-INJECTED-START -->'));
    assert(agentsContent.includes('<!-- KIMI-MEMORY-INJECTED-END -->'));
    assert(agentsContent.includes('mcp__kimi-memory__bootstrap_workspace'));

    const mcpConfig = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
    assert(mcpConfig.mcpServers['kimi-memory']);
    assert.deepStrictEqual(mcpConfig.mcpServers['kimi-memory'].args, ['-y', 'kimi-code-memory-mcp-server']);

    // Re-running should update, not duplicate.
    const updateResult = await runSetup({ kimiCodeHome: tmpHome });
    assert(updateResult.actions.some((a) => a.includes('Updated')));
    const updatedAgents = fs.readFileSync(agentsMdPath, 'utf8');
    const startCount = (updatedAgents.match(/KIMI-MEMORY-INJECTED-START/g) || []).length;
    assert.strictEqual(startCount, 1, 'injected block should appear exactly once');

    // Undo removes everything.
    const undoResult = await runSetup({ kimiCodeHome: tmpHome, undo: true });
    assert(undoResult.actions.some((a) => a.includes('Removed')));
    const undoneAgents = fs.readFileSync(agentsMdPath, 'utf8');
    assert(!undoneAgents.includes('KIMI-MEMORY-INJECTED-START'));

    const undoneMcp = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
    assert(!undoneMcp.mcpServers['kimi-memory']);
    assert(!fs.existsSync(skillPath));
  } finally {
    try {
      fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // Windows may briefly lock files.
    }
  }
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
  testRefinedManagerSQLite,
  testRefineTurnExtraction,
  testSearchContextEmpty,
  testRefinedSearchDirectly,
  testSearchContextUsesRefined,
  testConfigurableSessionsRoot,
  testClusterMaxSize,
  testSearchContextReturnsRefinedForMissingWire,
  testListSearchViews,
  testLoadWorkspaceContext,
  testLoadMoreContextInvalid,
  testSetupIntegration,
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
