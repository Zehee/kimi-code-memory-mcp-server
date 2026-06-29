import assert from 'assert';
import { normalizeHeading, matchCategory } from '../../../src/utils/headings.js';

export default async function runTests(): Promise<void> {
  assert.strictEqual(normalizeHeading('Current Focus'), 'Current Focus');
  assert.strictEqual(normalizeHeading('Current Focus:'), 'Current Focus');
  assert.strictEqual(normalizeHeading('Current Focus：'), 'Current Focus');
  assert.strictEqual(normalizeHeading('  Current Focus:  '), 'Current Focus');
  assert.strictEqual(normalizeHeading('Notes：'), 'Notes');

  assert.strictEqual(matchCategory('Current Focus'), 'focus');
  assert.strictEqual(matchCategory('Focus'), 'focus');
  assert.strictEqual(matchCategory('当前任务'), 'focus');
  assert.strictEqual(matchCategory('当前聚焦'), 'focus');

  assert.strictEqual(matchCategory('Completed'), 'completed');
  assert.strictEqual(matchCategory('Done'), 'completed');
  assert.strictEqual(matchCategory('已完成'), 'completed');
  assert.strictEqual(matchCategory('完成'), 'completed');

  assert.strictEqual(matchCategory('Next Steps'), 'next');
  assert.strictEqual(matchCategory('Next'), 'next');
  assert.strictEqual(matchCategory('下一步'), 'next');
  assert.strictEqual(matchCategory('后续'), 'next');

  assert.strictEqual(matchCategory('Blockers'), 'blockers');
  assert.strictEqual(matchCategory('Blocked'), 'blockers');
  assert.strictEqual(matchCategory('阻塞'), 'blockers');
  assert.strictEqual(matchCategory('阻塞项'), 'blockers');

  assert.strictEqual(matchCategory('Status'), 'status');
  assert.strictEqual(matchCategory('当前状态'), 'status');
  assert.strictEqual(matchCategory('状态'), 'status');

  assert.strictEqual(matchCategory('Summary'), 'summary');
  assert.strictEqual(matchCategory('总结'), 'summary');
  assert.strictEqual(matchCategory('摘要'), 'summary');

  assert.strictEqual(matchCategory('Decisions'), 'decisions');
  assert.strictEqual(matchCategory('决定'), 'decisions');
  assert.strictEqual(matchCategory('决策'), 'decisions');

  assert.strictEqual(matchCategory('Notes'), 'notes');
  assert.strictEqual(matchCategory('Note'), 'notes');
  assert.strictEqual(matchCategory('备注'), 'notes');

  assert.strictEqual(matchCategory('Random Heading'), null);
  assert.strictEqual(matchCategory(''), null);
}
