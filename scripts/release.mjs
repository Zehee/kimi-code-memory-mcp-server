#!/usr/bin/env node
/**
 * Release helper: verify the release gates, bump the version, sync
 * package.json / package-lock.json / src/version.ts, move Unreleased changelog
 * entries to a versioned section, commit, tag, and push.
 *
 * Usage:
 *   node scripts/release.mjs 0.3.2        # full release
 *   node scripts/release.mjs --verify     # run the release gates only
 *   node scripts/release.mjs --check-clean # only the working tree clean check
 *
 * The script never publishes to npm: publishing is done by the GitHub Actions
 * workflow after the tag was pushed.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.join(path.dirname(__filename), '..');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: projectRoot, stdio: 'inherit', ...opts });
}

function runCapture(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: projectRoot, encoding: 'utf8', ...opts });
}

/**
 * Resolve the npm CLI entry point.
 *
 * On Windows `npm` is a `.cmd` shim that cannot be spawned directly, so the
 * npm CLI script is preferred when it can be located.
 */
function resolveNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath,
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(nodeDir, '..', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Run an npm command in a way that also works on Windows.
 */
function npmRun(args, opts = {}) {
  const npmCli = resolveNpmCli();
  if (npmCli) {
    return execFileSync(process.execPath, [npmCli, ...args], {
      cwd: projectRoot,
      stdio: 'inherit',
      ...opts,
    });
  }
  if (process.platform === 'win32') {
    return execFileSync('npm.cmd', args, { cwd: projectRoot, stdio: 'inherit', shell: true, ...opts });
  }
  return execFileSync('npm', args, { cwd: projectRoot, stdio: 'inherit', ...opts });
}

/** Run an npm command and capture its output. */
function npmCapture(args) {
  const npmCli = resolveNpmCli();
  if (npmCli) {
    return execFileSync(process.execPath, [npmCli, ...args], { cwd: projectRoot, encoding: 'utf8' });
  }
  if (process.platform === 'win32') {
    return execFileSync('npm.cmd', args, { cwd: projectRoot, encoding: 'utf8', shell: true });
  }
  return execFileSync('npm', args, { cwd: projectRoot, encoding: 'utf8' });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, file), 'utf8'));
}

function writeJson(file, data) {
  fs.writeFileSync(path.join(projectRoot, file), JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function parseVersion(v) {
  const match = v.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return match.slice(1).map(Number);
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function tagExists(version) {
  try {
    runCapture('git', ['rev-parse', '--verify', `refs/tags/v${version}`]);
    return true;
  } catch {
    return false;
  }
}

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// gate 1: clean working tree (unstaged + staged + untracked)
// ---------------------------------------------------------------------------

function checkCleanWorkingTree() {
  const status = runCapture('git', ['status', '--porcelain']);
  const lines = status.split('\n').filter((line) => line.length > 0);

  if (lines.length === 0) {
    console.log('✓ Working tree is clean (no unstaged, staged or untracked changes).');
    return;
  }

  const untracked = [];
  const staged = [];
  const unstaged = [];

  for (const line of lines) {
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (code === '??') {
      untracked.push(file);
      continue;
    }
    if (code[0] !== ' ') staged.push(file);
    if (code[1] !== ' ') unstaged.push(file);
  }

  console.error('✗ Working tree is not clean:');
  if (unstaged.length) {
    console.error('  Unstaged changes:');
    for (const file of unstaged) console.error(`    ${file}`);
  }
  if (staged.length) {
    console.error('  Staged changes:');
    for (const file of staged) console.error(`    ${file}`);
  }
  if (untracked.length) {
    console.error('  Untracked files:');
    for (const file of untracked) console.error(`    ${file}`);
  }
  console.error('\nCommit, stash or remove them before releasing.');
  fail('The working tree must be completely clean (unstaged, staged and untracked).');
}

// ---------------------------------------------------------------------------
// gate 2: version consistency (package.json / lockfile / src/version.ts)
// ---------------------------------------------------------------------------

function readRuntimeVersion() {
  const versionPath = path.join(projectRoot, 'src', 'version.ts');
  const content = fs.readFileSync(versionPath, 'utf8');
  const match = content.match(/export const VERSION\s*=\s*'([^']+)'/);
  return match ? match[1] : null;
}

function checkVersionConsistency() {
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  const runtime = readRuntimeVersion();

  const problems = [];
  if (lock.version !== pkg.version) {
    problems.push(`package-lock.json#version (${lock.version}) !== package.json#version (${pkg.version})`);
  }
  const lockRootVersion = lock.packages && lock.packages[''] ? lock.packages[''].version : null;
  if (lockRootVersion !== pkg.version) {
    problems.push(
      `package-lock.json#packages[""].version (${lockRootVersion}) !== package.json#version (${pkg.version})`,
    );
  }
  if (runtime !== pkg.version) {
    problems.push(`src/version.ts (${runtime}) !== package.json#version (${pkg.version})`);
  }

  if (problems.length > 0) {
    console.error('✗ Version mismatch:');
    for (const problem of problems) console.error(`  ${problem}`);
    console.error('\nRun `node scripts/release.mjs --sync-lockfile` (or `npm install --package-lock-only`) and `npm run sync-version` before releasing.');
    fail('package.json, package-lock.json and src/version.ts must report the same version.');
  }

  console.log(`✓ Version is consistent across package.json, package-lock.json and src/version.ts (${pkg.version}).`);
}

/** Keep package-lock.json in sync with the new package.json version. */
function syncLockfileVersion(version) {
  const lockPath = path.join(projectRoot, 'package-lock.json');
  const raw = fs.readFileSync(lockPath, 'utf8');
  const lock = JSON.parse(raw);

  lock.version = version;
  if (lock.packages && lock.packages['']) lock.packages[''].version = version;

  const updated = JSON.stringify(lock, null, 2) + '\n';
  if (updated !== raw) {
    fs.writeFileSync(lockPath, updated, 'utf8');
    console.log(`Synced package-lock.json to ${version}`);
  }
}

// ---------------------------------------------------------------------------
// gate 3: build / test / pack verification
// ---------------------------------------------------------------------------

const PACK_REQUIRED_FILES = [
  'package.json',
  'README.md',
  'README.en.md',
  'LICENSE',
  'CHANGELOG.md',
  'dist/server.js',
  'dist/setup-cli.js',
  'assets/user-agents.md',
  'skills/memory-manage/SKILL.md',
];

const PACK_FORBIDDEN_PREFIXES = [
  'node_modules/',
  'tests/',
  '.github/',
  '.codegraph/',
  '.kimi-code/',
  'memory/',
  'dist-tests/',
];

function verifyPackContents() {
  const output = npmCapture(['pack', '--dry-run', '--json']);

  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch {
    console.error(output);
    fail('Could not parse the output of `npm pack --dry-run --json`.');
  }

  const info = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = (info && info.files ? info.files : []).map((entry) => entry.path);

  if (files.length === 0) {
    fail('`npm pack --dry-run` did not report any packaged files.');
  }

  const missing = PACK_REQUIRED_FILES.filter((file) => !files.includes(file));
  const unexpected = files.filter(
    (file) => PACK_FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)),
  );

  if (missing.length > 0) {
    console.error('✗ The published package would miss required files:');
    for (const file of missing) console.error(`  ${file}`);
    fail('The package content does not match the expected file list.');
  }

  if (unexpected.length > 0) {
    console.error('✗ The published package would contain files that must not be shipped:');
    for (const file of unexpected) console.error(`  ${file}`);
    fail('The package content does not match the expected file list.');
  }

  console.log(`✓ \`npm pack --dry-run\` lists ${files.length} files and they match the expected content.`);
}

function runVerificationGates({ install = true } = {}) {
  if (install) {
    console.log('> npm ci');
    npmRun(['ci']);
  }
  console.log('> npm run typecheck');
  npmRun(['run', 'typecheck']);
  console.log('> npm run lint');
  npmRun(['run', 'lint']);
  console.log('> npm run test:unit');
  npmRun(['run', 'test:unit']);
  // Integration tests include setup, whose generated MCP entry must point at
  // dist/server.js. A clean checkout has no dist yet, so build before npm test.
  console.log('> npm run build');
  npmRun(['run', 'build']);
  console.log('> npm test');
  npmRun(['test']);
  // Security-focused dashboard tests and a real stdio MCP verification of
  // the BUILT artifacts (review round 5, item 5: these were missing from
  // the release gate).
  console.log('> npx tsx tests/vis-security.test.ts');
  npmRun(['exec', 'tsx', 'tests/vis-security.test.ts']);
  console.log('> npx tsx tests/verify-built-instance.mts');
  npmRun(['exec', 'tsx', 'tests/verify-built-instance.mts']);
  console.log('> npm pack --dry-run');
  verifyPackContents();
  console.log('\n✓ All release gates passed.');
}

// ---------------------------------------------------------------------------
// changelog
// ---------------------------------------------------------------------------

function updateChangelog(version, { currentVersionRelease = false } = {}) {
  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
  // Normalize CRLF: on Windows with core.autocrlf=true the working copy may have \r\n.
  const content = fs.readFileSync(changelogPath, 'utf8').replace(/\r\n/g, '\n');

  const unreleasedHeading = '## [Unreleased]\n';
  const idx = content.indexOf(unreleasedHeading);
  if (idx === -1) {
    throw new Error('Could not find ## [Unreleased] heading in CHANGELOG.md');
  }

  const afterHeading = idx + unreleasedHeading.length;
  const nextHeadingIdx = content.indexOf('## [', afterHeading);
  const unreleasedBody = nextHeadingIdx === -1
    ? content.slice(afterHeading)
    : content.slice(afterHeading, nextHeadingIdx);

  if (!unreleasedBody.trim() && !currentVersionRelease) {
    throw new Error('The [Unreleased] section is empty. Nothing to release.');
  }

  const before = content.slice(0, idx);
  const newUnreleased = '## [Unreleased]\n\n';
  let newContent;

  if (currentVersionRelease) {
    const versionHeading = `## [${version}]`;
    const existingVersionIdx = content.indexOf(versionHeading, afterHeading);
    if (existingVersionIdx === -1) {
      throw new Error(`Could not find the existing ## [${version}] section for a current-version release.`);
    }
    const headingEnd = content.indexOf('\n', existingVersionIdx);
    const existingAfterHeading = headingEnd + 1;
    const releaseHeading = `## [${version}] - ${todayIso()}\n`;
    const existingNextHeadingIdx = content.indexOf('## [', existingAfterHeading);
    const existingBody = existingNextHeadingIdx === -1
      ? content.slice(existingAfterHeading)
      : content.slice(existingAfterHeading, existingNextHeadingIdx);
    const mergedBody = unreleasedBody.trim()
      ? `${unreleasedBody.trim()}\n\n${existingBody.trim()}\n\n`
      : existingBody;
    const rest = existingNextHeadingIdx === -1 ? '' : content.slice(existingNextHeadingIdx);
    newContent =
      before +
      newUnreleased +
      releaseHeading +
      mergedBody +
      rest;
  } else {
    const versionSection = `## [${version}] - ${todayIso()}\n`;
    const rest = nextHeadingIdx === -1 ? '' : content.slice(nextHeadingIdx);
    newContent = before + newUnreleased + versionSection + unreleasedBody + rest;
  }

  // Update link references at the bottom.
  const pkg = readJson('package.json');
  const repoUrl = (pkg.repository?.url || 'https://github.com/Zehee/kimi-code-memory-mcp-server').replace(
    /^git\+(https:\/\/.*)\.git$/,
    '$1',
  );

  const unreleasedLink = `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD`;
  const versionLink = `[${version}]: ${repoUrl}/releases/tag/v${version}`;
  const escapedVersion = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  newContent = newContent.replace(/\[Unreleased\]: .*/g, '');
  newContent = newContent.replace(new RegExp(`\\[${escapedVersion}\\]: .*`, 'g'), '');
  newContent = newContent.trimEnd() + '\n' + unreleasedLink + '\n' + versionLink + '\n';

  fs.writeFileSync(changelogPath, newContent, 'utf8');
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Release helper for kimi-code-memory-mcp-server

Usage:
  node scripts/release.mjs <version>        Bump, tag and push a new release
  node scripts/release.mjs --verify         Run the release gates only
  node scripts/release.mjs --check-clean     Only check the working tree
  node scripts/release.mjs --check-versions  Only check the version consistency
  node scripts/release.mjs --check-pack      Only check the npm package content
  node scripts/release.mjs --sync-lockfile  Sync the lockfile version to package.json

Options:
  --skip-install      Skip "npm ci" in the verification gates
  --help, -h          Show this help

The script never publishes to npm. The release version may equal the current
package.json version when that version has already been bumped but is not yet tagged.`);
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((arg) => arg.startsWith('--')));
  const positional = args.filter((arg) => !arg.startsWith('--'));

  if (flags.has('--help') || flags.has('-h')) {
    printHelp();
    return;
  }

  if (flags.has('--check-clean')) {
    checkCleanWorkingTree();
    return;
  }

  if (flags.has('--check-versions')) {
    checkVersionConsistency();
    return;
  }

  if (flags.has('--check-pack')) {
    verifyPackContents();
    return;
  }

  if (flags.has('--sync-lockfile')) {
    const pkg = readJson('package.json');
    syncLockfileVersion(pkg.version);
    checkVersionConsistency();
    return;
  }

  if (flags.has('--verify')) {
    checkCleanWorkingTree();
    checkVersionConsistency();
    runVerificationGates({ install: !flags.has('--skip-install') });
    return;
  }

  const version = positional[0];
  if (!version) {
    console.error('Usage: node scripts/release.mjs <version> | --verify | --check-clean');
    process.exit(1);
  }

  const newVersionParts = parseVersion(version);
  if (!newVersionParts) {
    console.error(`Invalid version: ${version}. Expected semver format X.Y.Z.`);
    process.exit(1);
  }

  checkCleanWorkingTree();

  // Synchronize before verification so every gate runs against the exact code
  // that will be tagged, including changes pushed by the changelog bot.
  const currentBranch = runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (currentBranch && currentBranch !== 'HEAD') {
    run('git', ['pull', '--rebase', 'origin', currentBranch]);
  }
  checkCleanWorkingTree();

  const pkg = readJson('package.json');
  const currentVersionParts = parseVersion(pkg.version);
  if (!currentVersionParts) {
    console.error(`Invalid current version in package.json: ${pkg.version}`);
    process.exit(1);
  }

  const versionComparison = compareVersions(newVersionParts, currentVersionParts);
  if (versionComparison < 0) {
    console.error(
      `New version ${version} must not be older than current version ${pkg.version}.`,
    );
    process.exit(1);
  }
  const currentVersionRelease = versionComparison === 0;
  if (currentVersionRelease && tagExists(version)) {
    console.error(`Version ${version} is already tagged as v${version}.`);
    process.exit(1);
  }

  checkVersionConsistency();
  runVerificationGates({ install: !flags.has('--skip-install') });

  console.log(`Releasing v${version}...`);

  pkg.version = version;
  writeJson('package.json', pkg);
  syncLockfileVersion(version);

  // Run sync-version directly with node; spawning npm's .cmd shim is unreliable on Windows.
  run(process.execPath, [path.join(projectRoot, 'scripts/sync-version.mjs')]);
  updateChangelog(version, { currentVersionRelease });

  run('git', ['add', 'package.json', 'package-lock.json', 'src/version.ts', 'CHANGELOG.md']);
  const commitArgs = ['commit'];
  if (currentVersionRelease) commitArgs.push('--allow-empty');
  commitArgs.push('-m', `release: v${version}`);
  run('git', commitArgs);
  run('git', ['tag', `v${version}`]);
  run('git', ['push', 'origin', currentBranch || 'main']);
  run('git', ['push', 'origin', `v${version}`]);

  console.log(`\nv${version} released and pushed. GitHub Actions will publish to npm.`);
}

main();
