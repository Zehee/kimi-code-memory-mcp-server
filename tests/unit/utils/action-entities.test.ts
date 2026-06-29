import assert from 'assert';
import { extractEntitiesFromAction } from '../../../src/utils/action-entities.js';
import type { RawAction } from '../../../src/refine/types.js';

export default async function runTests(): Promise<void> {
  const actionWithPath: RawAction = {
    name: 'read_file',
    args: { path: 'src/index.ts' },
    result: 'ok',
  };
  const extractedPath = extractEntitiesFromAction(actionWithPath);
  assert.deepStrictEqual(extractedPath.tools, ['read_file']);
  assert.deepStrictEqual(extractedPath.files, ['src/index.ts']);
  assert.deepStrictEqual(extractedPath.errors, []);

  const actionWithFile: RawAction = {
    name: 'write_file',
    args: { file: 'README.md' },
  };
  const extractedFile = extractEntitiesFromAction(actionWithFile);
  assert.deepStrictEqual(extractedFile.tools, ['write_file']);
  assert.deepStrictEqual(extractedFile.files, ['README.md']);

  const actionWithFilePath: RawAction = {
    name: 'edit_file',
    args: { filePath: 'src/utils/helpers.ts' },
  };
  const extractedFilePath = extractEntitiesFromAction(actionWithFilePath);
  assert.deepStrictEqual(extractedFilePath.files, ['src/utils/helpers.ts']);

  const actionWithCwd: RawAction = {
    name: 'bash',
    args: { cwd: '/workspace/project', command: 'npm test' },
  };
  const extractedCwd = extractEntitiesFromAction(actionWithCwd);
  assert.deepStrictEqual(extractedCwd.files, ['/workspace/project']);

  const actionWithNodeModulesCwd: RawAction = {
    name: 'read_file',
    args: { cwd: '/workspace/node_modules/lodash', path: 'index.js' },
  };
  const extractedNodeModules = extractEntitiesFromAction(actionWithNodeModulesCwd);
  assert.deepStrictEqual(extractedNodeModules.files, ['index.js']);

  const actionWithError: RawAction = {
    name: 'compile',
    args: { path: 'src/main.ts' },
    result: 'Error: Type mismatch at line 42\nstack trace here',
  };
  const extractedError = extractEntitiesFromAction(actionWithError);
  assert.deepStrictEqual(extractedError.tools, ['compile']);
  assert.strictEqual(extractedError.errors.length, 1);
  assert(extractedError.errors[0].includes('Type mismatch'));
  assert(!extractedError.errors[0].includes('stack trace'));

  const actionWithFailed: RawAction = {
    name: 'deploy',
    result: 'Deployment failed: connection timeout',
  };
  const extractedFailed = extractEntitiesFromAction(actionWithFailed);
  assert.deepStrictEqual(extractedFailed.errors, ['Deployment failed: connection timeout']);

  const actionWithNoName: RawAction = {
    args: { path: 'config.json' },
  };
  const extractedNoName = extractEntitiesFromAction(actionWithNoName);
  assert.deepStrictEqual(extractedNoName.tools, []);
  assert.deepStrictEqual(extractedNoName.files, ['config.json']);
}
