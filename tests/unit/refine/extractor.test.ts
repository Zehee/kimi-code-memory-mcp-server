import assert from 'assert';
import { extract } from '../../../src/refine/extractor.js';
import type { RawTurn } from '../../../src/refine/types.js';

export default async function runTests(): Promise<void> {
  const turn: RawTurn = {
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

  const refined = extract(turn, 'session-1');

  assert.strictEqual(refined.turnId, 1);
  assert.strictEqual(refined.sessionId, 'session-1');
  assert.strictEqual(refined.timestamp, '2026-06-24T12:00:00.000Z');
  assert(refined.summary.includes('git_push'), 'summary should include tool name');
  assert(refined.summary.includes('review the migration'), 'summary should include user text');

  assert(refined.facts.some((f) => f.includes('TypeScript')), 'should extract list item fact');
  assert(refined.facts.some((f) => f.includes('package-lock.json')), 'should extract list item fact');
  assert(refined.facts.some((f) => f.includes('tsconfig setup')), 'should extract English action sentence');
  assert(refined.facts.some((f) => f.includes('package-lock')), 'should extract Chinese action sentence');
  assert(refined.facts.some((f) => f.includes('push to GitHub')), 'should extract Next step sentence');

  assert(
    refined.categories.focus && refined.categories.focus.includes('Migration to TypeScript'),
    'should categorize under focus',
  );
  assert(
    refined.categories.completed && refined.categories.completed.some((f) => f.includes('tsconfig')),
    'should categorize under completed',
  );

  assert(refined.notes.some((n) => n.includes('verify CI')), 'should keep declarative fallback note');

  assert.deepStrictEqual(refined.entities.tools, ['git_push']);
  assert.deepStrictEqual(refined.entities.files, ['/workspace/project']);
  assert.deepStrictEqual(refined.entities.errors, []);

  const emptyTurn: RawTurn = {
    turnId: '2',
    timestamp: undefined,
    user: '',
    agentText: '',
    actions: [],
  };
  const emptyRefined = extract(emptyTurn, 'session-2');
  assert.strictEqual(emptyRefined.turnId, 2);
  assert.strictEqual(emptyRefined.summary, '');
  assert.deepStrictEqual(emptyRefined.facts, []);
  assert.deepStrictEqual(emptyRefined.notes, []);
  assert.deepStrictEqual(emptyRefined.entities.tools, []);
}
