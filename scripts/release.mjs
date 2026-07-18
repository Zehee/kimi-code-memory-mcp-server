#!/usr/bin/env node
/**
 * Release helper: bump version, sync src/version.ts, move Unreleased changelog
 * entries to a versioned section, commit, tag, and push.
 *
 * Usage:
 *   node scripts/release.mjs 0.3.2
 *   npm run release -- 0.3.2
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

function updateChangelog(version) {
  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
  const content = fs.readFileSync(changelogPath, 'utf8');

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

  // Check whether there is any actual content (not just blank lines).
  if (!unreleasedBody.trim()) {
    throw new Error('The [Unreleased] section is empty. Nothing to release.');
  }

  const date = todayIso();
  const newUnreleased = '## [Unreleased]\n\n';
  const versionSection = `## [${version}] - ${date}\n`;

  const before = content.slice(0, idx);
  const rest = nextHeadingIdx === -1 ? '' : content.slice(nextHeadingIdx);

  let newContent = before + newUnreleased + versionSection + unreleasedBody + rest;

  // Update link references at the bottom.
  const pkg = readJson('package.json');
  const repoUrl = (pkg.repository?.url || 'https://github.com/Zehee/kimi-code-memory-mcp-server').replace(
    /^git\+(https:\/\/.*)\.git$/,
    '$1',
  );

  const unreleasedLink = `[Unreleased]: ${repoUrl}/compare/v${version}...HEAD`;
  const versionLink = `[${version}]: ${repoUrl}/releases/tag/v${version}`;

  // Remove old [Unreleased]: line if present.
  newContent = newContent.replace(/\[Unreleased\]: .*/g, '');
  // Append fresh links.
  newContent = newContent.trimEnd() + '\n' + unreleasedLink + '\n' + versionLink + '\n';

  fs.writeFileSync(changelogPath, newContent, 'utf8');
}

function main() {
  const version = process.argv[2];
  if (!version) {
    console.error('Usage: node scripts/release.mjs <version>');
    process.exit(1);
  }

  const newVersionParts = parseVersion(version);
  if (!newVersionParts) {
    console.error(`Invalid version: ${version}. Expected semver format X.Y.Z.`);
    process.exit(1);
  }

  const pkg = readJson('package.json');
  const currentVersionParts = parseVersion(pkg.version);
  if (!currentVersionParts) {
    console.error(`Invalid current version in package.json: ${pkg.version}`);
    process.exit(1);
  }

  if (compareVersions(newVersionParts, currentVersionParts) <= 0) {
    console.error(
      `New version ${version} must be greater than current version ${pkg.version}.`,
    );
    process.exit(1);
  }

  // Ensure working tree is clean.
  try {
    execFileSync('git', ['diff', '--quiet'], { cwd: projectRoot });
  } catch {
    console.error('Working tree is not clean. Commit or stash changes before releasing.');
    process.exit(1);
  }

  console.log(`Releasing v${version}...`);

  pkg.version = version;
  writeJson('package.json', pkg);

  run('npm', ['run', 'sync-version']);
  updateChangelog(version);

  run('git', ['add', 'package.json', 'src/version.ts', 'CHANGELOG.md']);
  run('git', ['commit', '-m', `release: v${version}`]);
  run('git', ['tag', `v${version}`]);
  run('git', ['push']);
  run('git', ['push', 'origin', `v${version}`]);

  console.log(`\nv${version} released and pushed. GitHub Actions will publish to npm.`);
}

main();
