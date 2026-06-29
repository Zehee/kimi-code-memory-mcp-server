import assert from 'assert';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { IndexCatalog } from '../../../src/dao/index-catalog.js';
import type { IndexStore } from '../../../src/dao/index-store.js';
import type { IndexData } from '../../../src/dao/constants.js';

export default async function runTests(): Promise<void> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-code-memory-catalog-test-'));

  const indexData: IndexData = {
    version: '3-kv',
    meta: { lastSyncAt: null, structureHash: null },
    index: {
      'memory/': { comment: 'root' },
      'memory/decisions/': { comment: 'decisions folder' },
      'memory/decisions/auth.md': { title: 'Auth Decision', tags: ['decision', 'security'] },
      'memory/decisions/db.md': { title: '', tags: ['decision'] },
      'memory/knowledge/': { comment: '' },
      'memory/knowledge/stack.md': { title: 'Tech Stack', tags: ['knowledge'] },
      'notes/': { comment: '' },
      'notes/todo.md': { title: 'Todo', tags: ['scratch'] },
    },
  };

  const mockStore = {
    getIndex: () => indexData,
  } as unknown as IndexStore;

  const catalog = new IndexCatalog(tmpDir, mockStore);

  const allRefs = catalog.listRefs();
  assert.strictEqual(allRefs.length, 4);
  assert(allRefs.some((r) => r.key === 'auth' && r.folder === 'memory/decisions'));
  assert(allRefs.some((r) => r.key === 'db' && r.folder === 'memory/decisions'));
  assert(allRefs.some((r) => r.key === 'stack' && r.folder === 'memory/knowledge'));
  assert(allRefs.some((r) => r.key === 'todo' && r.folder === 'notes'));

  const memoryRefs = catalog.listRefs('memory');
  assert.strictEqual(memoryRefs.length, 3);

  const decisionRefs = catalog.listRefs('memory/decisions');
  assert.strictEqual(decisionRefs.length, 2);
  assert(decisionRefs[0].folder.localeCompare(decisionRefs[1].folder) <= 0);

  const auth = allRefs.find((r) => r.key === 'auth');
  assert(auth);
  assert.strictEqual(auth.title, 'Auth Decision');
  assert.deepStrictEqual(auth.tags, ['decision', 'security']);

  const db = allRefs.find((r) => r.key === 'db');
  assert(db);
  assert.strictEqual(db.title, 'Db');

  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
