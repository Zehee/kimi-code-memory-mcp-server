#!/usr/bin/env node
/**
 * CLI entry for kimi-code-memory-mcp-server setup and workspace maintenance.
 *
 * Usage:
 *   npx kimi-code-memory-mcp-server setup
 *   npx kimi-code-memory-mcp-server setup --undo
 *   npx kimi-code-memory-mcp-server setup --dry-run
 *   npx kimi-code-memory-mcp-server setup --force
 *   npx kimi-code-memory-mcp-server setup --purge-backups
 *   npx kimi-code-memory-mcp-server setup --kimi-code-home /path/to/.kimi-code
 *   npx kimi-code-memory-mcp-server setup --scope workspace
 *
 * Maintenance (operates on the CURRENT workspace's memory store):
 *   kimi-memory-setup --doctor
 *   kimi-memory-setup --export-data <dir>
 *   kimi-memory-setup --backup-data [--keep <n>]
 *   kimi-memory-setup --prune-data [--older-than <days>]
 *   kimi-memory-setup --purge-derived-data
 */

import fs from 'fs';
import path from 'path';
import { runSetup, SetupConflictError, type SetupOptions } from './setup.js';
import { purgeDerivedData } from './purge.js';
import {
  doctorReport,
  exportWorkspaceData,
  backupWorkspaceData,
  pruneByRetention,
  countHostWires,
} from './maintenance.js';
import { getStoreRoot } from './config.js';
import { computeWorkspaceId } from './utils/paths.js';
import { IndexDao } from './dao/index.js';
import {
  LockTimeoutError,
  WorkspaceLock,
  workspaceLockRoot,
} from './utils/workspace-lock.js';

function resolveStoreRoot(): string {
  const cwd = process.cwd().replace(/\\/g, '/');
  return path.join(getStoreRoot(), computeWorkspaceId(cwd));
}

async function withStoreLock<T>(storeRoot: string, fn: () => T): Promise<T> {
  const lock = new WorkspaceLock(workspaceLockRoot(storeRoot), { timeoutMs: 5_000 });
  return lock.withLock('workspace', fn);
}

function printPurgeAborted(): void {
  console.error('Aborted: another process holds the workspace lock.');
  console.error('Stop the running Kimi Code sessions for this workspace and retry.');
  process.exit(1);
}

function runDoctor(): void {
  const storeRoot = resolveStoreRoot();
  if (!fs.existsSync(storeRoot)) {
    console.log(`No memory store found at ${storeRoot}; nothing to inspect.`);
    return;
  }
  const indexDao = new IndexDao(storeRoot);
  const report = doctorReport(storeRoot, () => indexDao.getIndexState());
  console.log(`Doctor report for ${storeRoot}\n`);
  console.log(`index: ${report.indexState.state} (lastSync ${report.indexState.lastSyncAt ?? 'never'})`);
  console.log(
    `memories: ${report.memories.total} total, ${report.memories.missingId} without id, ` +
      `${report.memories.missingRevision} without revision, ${report.memories.missingSchemaVersion} without schemaVersion` +
      (report.memories.corrupt.length > 0 ? `, ${report.memories.corrupt.length} CORRUPT` : ''),
  );
  if (report.memories.corrupt.length > 0) {
    for (const file of report.memories.corrupt) console.log(`  corrupt: ${file}`);
  }
  console.log(
    `themes: ${report.themes.total} total, ${report.themes.missingSchemaVersion} without schemaVersion, ` +
      `${report.themes.legacyPathRefs} legacy path refs, ${report.themes.orphanedRefs} orphaned/deleted refs`,
  );
  console.log(`search views: ${report.searchViews.total} total (${report.searchViews.legacy} legacy format)`);
  console.log(
    `refined: schema ${report.refined.schemaVersion ?? 'absent'}, ${report.refined.unknownFreshnessRows} row(s) with unknown freshness`,
  );
  console.log(
    `journal: ${report.journal.unfinishedEntries} unfinished, trash: ${report.trash.entries}, essence history: ${report.essenceHistory}`,
  );
  if (report.journal.corruptEntries.length > 0) {
    console.log(`journal CORRUPT entries: ${report.journal.corruptEntries.length} (kept on disk for inspection)`);
    for (const item of report.journal.corruptEntries) {
      console.log(`  corrupt: ${item.file} — ${item.reason}`);
    }
  }
  const wires = countHostWires(storeRoot);
  console.log(`host wires (never touched): ${wires.count} under ${wires.root ?? 'unknown'}`);
  console.log('');
  if (report.pendingActions.length === 0) {
    console.log('No pending migration actions. Store is up to date.');
  } else {
    console.log('Pending actions a migration run would take (dry-run, nothing changed):');
    for (const action of report.pendingActions) {
      console.log(`  - ${action}`);
    }
  }
}

async function runExportData(targetDir: string): Promise<void> {
  const storeRoot = resolveStoreRoot();
  if (!fs.existsSync(storeRoot)) {
    console.log(`No memory store found at ${storeRoot}; nothing to export.`);
    return;
  }
  const report = await withStoreLock(storeRoot, () =>
    exportWorkspaceData(storeRoot, path.resolve(targetDir)),
  );
  console.log(`Exported workspace data to ${report.targetDir}`);
  for (const item of report.copied) console.log(`  + ${item.category}: ${item.files} file(s)`);
  for (const item of report.skipped) console.log(`  - skipped: ${item}`);
  const wires = countHostWires(storeRoot);
  console.log(`host wires (never touched): ${wires.count}`);
}

async function runBackupData(keep: number): Promise<void> {
  const storeRoot = resolveStoreRoot();
  if (!fs.existsSync(storeRoot)) {
    console.log(`No memory store found at ${storeRoot}; nothing to back up.`);
    return;
  }
  const { report, pruned } = await withStoreLock(storeRoot, () =>
    backupWorkspaceData(storeRoot, keep),
  );
  console.log(`Backup written to ${report.targetDir}`);
  for (const item of report.copied) console.log(`  + ${item.category}: ${item.files} file(s)`);
  if (pruned.length > 0) {
    console.log(`Pruned ${pruned.length} old backup(s) (kept ${keep})`);
  }
}

async function runPruneData(olderThanDays: number): Promise<void> {
  const storeRoot = resolveStoreRoot();
  if (!fs.existsSync(storeRoot)) {
    console.log(`No memory store found at ${storeRoot}; nothing to prune.`);
    return;
  }
  const report = await withStoreLock(storeRoot, () => pruneByRetention(storeRoot, olderThanDays));
  console.log(`Retention pruning (older than ${report.olderThanDays} day(s))`);
  console.log(`  trash entries removed: ${report.trashRemoved}`);
  console.log(`  essence history removed: ${report.historyRemoved}`);
  console.log(`  journal entries removed: ${report.journalRemoved}`);
  const wires = countHostWires(storeRoot);
  console.log(`host wires (never touched): ${wires.count}`);
}

async function runPurgeDerivedData(): Promise<void> {
  const storeRoot = resolveStoreRoot();
  if (!fs.existsSync(storeRoot)) {
    console.log(`No memory store found at ${storeRoot}; nothing to purge.`);
    return;
  }

  try {
    const report = await withStoreLock(storeRoot, () =>
      purgeDerivedData(storeRoot, { assumeLocked: true }),
    );
    console.log(`Purged derived data of workspace store: ${report.storeRoot}`);
    for (const item of report.removed) {
      console.log(`  - ${item.category}: ${item.removed} file(s) removed (${item.path})`);
    }
    console.log('');
    console.log('Kept (authoritative data):');
    for (const item of report.kept) {
      console.log(`  = ${item.category}: ${item.path}`);
    }
    console.log('');
    console.log(
      `Original session wires are owned by Kimi Code and were NOT touched: ${report.hostWireSessions} wire(s) remain for this workspace` +
        (report.hostWireRoot ? ` under ${report.hostWireRoot}` : '') +
        '.',
    );
  } catch (err) {
    if (err instanceof LockTimeoutError) printPurgeAborted();
    else throw err;
  }
}

function parseArgs(argv: string[]): SetupOptions {
  const options: SetupOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--undo':
        options.undo = true;
        break;
      case '--purge-backups':
        options.purgeBackups = true;
        break;
      case '--scope':
        options.scope = argv[++i] === 'workspace' ? 'workspace' : 'global';
        break;
      case '--kimi-code-home':
        options.kimiCodeHome = argv[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          printHelp();
          process.exit(1);
        }
        break;
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`kimi-code-memory-mcp-server setup

Integrates the MCP server with Kimi Code CLI by updating:
  - ~/.kimi-code/AGENTS.md (or AGENTS.md in the current directory with --scope workspace)
  - ~/.kimi-code/skills/memory-manage
  - ~/.kimi-code/mcp.json

Every change is backed up and recorded in an install manifest, so it can be
reverted with --undo. Conflicts with content this tool does not own are never
overwritten unless --force is given.

Options:
  --dry-run            Preview the plan without writing files
  --force              Overwrite conflicting skill / MCP entry (still backed up)
  --undo               Remove the configuration installed by this tool
  --purge-backups      Delete the backups created by previous installs
  --scope <s>          "global" (default) or "workspace": write the memory
                       protocol into the AGENTS.md of the current project
                       instead of the machine-wide Kimi Code home
  --kimi-code-home <p> Use a custom Kimi Code home directory

Workspace maintenance (current directory decides the store):
  --doctor             Dry-run migration report: what a migration would
                       change, without touching anything
  --export-data <dir>  Export authoritative data (memory, notes, essence,
                       themes, searches, index) to a directory
  --backup-data        Snapshot the same data into <store>/backups/<ts>
  --keep <n>           Backups kept after --backup-data (default 5)
  --prune-data         Delete trash / essence history / journal entries
  --older-than <days>  older than N days (default 30)
  --purge-derived-data Remove THIS tool's derived data of the current
                       workspace (themes, search views, refined SQLite,
                       essence history, trash, journal, dashboard runtime).
                       memory/, notes/, essence.md and index.json are kept;
                       the host-owned session wires are never touched.
  --help, -h           Show this help
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--doctor')) {
    runDoctor();
    return;
  }
  if (argv.includes('--purge-derived-data')) {
    await runPurgeDerivedData();
    return;
  }
  const exportIndex = argv.indexOf('--export-data');
  if (exportIndex >= 0) {
    const target = argv[exportIndex + 1];
    if (!target || target.startsWith('--')) {
      console.error('--export-data requires a target directory');
      process.exit(1);
    }
    await runExportData(target);
    return;
  }
  if (argv.includes('--backup-data')) {
    let keep = 5;
    const keepIndex = argv.indexOf('--keep');
    if (keepIndex >= 0 && /^\d+$/.test(argv[keepIndex + 1] ?? '')) {
      keep = Number(argv[keepIndex + 1]);
    }
    await runBackupData(keep);
    return;
  }
  if (argv.includes('--prune-data')) {
    let olderThanDays = 30;
    const olderIndex = argv.indexOf('--older-than');
    if (olderIndex >= 0 && /^\d+$/.test(argv[olderIndex + 1] ?? '')) {
      olderThanDays = Number(argv[olderIndex + 1]);
    }
    await runPruneData(olderThanDays);
    return;
  }

  const options = parseArgs(argv);

  try {
    const result = await runSetup(options);

    console.log(`Kimi Code home: ${result.kimiCodeHome}`);
    console.log(`AGENTS.md:      ${result.agentsMdPath}`);
    console.log(`Skill:          ${result.skillPath}`);
    console.log(`mcp.json:       ${result.mcpJsonPath}`);
    console.log(`Manifest:       ${result.manifestPath}`);
    console.log('');

    if (result.steps.length > 0) {
      console.log(result.dryRun ? 'Plan:' : 'Changes:');
      for (const step of result.steps) {
        console.log(`  [${step.action}] ${step.kind}: ${step.detail}`);
      }
      console.log('');
    }

    for (const action of result.actions) {
      console.log(`✓ ${action}`);
    }

    if (result.warnings.length > 0) {
      console.log('');
      console.log('Warnings:');
      for (const warning of result.warnings) {
        console.log(`⚠ ${warning}`);
      }
    }
  } catch (err) {
    if (err instanceof SetupConflictError) {
      console.error('Setup stopped: the following targets are not owned by this tool.');
      for (const conflict of err.conflicts) {
        console.error(`  - ${conflict.kind}: ${conflict.target}`);
        console.error(`    ${conflict.reason}`);
      }
      console.error('');
      console.error('Re-run with --force to overwrite them (the original content is backed up).');
      process.exit(1);
    }
    console.error('Setup failed:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Setup failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
