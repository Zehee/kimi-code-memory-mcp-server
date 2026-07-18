#!/usr/bin/env node
/**
 * Generate a Keep-a-Changelog style entry from conventional commits.
 *
 * Usage:
 *   node scripts/generate-changelog.mjs
 *   node scripts/generate-changelog.mjs --from v0.3.0 --to HEAD
 *   node scripts/generate-changelog.mjs --from v0.3.0 --to HEAD --write
 *
 * The generated section is printed to stdout unless --write is used, in which
 * case it is inserted under the existing `## [Unreleased]` heading.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const projectRoot = path.join(path.dirname(__filename), '..');

const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const repoUrl = (pkg.repository?.url || 'https://github.com/Zehee/kimi-code-memory-mcp-server').replace(
  /^git\+(https:\/\/.*)\.git$/,
  '$1',
);

const TYPE_SECTIONS = {
  feat: 'Added',
  fix: 'Fixed',
  docs: 'Changed',
  style: 'Changed',
  refactor: 'Changed',
  perf: 'Changed',
  test: 'Changed',
  ci: 'Changed',
  chore: 'Changed',
  build: 'Changed',
};

const SKIP_PATTERNS = [
  /^release[(:]/i,
  /^docs:\s*update\s+changelog/i,
  /^chore:\s*release/i,
  /^chore\(release\)/i,
];

function parseArgs() {
  const args = process.argv.slice(2);
  let fromTag = null;
  let toRef = 'HEAD';
  let write = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--from') fromTag = args[++i];
    else if (arg === '--to') toRef = args[++i];
    else if (arg === '--write') write = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(`Usage: node scripts/generate-changelog.mjs [--from <tag>] [--to <ref>] [--write]`);
      process.exit(0);
    }
  }

  if (!fromTag) {
    try {
      fromTag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
        cwd: projectRoot,
        encoding: 'utf-8',
      }).trim();
    } catch {
      console.error('Could not determine latest tag. Use --from <tag>.');
      process.exit(1);
    }
  }

  return { fromTag, toRef, write };
}

function gitLogRange(from, to) {
  const format = '%H%x00%s%x00%b%x01';
  const output = execFileSync('git', ['log', '--no-merges', `--pretty=format:${format}`, `${from}..${to}`], {
    cwd: projectRoot,
    encoding: 'utf-8',
  });
  return output
    .split('\x01')
    .map((raw) => raw.trim())
    .filter(Boolean)
    .map((raw) => {
      const [hash, subject, body = ''] = raw.split('\x00');
      return { hash: hash.trim(), subject: subject.trim(), body: body.trim() };
    });
}

function parseConventionalCommit(subject) {
  const match = subject.match(/^(\w+)(?:\(([^)]+)\))?(!)?:\s*(.+)$/);
  if (!match) return null;
  const [, type, scope, breakingMarker, description] = match;
  return {
    type,
    scope,
    description,
    isBreaking: breakingMarker === '!',
  };
}

function shouldSkip(commit) {
  return SKIP_PATTERNS.some((pattern) => pattern.test(commit.subject));
}

function commitLink(hash) {
  const short = hash.slice(0, 7);
  return `[${short}](${repoUrl}/commit/${hash})`;
}

function formatEntry(commit, parsed) {
  const scope = parsed.scope ? `**${parsed.scope}**: ` : '';
  const breaking = parsed.isBreaking || /BREAKING CHANGE:/i.test(commit.body) ? '**BREAKING** ' : '';
  return `- ${breaking}${scope}${parsed.description} (${commitLink(commit.hash)})`;
}

function groupCommits(commits) {
  const groups = {};
  for (const commit of commits) {
    if (shouldSkip(commit)) continue;
    const parsed = parseConventionalCommit(commit.subject);
    if (!parsed) continue;
    const section = TYPE_SECTIONS[parsed.type];
    if (!section) continue;
    groups[section] = groups[section] || [];
    groups[section].push(formatEntry(commit, parsed));
  }
  return groups;
}

function generateMarkdown(groups) {
  const sections = ['Added', 'Changed', 'Fixed'];
  const lines = [];
  for (const section of sections) {
    const entries = groups[section];
    if (!entries || entries.length === 0) continue;
    lines.push(`### ${section}`);
    for (const entry of entries) lines.push(entry);
    lines.push('');
  }
  return lines.join('\n').trim();
}

function insertIntoChangelog(markdown) {
  const changelogPath = path.join(projectRoot, 'CHANGELOG.md');
  let content = fs.readFileSync(changelogPath, 'utf8');

  const unreleasedHeading = '## [Unreleased]\n';
  const idx = content.indexOf(unreleasedHeading);
  if (idx === -1) {
    console.error('Could not find ## [Unreleased] heading in CHANGELOG.md');
    process.exit(1);
  }

  const insertPos = idx + unreleasedHeading.length;
  const before = content.slice(0, insertPos);
  const after = content.slice(insertPos);

  // Avoid duplicating entries if the same commit link already exists.
  const firstLink = markdown.match(/\[([a-f0-9]{7})\]/);
  if (firstLink && after.includes(`[${firstLink[1]}]`)) {
    console.error('These commits already appear to be in CHANGELOG.md. Aborting to avoid duplicates.');
    process.exit(1);
  }

  const spacer = after.startsWith('\n## [') || after.startsWith('## [') ? '\n' : '\n\n';
  const newContent = before + '\n' + markdown + spacer + after;
  fs.writeFileSync(changelogPath, newContent, 'utf8');
  console.log(`Updated ${path.relative(projectRoot, changelogPath)}`);
}

function main() {
  const { fromTag, toRef, write } = parseArgs();
  const commits = gitLogRange(fromTag, toRef);
  const groups = groupCommits(commits);
  const markdown = generateMarkdown(groups);

  if (!markdown) {
    console.error('No changelog-worthy commits found in the range.');
    process.exit(0);
  }

  if (write) {
    insertIntoChangelog(markdown);
  } else {
    console.log(markdown);
  }
}

main();
