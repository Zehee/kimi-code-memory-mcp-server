import assert from 'assert';
import { scoreText, extractSnippet } from '../../../src/utils/search.js';

export default async function runTests(): Promise<void> {
  assert.strictEqual(scoreText('Hello world', ['hello']), 1);
  assert.strictEqual(scoreText('Hello hello world', ['hello']), 2);
  assert.strictEqual(scoreText('Hello world', ['hello', 'world']), 2);
  assert.strictEqual(scoreText('Hello world', ['foo']), 0);
  assert.strictEqual(scoreText('', ['hello']), 0);
  assert.strictEqual(scoreText('Case Insensitive HELLO', ['hello']), 1);

  const snippet = extractSnippet(
    'This is a long introduction. The quick brown fox jumps over the lazy dog. Hello world is a classic phrase.',
    ['hello', 'world'],
    60,
  );
  assert(snippet.includes('Hello world'));
  assert(snippet.startsWith('...') || snippet.startsWith('This'));

  const firstTermSnippet = extractSnippet(
    'The first term appears here and it is quite long and descriptive.',
    ['first', 'missing'],
    50,
  );
  assert(firstTermSnippet.includes('first term'));

  const noMatchSnippet = extractSnippet('No matching terms here.', ['xyz'], 30);
  assert.strictEqual(noMatchSnippet, 'No matching terms here.');

  const emptyTermsSnippet = extractSnippet('Some content without terms.', [], 20);
  assert.strictEqual(emptyTermsSnippet, 'Some content without...');
}
