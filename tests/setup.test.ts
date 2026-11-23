/**
 * Setup / teardown regression tests.
 *
 * Every case runs against a throw-away Kimi Code home directory; the tests
 * never touch the real user home directory.
 *
 * Run with:  npx tsx tests/setup.test.ts
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { runSetup, readSetupManifest, SetupConflictError } from '../src/setup.js';

const INJECT_START = '<!-- KIMI-MEMORY-INJECTED-START -->';
const INJECT_END = '<!-- KIMI-MEMORY-INJECTED-END -->';

function makeHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-memory-setup-test-'));
}

function read(p: string): string {
  return fs.readFileSync(p, 'utf8');
}

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

const USER_AGENTS = '# My own rules\n\nKeep this line untouched.\n';
const USER_MCP = JSON.stringify(
  {
    mcpServers: {
      other: { command: 'other-server', args: [], enabled: true },
    },
    someOtherKey: { keep: true },
  },
  null,
  2,
) + '\n';

async function testFreshInstall(): Promise<void> {
  const home = makeHome();
  const result = await runSetup({ kimiCodeHome: home });

  const agentsPath = path.join(home, 'AGENTS.md');
  const skillPath = path.join(home, 'skills', 'memory-manage');
  const mcpPath = path.join(home, 'mcp.json');
  const manifestPath = path.join(home, 'memory-setup', 'manifest.json');

  assert(exists(agentsPath), 'AGENTS.md should be created');
  const agents = read(agentsPath);
  assert(agents.includes(INJECT_START), 'AGENTS.md should contain the injected block');
  assert(agents.includes(INJECT_END), 'AGENTS.md should contain the injected block end marker');
  assert(agents.includes('bootstrap_workspace'), 'AGENTS.md should contain the memory protocol');
  assert(
    agents.includes('select_tools(names=["mcp__kimi-memory__bootstrap_workspace"])'),
    'AGENTS.md should explain how to load bootstrap during a cold start',
  );

  assert(exists(path.join(skillPath, 'SKILL.md')), 'skill should be installed');

  assert(exists(mcpPath), 'mcp.json should be created');
  const mcp = JSON.parse(read(mcpPath));
  assert(mcp.mcpServers['kimi-memory'], 'kimi-memory MCP entry should exist');
  assert(mcp.mcpServers['kimi-memory'].enabled === true, 'MCP entry should be enabled');
  assert(
    mcp.mcpServers['kimi-memory'].deferred === true,
    'MCP entry should support first-turn dynamic tool loading',
  );

  assert(exists(manifestPath), 'manifest should be written under KIMI_CODE_HOME');
  const manifest = readSetupManifest(home);
  assert(manifest, 'manifest should be readable');
  assert.strictEqual(manifest!.entries.length, 3, 'manifest should record 3 targets');
  for (const entry of manifest!.entries) {
    assert.strictEqual(entry.existedBefore, false, 'fresh install: nothing existed before');
    assert(entry.installedHash, 'manifest should record the installed content hash');
    assert.strictEqual(entry.previousHash, null, 'fresh install: no previous hash');
  }
  assert(result.actions.length > 0, 'install should report actions');
  assert.strictEqual(result.conflicts.length, 0, 'fresh install should not conflict');
}

async function testInstallPreservesUserFiles(): Promise<void> {
  const home = makeHome();
  const agentsPath = path.join(home, 'AGENTS.md');
  const mcpPath = path.join(home, 'mcp.json');
  write(agentsPath, USER_AGENTS);
  write(mcpPath, USER_MCP);

  await runSetup({ kimiCodeHome: home });

  const agents = read(agentsPath);
  assert(agents.includes('Keep this line untouched.'), 'user AGENTS.md content must be kept');
  assert(agents.includes(INJECT_START), 'injected block must be added');

  const mcp = JSON.parse(read(mcpPath));
  assert(mcp.mcpServers.other, 'other MCP servers must be preserved');
  assert.deepStrictEqual(mcp.someOtherKey, { keep: true }, 'other config keys must be preserved');
  assert(mcp.mcpServers['kimi-memory'], 'kimi-memory entry must be added');

  const manifest = readSetupManifest(home)!;
  const agentsEntry = manifest.entries.find((e) => e.kind === 'agents-md')!;
  const mcpEntry = manifest.entries.find((e) => e.kind === 'mcp-entry')!;
  const skillEntry = manifest.entries.find((e) => e.kind === 'skill')!;
  assert.strictEqual(agentsEntry.existedBefore, true, 'AGENTS.md existed before the install');
  assert.strictEqual(mcpEntry.existedBefore, true, 'mcp.json existed before the install');
  assert.strictEqual(skillEntry.existedBefore, false, 'the skill did not exist before the install');
  assert(agentsEntry.previousHash, 'the previous hash must be recorded');
  assert(mcpEntry.previousHash, 'the previous hash must be recorded');
  assert(agentsEntry.backupPath && exists(agentsEntry.backupPath), 'AGENTS.md must be backed up');
  assert(mcpEntry.backupPath && exists(mcpEntry.backupPath), 'mcp.json must be backed up');
  assert.strictEqual(read(agentsEntry.backupPath!), USER_AGENTS, 'backup must hold the original file');
  assert.strictEqual(read(mcpEntry.backupPath!), USER_MCP, 'backup must hold the original file');
}

async function testRepeatedInstallIsIdempotent(): Promise<void> {
  const home = makeHome();
  write(path.join(home, 'AGENTS.md'), USER_AGENTS);
  write(path.join(home, 'mcp.json'), USER_MCP);

  await runSetup({ kimiCodeHome: home });
  const second = await runSetup({ kimiCodeHome: home });

  assert.strictEqual(second.conflicts.length, 0, 'a second install must not conflict');
  assert.strictEqual(second.warnings.length, 0, 'a second install must not warn');

  const manifest = readSetupManifest(home)!;
  assert.strictEqual(manifest.entries.length, 3, 'manifest should still record 3 targets');

  const agents = read(path.join(home, 'AGENTS.md'));
  assert.strictEqual(agents.split(INJECT_START).length - 1, 1, 'the block must not be duplicated');
}

async function testRepeatedInstallKeepsOriginalBackup(): Promise<void> {
  const home = makeHome();
  const agentsPath = path.join(home, 'AGENTS.md');
  const mcpPath = path.join(home, 'mcp.json');
  write(agentsPath, USER_AGENTS);
  write(mcpPath, USER_MCP);

  await runSetup({ kimiCodeHome: home });
  const afterFirst = readSetupManifest(home)!;
  const agentsEntry = afterFirst.entries.find((e) => e.kind === 'agents-md')!;
  const mcpEntry = afterFirst.entries.find((e) => e.kind === 'mcp-entry')!;

  // A second install must not replace the backup of the original files.
  await runSetup({ kimiCodeHome: home });
  const afterSecond = readSetupManifest(home)!;
  const agentsEntry2 = afterSecond.entries.find((e) => e.kind === 'agents-md')!;
  const mcpEntry2 = afterSecond.entries.find((e) => e.kind === 'mcp-entry')!;

  assert.strictEqual(agentsEntry2.backupPath, agentsEntry.backupPath, 'the AGENTS.md backup must be kept');
  assert.strictEqual(mcpEntry2.backupPath, mcpEntry.backupPath, 'the mcp.json backup must be kept');
  assert.strictEqual(agentsEntry2.existedBefore, true, 'the original state must be remembered');
  assert.strictEqual(mcpEntry2.existedBefore, true, 'the original state must be remembered');

  await runSetup({ kimiCodeHome: home, undo: true });
  assert.strictEqual(read(agentsPath), USER_AGENTS, 'AGENTS.md must be restored byte for byte');
  assert.strictEqual(read(mcpPath), USER_MCP, 'mcp.json must be restored byte for byte');
}

async function testRepeatedInstallKeepsUserEdits(): Promise<void> {
  const home = makeHome();
  const mcpPath = path.join(home, 'mcp.json');
  write(path.join(home, 'AGENTS.md'), USER_AGENTS);
  write(mcpPath, USER_MCP);

  await runSetup({ kimiCodeHome: home });

  // The user adds another MCP server after the install.
  const config = JSON.parse(read(mcpPath));
  config.mcpServers.later = { command: 'later-server' };
  write(mcpPath, JSON.stringify(config, null, 2) + '\n');

  await runSetup({ kimiCodeHome: home });
  await runSetup({ kimiCodeHome: home, undo: true });

  const after = JSON.parse(read(mcpPath));
  assert(!after.mcpServers['kimi-memory'], 'the MCP entry must be removed');
  assert(after.mcpServers.other, 'the original servers must be preserved');
  assert(after.mcpServers.later, 'the server added after the install must be preserved');
}

async function testDryRunWritesNothing(): Promise<void> {
  const home = makeHome();
  const result = await runSetup({ kimiCodeHome: home, dryRun: true });

  assert.strictEqual(result.dryRun, true, 'result should be flagged as a dry run');
  assert(result.steps.length >= 3, 'the dry run should describe the planned steps');
  assert.strictEqual(fs.readdirSync(home).length, 0, 'a dry run must not write anything');
  assert(!exists(path.join(home, 'memory-setup')), 'a dry run must not write a manifest');
}

async function testForeignSkillConflicts(): Promise<void> {
  const home = makeHome();
  const foreignSkill = path.join(home, 'skills', 'memory-manage', 'SKILL.md');
  write(foreignSkill, '# a skill I own\n');

  let conflict: SetupConflictError | null = null;
  try {
    await runSetup({ kimiCodeHome: home });
  } catch (err) {
    conflict = err as SetupConflictError;
  }
  assert(conflict instanceof SetupConflictError, 'a foreign skill must raise a conflict');
  assert(
    conflict!.conflicts.some((c) => c.kind === 'skill'),
    'the conflict must point at the skill directory',
  );

  // The conflict must be detected before anything is written.
  assert(!exists(path.join(home, 'AGENTS.md')), 'a conflicting install must not touch AGENTS.md');
  assert(!exists(path.join(home, 'mcp.json')), 'a conflicting install must not touch mcp.json');
  assert.strictEqual(read(foreignSkill), '# a skill I own\n', 'the foreign skill must be untouched');

  // --force overwrites, but still backs the original up.
  await runSetup({ kimiCodeHome: home, force: true });
  const manifest = readSetupManifest(home)!;
  const skillEntry = manifest.entries.find((e) => e.kind === 'skill')!;
  assert.strictEqual(skillEntry.existedBefore, true, 'the foreign skill existed before');
  assert(skillEntry.backupPath && exists(skillEntry.backupPath), 'the foreign skill must be backed up');
  assert.strictEqual(
    read(path.join(skillEntry.backupPath!, 'SKILL.md')),
    '# a skill I own\n',
    'the backup must hold the original skill',
  );
  assert(
    read(path.join(home, 'skills', 'memory-manage', 'SKILL.md')).includes('memory-manage'),
    'the bundled skill must be installed',
  );
}

async function testForceReinstallPreservesUserEntryOnUndo(): Promise<void> {
  const home = makeHome();
  // Round 1: fresh install.
  await runSetup({ kimiCodeHome: home });

  // The user modifies the kimi-memory entry (adds their own setting).
  const mcpPath = path.join(home, 'mcp.json');
  const mcp = JSON.parse(read(mcpPath));
  mcp.mcpServers['kimi-memory'].userSetting = { theme: 'dark' };
  write(mcpPath, JSON.stringify(mcp, null, 2) + '\n');

  // Round 2: --force reinstall over the modified entry.
  await runSetup({ kimiCodeHome: home, force: true });
  const afterForce = JSON.parse(read(mcpPath));
  assert(
    !afterForce.mcpServers['kimi-memory'].userSetting,
    'the force reinstall overwrote the user modification',
  );

  // Undo must restore the PRE-OVERWRITE version (with userSetting), not the
  // first-install backup (review P1 #1).
  await runSetup({ kimiCodeHome: home, undo: true });
  const afterUndo = JSON.parse(read(mcpPath));
  assert.strictEqual(
    afterUndo.mcpServers['kimi-memory'].userSetting?.theme,
    'dark',
    'the user modification must survive undo after a force reinstall',
  );
}

async function testForeignMcpEntryConflicts(): Promise<void> {
  const home = makeHome();
  const mcpPath = path.join(home, 'mcp.json');
  const foreign = JSON.stringify({ mcpServers: { 'kimi-memory': { command: 'mine' } } }, null, 2) + '\n';
  write(mcpPath, foreign);

  let conflict: SetupConflictError | null = null;
  try {
    await runSetup({ kimiCodeHome: home });
  } catch (err) {
    conflict = err as SetupConflictError;
  }
  assert(conflict instanceof SetupConflictError, 'a foreign MCP entry must raise a conflict');
  assert(
    conflict!.conflicts.some((c) => c.kind === 'mcp-entry'),
    'the conflict must point at the MCP entry',
  );
  assert.strictEqual(read(mcpPath), foreign, 'the foreign MCP entry must be untouched');

  await runSetup({ kimiCodeHome: home, force: true });
  const mcp = JSON.parse(read(mcpPath));
  assert(mcp.mcpServers['kimi-memory'].command !== 'mine', 'the entry must be replaced by --force');
  const manifest = readSetupManifest(home)!;
  const mcpEntry = manifest.entries.find((e) => e.kind === 'mcp-entry')!;
  assert(mcpEntry.backupPath && exists(mcpEntry.backupPath), 'mcp.json must be backed up');
  assert.strictEqual(read(mcpEntry.backupPath!), foreign, 'the backup must hold the original file');
}

async function testUndoRestoresOriginalState(): Promise<void> {
  const home = makeHome();
  const agentsPath = path.join(home, 'AGENTS.md');
  const mcpPath = path.join(home, 'mcp.json');
  write(agentsPath, USER_AGENTS);
  write(mcpPath, USER_MCP);

  await runSetup({ kimiCodeHome: home });
  const undo = await runSetup({ kimiCodeHome: home, undo: true });

  assert.strictEqual(read(agentsPath), USER_AGENTS, 'AGENTS.md must be restored byte for byte');
  assert.strictEqual(read(mcpPath), USER_MCP, 'mcp.json must be restored byte for byte');
  assert(!exists(path.join(home, 'skills', 'memory-manage')), 'the skill must be removed');
  assert(!exists(path.join(home, 'memory-setup', 'manifest.json')), 'the manifest must be removed');
  assert.strictEqual(undo.warnings.length, 0, 'undo should not warn on a clean install');
}

async function testUndoRemovesFilesThatDidNotExist(): Promise<void> {
  const home = makeHome();
  await runSetup({ kimiCodeHome: home });

  assert(exists(path.join(home, 'AGENTS.md')), 'AGENTS.md should exist after the install');
  await runSetup({ kimiCodeHome: home, undo: true });

  assert(!exists(path.join(home, 'AGENTS.md')), 'AGENTS.md must be removed again');
  assert(!exists(path.join(home, 'mcp.json')), 'mcp.json must be removed again');
  assert(!exists(path.join(home, 'skills', 'memory-manage')), 'the skill must be removed');
}

async function testUndoKeepsUserModifiedContent(): Promise<void> {
  const home = makeHome();
  const agentsPath = path.join(home, 'AGENTS.md');
  const skillPath = path.join(home, 'skills', 'memory-manage');
  write(agentsPath, USER_AGENTS);
  write(path.join(home, 'mcp.json'), USER_MCP);

  await runSetup({ kimiCodeHome: home });

  // The user edits the injected block and the installed skill.
  write(
    agentsPath,
    read(agentsPath).replace('bootstrap_workspace', 'my_own_bootstrap_hook'),
  );
  write(path.join(skillPath, 'SKILL.md'), '# my own skill version\n');

  const undo = await runSetup({ kimiCodeHome: home, undo: true });

  assert(
    read(agentsPath).includes('my_own_bootstrap_hook'),
    'a user modified AGENTS.md must be kept',
  );
  assert(
    read(agentsPath).includes(INJECT_START),
    'a user modified block must not be removed silently',
  );
  assert.strictEqual(
    read(path.join(skillPath, 'SKILL.md')),
    '# my own skill version\n',
    'a user modified skill must be kept',
  );
  assert(
    undo.warnings.some((w) => w.includes('modified')),
    'undo must warn about the modified content',
  );

  // Untouched targets are still reverted.
  assert(!exists(path.join(home, 'mcp.json')) === false, 'the MCP entry is removed from mcp.json');
  const mcp = JSON.parse(read(path.join(home, 'mcp.json')));
  assert(!mcp.mcpServers['kimi-memory'], 'the MCP entry must be removed');
  assert(mcp.mcpServers.other, 'other MCP servers must be preserved');

  const manifest = readSetupManifest(home);
  assert(manifest, 'the manifest must be kept for the modified entries');
  assert.strictEqual(manifest!.entries.length, 2, 'only the modified entries stay in the manifest');
}

async function testUndoRemovesBlockWhenOnlyOutsideChanged(): Promise<void> {
  const home = makeHome();
  const agentsPath = path.join(home, 'AGENTS.md');
  write(agentsPath, USER_AGENTS);

  await runSetup({ kimiCodeHome: home });
  write(agentsPath, read(agentsPath) + '\n# an addition outside the injected block\n');

  await runSetup({ kimiCodeHome: home, undo: true });

  const after = read(agentsPath);
  assert(!after.includes(INJECT_START), 'the injected block must be removed');
  assert(after.includes('# an addition outside the injected block'), 'user edits must be kept');
  assert(after.includes('Keep this line untouched.'), 'the original content must be kept');
}

async function testUndoKeepsModifiedMcpEntry(): Promise<void> {
  const home = makeHome();
  const mcpPath = path.join(home, 'mcp.json');
  write(path.join(home, 'AGENTS.md'), USER_AGENTS);
  write(mcpPath, USER_MCP);

  await runSetup({ kimiCodeHome: home });

  const mcp = JSON.parse(read(mcpPath));
  mcp.mcpServers['kimi-memory'].command = '/my/own/server.js';
  write(mcpPath, JSON.stringify(mcp, null, 2) + '\n');

  const undo = await runSetup({ kimiCodeHome: home, undo: true });

  const after = JSON.parse(read(mcpPath));
  assert.strictEqual(
    after.mcpServers['kimi-memory'].command,
    '/my/own/server.js',
    'a user modified MCP entry must be kept',
  );
  assert(
    undo.warnings.some((w) => w.includes('modified')),
    'undo must warn about the modified MCP entry',
  );
}

async function testRollbackOnFailure(): Promise<void> {
  const home = makeHome();
  const agentsPath = path.join(home, 'AGENTS.md');
  const mcpPath = path.join(home, 'mcp.json');
  write(agentsPath, USER_AGENTS);
  write(mcpPath, USER_MCP);

  let failed = false;
  try {
    await runSetup({
      kimiCodeHome: home,
      fault: (op) => {
        if (op === 'write:mcp-entry') throw new Error('injected failure');
      },
    });
  } catch (err) {
    failed = true;
    assert((err as Error).message.includes('injected failure'), 'the original error must surface');
  }
  assert(failed, 'the injected failure must abort the install');

  assert.strictEqual(read(agentsPath), USER_AGENTS, 'AGENTS.md must be rolled back');
  assert.strictEqual(read(mcpPath), USER_MCP, 'mcp.json must be rolled back');
  assert(!exists(path.join(home, 'skills', 'memory-manage')), 'the skill must be rolled back');
  assert(!exists(path.join(home, 'memory-setup', 'manifest.json')), 'no manifest must be written');
}

async function testRollbackRestoresMissingFiles(): Promise<void> {
  const home = makeHome();

  let failed = false;
  try {
    await runSetup({
      kimiCodeHome: home,
      fault: (op) => {
        if (op === 'write:mcp-entry') throw new Error('injected failure');
      },
    });
  } catch {
    failed = true;
  }
  assert(failed, 'the injected failure must abort the install');

  assert(!exists(path.join(home, 'AGENTS.md')), 'AGENTS.md must not survive the rollback');
  assert(!exists(path.join(home, 'mcp.json')), 'mcp.json must not survive the rollback');
  assert(!exists(path.join(home, 'skills', 'memory-manage')), 'the skill must not survive');
}

async function testRollbackWhenManifestFails(): Promise<void> {
  const home = makeHome();
  const agentsPath = path.join(home, 'AGENTS.md');
  write(agentsPath, USER_AGENTS);

  let failed = false;
  try {
    await runSetup({
      kimiCodeHome: home,
      fault: (op) => {
        if (op === 'write:manifest') throw new Error('injected manifest failure');
      },
    });
  } catch {
    failed = true;
  }
  assert(failed, 'a manifest failure must abort the install');
  assert.strictEqual(read(agentsPath), USER_AGENTS, 'AGENTS.md must be rolled back');
  assert(!exists(path.join(home, 'skills', 'memory-manage')), 'the skill must be rolled back');
  assert(!exists(path.join(home, 'mcp.json')), 'mcp.json must not survive the rollback');
}

async function testRollbackRestoresReplacedSkill(): Promise<void> {
  const home = makeHome();
  const agentsPath = path.join(home, 'AGENTS.md');
  const skillPath = path.join(home, 'skills', 'memory-manage', 'SKILL.md');
  write(agentsPath, USER_AGENTS);
  write(skillPath, '# a skill I own\n');

  let failed = false;
  try {
    await runSetup({
      kimiCodeHome: home,
      force: true,
      fault: (op) => {
        // Fail after the previous skill directory was removed but before the
        // bundled skill was moved into place.
        if (op === 'rename:skill') throw new Error('injected failure');
      },
    });
  } catch {
    failed = true;
  }
  assert(failed, 'the injected failure must abort the install');

  assert.strictEqual(read(agentsPath), USER_AGENTS, 'AGENTS.md must be rolled back');
  assert.strictEqual(read(skillPath), '# a skill I own\n', 'the previous skill must be restored');
  assert(!exists(path.join(home, 'mcp.json')), 'mcp.json must not be created');
  assert(!exists(path.join(home, 'memory-setup', 'manifest.json')), 'no manifest must be written');
  const leftovers = fs
    .readdirSync(path.join(home, 'skills'))
    .filter((entry) => entry.includes('staging'));
  assert.deepStrictEqual(leftovers, [], 'no staging directory must be left behind');
}

async function testWorkspaceScope(): Promise<void> {
  const home = makeHome();
  const workspace = makeHome();
  const originalCwd = process.cwd();
  process.chdir(workspace);
  try {
    const result = await runSetup({ kimiCodeHome: home, scope: 'workspace' });

    const workspaceAgents = path.join(workspace, 'AGENTS.md');
    const globalAgents = path.join(home, 'AGENTS.md');
    assert(exists(workspaceAgents), 'the workspace AGENTS.md was created');
    assert(read(workspaceAgents).includes(INJECT_START), 'the block is in the workspace AGENTS.md');
    assert(!exists(globalAgents), 'the global AGENTS.md is not touched');
    assert.strictEqual(result.agentsMdPath, workspaceAgents);

    const manifest = readSetupManifest(home);
    const agentsEntries = manifest?.entries.filter((e) => e.kind === 'agents-md') ?? [];
    assert.strictEqual(agentsEntries.length, 1, 'one agents-md entry');
    assert.strictEqual(agentsEntries[0].targetPath, workspaceAgents);

    // A global install in the same home must not clobber the workspace one:
    // two entries coexist, keyed by their exact target paths.
    await runSetup({ kimiCodeHome: home });
    assert(read(globalAgents).includes(INJECT_START), 'the global block was installed');
    const both = readSetupManifest(home)?.entries.filter((e) => e.kind === 'agents-md') ?? [];
    assert.strictEqual(both.length, 2, 'both agents-md targets are recorded');

    // Workspace undo only removes the workspace block.
    await runSetup({ kimiCodeHome: home, scope: 'workspace', undo: true });
    assert(!exists(workspaceAgents), 'the workspace AGENTS.md was removed');
    assert(read(globalAgents).includes(INJECT_START), 'the global block survives');

    // Global undo cleans the rest.
    await runSetup({ kimiCodeHome: home, undo: true });
    assert(!exists(globalAgents), 'the global AGENTS.md was removed');
  } finally {
    process.chdir(originalCwd);
  }
}

async function testNoSecretsInLogOutput(): Promise<void> {
  const home = makeHome();
  const mcpPath = path.join(home, 'mcp.json');
  const secret = 'super-secret-token-value';
  write(mcpPath, JSON.stringify({ mcpServers: { other: { command: 'x', env: { TOKEN: secret } } } }, null, 2) + '\n');

  const result = await runSetup({ kimiCodeHome: home });
  const output = [...result.actions, ...result.warnings].join('\n');
  assert(!output.includes(secret), 'setup output must not contain configuration secrets');

  const manifestText = read(path.join(home, 'memory-setup', 'manifest.json'));
  assert(!manifestText.includes(secret), 'the manifest must not store configuration secrets');
}

async function testUndoWithoutManifest(): Promise<void> {
  const home = makeHome();
  const result = await runSetup({ kimiCodeHome: home, undo: true });
  assert(
    result.warnings.some((w) => w.includes('manifest')),
    'undo without a manifest must report that there is nothing to undo',
  );
  assert(!exists(path.join(home, 'AGENTS.md')), 'undo without a manifest must not change anything');
}

const suites: Array<{ name: string; run: () => Promise<void> }> = [
  { name: 'setup/fresh-install', run: testFreshInstall },
  { name: 'setup/install-preserves-user-files', run: testInstallPreservesUserFiles },
  { name: 'setup/repeated-install', run: testRepeatedInstallIsIdempotent },
  { name: 'setup/repeated-install-keeps-original-backup', run: testRepeatedInstallKeepsOriginalBackup },
  { name: 'setup/repeated-install-keeps-user-edits', run: testRepeatedInstallKeepsUserEdits },
  { name: 'setup/dry-run', run: testDryRunWritesNothing },
  { name: 'setup/foreign-skill-conflict', run: testForeignSkillConflicts },
  { name: 'setup/foreign-mcp-entry-conflict', run: testForeignMcpEntryConflicts },
  { name: 'setup/force-reinstall-preserves-user-entry', run: testForceReinstallPreservesUserEntryOnUndo },
  { name: 'setup/undo-restores-original-state', run: testUndoRestoresOriginalState },
  { name: 'setup/undo-removes-created-files', run: testUndoRemovesFilesThatDidNotExist },
  { name: 'setup/undo-keeps-user-modified-content', run: testUndoKeepsUserModifiedContent },
  { name: 'setup/undo-removes-block-when-only-outside-changed', run: testUndoRemovesBlockWhenOnlyOutsideChanged },
  { name: 'setup/undo-keeps-modified-mcp-entry', run: testUndoKeepsModifiedMcpEntry },
  { name: 'setup/rollback-on-failure', run: testRollbackOnFailure },
  { name: 'setup/rollback-restores-missing-files', run: testRollbackRestoresMissingFiles },
  { name: 'setup/rollback-when-manifest-fails', run: testRollbackWhenManifestFails },
  { name: 'setup/rollback-restores-replaced-skill', run: testRollbackRestoresReplacedSkill },
  { name: 'setup/workspace-scope', run: testWorkspaceScope },
  { name: 'setup/no-secrets-in-output', run: testNoSecretsInLogOutput },
  { name: 'setup/undo-without-manifest', run: testUndoWithoutManifest },
];

export default async function runTests(): Promise<void> {
  for (const suite of suites) {
    await suite.run();
    console.log(`✓ ${suite.name}`);
  }
}

async function main(): Promise<void> {
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
        console.error(`  ${err.stack.split('\n').slice(1, 4).join('\n  ')}`);
      }
    }
  }
  console.log(`\n${passed} suite(s) passed, ${failed} suite(s) failed`);
  if (failed > 0) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main();
}
