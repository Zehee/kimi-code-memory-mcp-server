import assert from 'assert';
import actionEntitiesTests from './utils/action-entities.test.js';
import searchTests from './utils/search.test.js';
import headingsTests from './utils/headings.test.js';
import extractorTests from './refine/extractor.test.js';
import definitionsTests from './tools/definitions.test.js';
import catalogTests from './dao/catalog.test.js';
import refinedStoreTests from './refine/store.test.js';

const suites: Array<{ name: string; run: () => Promise<void> }> = [
  { name: 'utils/action-entities', run: actionEntitiesTests },
  { name: 'utils/search', run: searchTests },
  { name: 'utils/headings', run: headingsTests },
  { name: 'refine/extractor', run: extractorTests },
  { name: 'tools/definitions', run: definitionsTests },
  { name: 'dao/catalog', run: catalogTests },
  { name: 'refine/store', run: refinedStoreTests },
];

async function main() {
  let passed = 0;
  let failed = 0;
  for (const suite of suites) {
    try {
      await suite.run();
      console.log(`✓ ${suite.name}`);
      passed++;
    } catch (err) {
      failed++;
      console.error(`✗ ${suite.name}`);
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  ${message}`);
      if (err instanceof assert.AssertionError && err.stack) {
        const stackLine = err.stack.split('\n').slice(1, 3).join('\n  ');
        console.error(`  ${stackLine}`);
      }
    }
  }
  console.log(`\n${passed} suite(s) passed, ${failed} suite(s) failed`);
  // Some suite combinations leave unref-able handles behind (e.g. a dashboard
  // server started through a dispatched tool). The results are complete at
  // this point: exit explicitly instead of waiting for the loop to drain.
  process.exit(failed > 0 ? 1 : 0);
}

void main();
