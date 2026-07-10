import assert from 'assert';
import { createTools } from '../../../src/tools/index.js';
import type { Ctx } from '../../../src/types.js';
import type { IndexDao } from '../../../src/dao/index.js';
import type { MemoryStore } from '../../../src/dao/memory-store.js';
import type { ThemeManager } from '../../../src/theme-manager.js';
import type { RefinedManager } from '../../../src/refined-manager.js';

export default async function runTests(): Promise<void> {
  const mockCtx: Ctx = {
    cwd: '/tmp',
    workspaceId: 'workspace-test',
    storeRoot: '/tmp/store',
    indexDao: {} as IndexDao,
    memoryStore: {} as MemoryStore,
    themeManager: {} as ThemeManager,
    refinedManager: {} as RefinedManager,
  };

  const { toolSchemas, dispatch } = createTools(mockCtx);

  assert.strictEqual(toolSchemas.length, 22, 'should expose exactly 22 tools');

  const names = toolSchemas.map((t) => t.name);
  const uniqueNames = new Set(names);
  assert.strictEqual(uniqueNames.size, 22, 'all tool names should be unique');

  const expectedTools = new Set([
    'remember',
    'recall',
    'search',
    'list_tags',
    'list',
    'delete',
    'move',
    'load_more_context',
    'search_context',
    'list_search_views',
    'delete_search_view',
    'load_turn_context',
    'tag_theme',
    'trace_theme',
    'list_themes',
    'delete_theme',
    'refine_session_turns',
    'get_current_workspace',
    'open_memory_dashboard',
    'organize_memories',
    'sync_workspace_index',
    'bootstrap_workspace',
  ]);
  for (const name of names) {
    assert(expectedTools.has(name), `unexpected tool name: ${name}`);
  }

  for (const schema of toolSchemas) {
    const result = await dispatch(schema.name, {});
    assert(
      !result.error || !String(result.error).startsWith(`Unknown tool: ${schema.name}`),
      `tool ${schema.name} is missing a handler`,
    );
    assert.strictEqual(result.content[0].type, 'text');
  }
}
