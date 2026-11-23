/**
 * Workspace maintenance operations (CLI-only, always read-only or explicitly
 * invoked): doctor report, export, backup and retention pruning.
 *
 * The doctor report is the dry-run migration report required by the audit:
 * it lists what a migration WOULD change (missing ids, legacy references,
 * unknown freshness rows, journal leftovers, orphans) without touching
 * anything.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { safeParseFile } from './utils/file-helpers.js';
import { SearchViewRepository } from './search/search-view-repository.js';
import { WorkspaceJournal } from './utils/workspace-journal.js';
import { getSessionsRoot } from './config.js';
import { findAllWorkspaceSessions } from './context/wire-context.js';
import { isPathInside } from './utils/paths.js';

export interface DoctorReport {
  storeRoot: string;
  indexState: { state: string; lastError: string | null; lastSyncAt: string | null };
  memories: {
    total: number;
    missingId: number;
    missingRevision: number;
    missingSchemaVersion: number;
    corrupt: string[];
  };
  themes: { total: number; missingSchemaVersion: number; legacyPathRefs: number; orphanedRefs: number };
  searchViews: { total: number; legacy: number };
  refined: { schemaVersion: number | null; unknownFreshnessRows: number };
  journal: {
    unfinishedEntries: number;
    /** Corrupt journal files: reported with their file name and reason. */
    corruptEntries: Array<{ file: string; reason: string }>;
  };
  trash: { entries: number };
  essenceHistory: number;
  /** What a migration run WOULD do — the report itself changes nothing. */
  pendingActions: string[];
}

function walkMarkdown(root: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'history') continue;
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files;
}

export function doctorReport(
  storeRoot: string,
  getIndexState: () => { state: string; lastError: string | null; lastSyncAt: string | null },
): DoctorReport {
  const report: DoctorReport = {
    storeRoot,
    indexState: getIndexState(),
    memories: { total: 0, missingId: 0, missingRevision: 0, missingSchemaVersion: 0, corrupt: [] },
    themes: { total: 0, missingSchemaVersion: 0, legacyPathRefs: 0, orphanedRefs: 0 },
    searchViews: { total: 0, legacy: 0 },
    refined: { schemaVersion: null, unknownFreshnessRows: 0 },
    journal: { unfinishedEntries: 0, corruptEntries: [] },
    trash: { entries: 0 },
    essenceHistory: 0,
    pendingActions: [],
  };

  // Memories: identity and schema coverage.
  for (const folder of ['memory', 'notes']) {
    for (const filePath of walkMarkdown(path.join(storeRoot, folder))) {
      report.memories.total++;
      const parsed = safeParseFile(filePath);
      if (!parsed) {
        report.memories.corrupt.push(path.relative(storeRoot, filePath).replace(/\\/g, '/'));
        continue;
      }
      const fm = parsed.frontmatter;
      if (typeof fm.id !== 'string' || !fm.id) report.memories.missingId++;
      if (typeof fm.revision !== 'number') report.memories.missingRevision++;
      if (typeof fm.schemaVersion !== 'number') report.memories.missingSchemaVersion++;
    }
  }

  // Themes: schema version, legacy path-only references, orphans.
  const themesDir = path.join(storeRoot, 'themes');
  let themeFiles: string[] = [];
  try {
    themeFiles = fs
      .readdirSync(themesDir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.join(themesDir, name));
  } catch {
    themeFiles = [];
  }
  for (const themeFile of themeFiles) {
    report.themes.total++;
    let data: { schemaVersion?: unknown; memories?: Array<Record<string, unknown>> } | null = null;
    try {
      data = JSON.parse(fs.readFileSync(themeFile, 'utf8'));
    } catch {
      continue;
    }
    if (!data) continue;
    if (typeof data.schemaVersion !== 'number') report.themes.missingSchemaVersion++;
    for (const ref of data.memories ?? []) {
      if (typeof ref.memoryId !== 'string' || !ref.memoryId) report.themes.legacyPathRefs++;
      if (ref.status === 'orphaned' || ref.status === 'deleted') report.themes.orphanedRefs++;
    }
  }

  // Search views: legacy format count.
  const repository = new SearchViewRepository(storeRoot);
  const views = repository.listAll();
  report.searchViews.total = views.length;
  report.searchViews.legacy = views.filter((view) => view.legacy).length;

  // Refined store: schema version and unknown-freshness rows.
  try {
    const dbPath = path.join(storeRoot, 'refined', 'refined.sqlite');
    if (fs.existsSync(dbPath)) {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      const versionRow = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
      report.refined.schemaVersion = versionRow?.user_version ?? null;
      const staleRow = db
        .prepare("SELECT COUNT(*) AS c FROM refined_turns WHERE source_freshness = 'unknown'")
        .get() as { c: number } | undefined;
      report.refined.unknownFreshnessRows = staleRow?.c ?? 0;
      db.close();
    }
  } catch {
    // No store or unreadable: reported as-is.
  }

  // Journal leftovers, trash, essence history.
  const journal = new WorkspaceJournal(storeRoot);
  const { entries: journalEntries, corrupt: journalCorrupt } = journal.listDetailed();
  report.journal.unfinishedEntries = journalEntries.filter(
    (entry) => entry.state !== 'committed',
  ).length;
  report.journal.corruptEntries = journalCorrupt;
  const trashRoot = path.join(storeRoot, 'trash');
  if (fs.existsSync(trashRoot)) {
    const walk = (dir: string): number => {
      let count = 0;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) count += walk(path.join(dir, entry.name));
        else if (entry.isFile() && entry.name.endsWith('.md')) count++;
      }
      return count;
    };
    report.trash.entries = walk(trashRoot);
  }
  const historyDir = path.join(storeRoot, 'essence', 'history');
  if (fs.existsSync(historyDir)) {
    report.essenceHistory = fs.readdirSync(historyDir).filter((n) => n.endsWith('.md')).length;
  }

  // Pending actions a migration run would take.
  if (report.memories.missingId > 0) {
    report.pendingActions.push(`backfill stable ids for ${report.memories.missingId} memory file(s)`);
  }
  if (report.memories.missingSchemaVersion > 0) {
    report.pendingActions.push(`stamp schemaVersion on ${report.memories.missingSchemaVersion} memory file(s)`);
  }
  if (report.themes.legacyPathRefs > 0) {
    report.pendingActions.push(`upgrade ${report.themes.legacyPathRefs} legacy theme reference(s) to stable ids`);
  }
  if (report.themes.missingSchemaVersion > 0) {
    report.pendingActions.push(`stamp schemaVersion on ${report.themes.missingSchemaVersion} theme file(s)`);
  }
  if (report.searchViews.legacy > 0) {
    report.pendingActions.push(
      `${report.searchViews.legacy} legacy search view(s) remain readable; they are rewritten only when re-saved`,
    );
  }
  if (report.refined.unknownFreshnessRows > 0) {
    report.pendingActions.push(
      `${report.refined.unknownFreshnessRows} refined row(s) have unknown source freshness; they stay as refined-only fallback and never block raw scans`,
    );
  }
  if (report.journal.unfinishedEntries > 0) {
    report.pendingActions.push(
      `${report.journal.unfinishedEntries} unfinished journal entr(y/ies) would be reconciled on the next startup/sync`,
    );
  }
  if (report.memories.corrupt.length > 0) {
    report.pendingActions.push(
      `${report.memories.corrupt.length} corrupt file(s) need manual attention (reported, never silently dropped)`,
    );
  }
  if (report.journal.corruptEntries.length > 0) {
    report.pendingActions.push(
      `${report.journal.corruptEntries.length} corrupt journal file(s) need manual inspection ` +
        `(invalid JSON or unsupported schema — kept on disk, reported on every startup)`,
    );
  }

  return report;
}

export interface ExportReport {
  storeRoot: string;
  targetDir: string;
  copied: { category: string; files: number }[];
  skipped: string[];
}

function lstatOrUndefined(filePath: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(filePath);
  } catch {
    return undefined;
  }
}

function resolveRealPathWithMissing(filePath: string): string {
  const absolute = path.resolve(filePath);
  const missing: string[] = [];
  let current = absolute;
  while (!lstatOrUndefined(current)) {
    const parent = path.dirname(current);
    if (parent === current) return absolute;
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.resolve(fs.realpathSync.native(current), ...missing);
}

function assertDestinationNotLinked(targetDir: string): void {
  let current = path.resolve(targetDir);
  while (!lstatOrUndefined(current)) {
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
  if (lstatOrUndefined(current)?.isSymbolicLink()) {
    throw new Error(`Export destination must not contain symbolic links: ${targetDir}`);
  }
}

function copyTree(source: string, target: string, skipped: string[], relative: string): number {
  const sourceStats = lstatOrUndefined(source);
  if (!sourceStats) {
    fs.rmSync(target, { recursive: true, force: true });
    return 0;
  }
  if (sourceStats.isSymbolicLink()) {
    skipped.push(`${relative} (symbolic link not followed)`);
    fs.rmSync(target, { recursive: true, force: true });
    return 0;
  }
  if (!sourceStats.isDirectory()) {
    skipped.push(`${relative} (not a directory)`);
    fs.rmSync(target, { recursive: true, force: true });
    return 0;
  }
  const realSource = resolveRealPathWithMissing(source);
  const realTarget = resolveRealPathWithMissing(target);
  if (isPathInside(realSource, realTarget) || isPathInside(realTarget, realSource)) {
    throw new Error(`Export source and destination must not overlap: ${realSource} <-> ${realTarget}`);
  }
  const entries = fs.readdirSync(source, { withFileTypes: true });
  const sourceNames = new Set(entries.map((entry) => entry.name));
  if (lstatOrUndefined(target)?.isSymbolicLink()) fs.rmSync(target, { force: true });
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (!sourceNames.has(entry.name)) fs.rmSync(path.join(target, entry.name), { recursive: true, force: true });
  }

  let count = 0;
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const entryRelative = `${relative}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      skipped.push(`${entryRelative} (symbolic link not followed)`);
      fs.rmSync(to, { recursive: true, force: true });
      continue;
    }
    let targetStats: fs.Stats | undefined;
    try {
      targetStats = fs.lstatSync(to);
    } catch {
      targetStats = undefined;
    }
    if (targetStats) {
      const typeMismatch = entry.isDirectory() ? !targetStats.isDirectory() : !targetStats.isFile();
      if (targetStats.isSymbolicLink() || typeMismatch) fs.rmSync(to, { recursive: true, force: true });
    }
    if (entry.isDirectory()) {
      count += copyTree(from, to, skipped, entryRelative);
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to);
      count++;
    } else {
      skipped.push(`${entryRelative} (unsupported file type)`);
    }
  }
  return count;
}

/**
 * Export the authoritative + reference data (memory, notes, essence incl.
 * history, themes, searches, index). Derived caches (refined SQLite, runtime,
 * journal) and the trash are intentionally not exported.
 */
export function exportWorkspaceData(storeRoot: string, targetDir: string): ExportReport {
  if (path.resolve(storeRoot) === path.resolve(targetDir)) {
    throw new Error('Export destination must differ from the workspace store root');
  }
  assertDestinationNotLinked(targetDir);
  const report: ExportReport = { storeRoot, targetDir, copied: [], skipped: [] };
  report.copied.push({ category: 'memory', files: copyTree(path.join(storeRoot, 'memory'), path.join(targetDir, 'memory'), report.skipped, 'memory') });
  report.copied.push({ category: 'notes', files: copyTree(path.join(storeRoot, 'notes'), path.join(targetDir, 'notes'), report.skipped, 'notes') });
  report.copied.push({
    category: 'essence (incl. history)',
    files: copyTree(path.join(storeRoot, 'essence'), path.join(targetDir, 'essence'), report.skipped, 'essence'),
  });
  report.copied.push({ category: 'themes', files: copyTree(path.join(storeRoot, 'themes'), path.join(targetDir, 'themes'), report.skipped, 'themes') });
  report.copied.push({ category: 'searches', files: copyTree(path.join(storeRoot, 'searches'), path.join(targetDir, 'searches'), report.skipped, 'searches') });
  const indexFile = path.join(storeRoot, 'index.json');
  const indexTarget = path.join(targetDir, 'index.json');
  const indexStats = lstatOrUndefined(indexFile);
  if (indexStats?.isSymbolicLink()) {
    report.skipped.push('index.json (symbolic link not followed)');
    fs.rmSync(indexTarget, { recursive: true, force: true });
  } else if (indexStats?.isFile()) {
    fs.mkdirSync(targetDir, { recursive: true });
    if (lstatOrUndefined(indexTarget)) fs.rmSync(indexTarget, { recursive: true, force: true });
    fs.copyFileSync(indexFile, indexTarget);
    report.copied.push({ category: 'index', files: 1 });
  } else {
    fs.rmSync(indexTarget, { recursive: true, force: true });
  }
  for (const skipped of ['refined (rebuildable)', 'trash', 'runtime', '.journal', 'backups']) {
    report.skipped.push(skipped);
  }
  return report;
}

/**
 * Snapshot the workspace data into `<storeRoot>/backups/<timestamp>/` and
 * prune older snapshots beyond `keep`.
 */
export function backupWorkspaceData(storeRoot: string, keep = 5): { report: ExportReport; pruned: string[] } {
  const backupsRoot = path.join(storeRoot, 'backups');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetDir = path.join(backupsRoot, stamp);
  const report = exportWorkspaceData(storeRoot, targetDir);

  const pruned: string[] = [];
  let entries: string[] = [];
  try {
    entries = fs
      .readdirSync(backupsRoot)
      .filter((name) => fs.statSync(path.join(backupsRoot, name)).isDirectory())
      .sort();
  } catch {
    entries = [];
  }
  for (const stale of entries.slice(0, Math.max(0, entries.length - keep))) {
    fs.rmSync(path.join(backupsRoot, stale), { recursive: true, force: true });
    pruned.push(stale);
  }
  return { report, pruned };
}

export interface PruneReport {
  trashRemoved: number;
  historyRemoved: number;
  journalRemoved: number;
  olderThanDays: number;
}

/** Delete trash copies / essence history / journal leftovers older than N days. */
export function pruneByRetention(storeRoot: string, olderThanDays: number): PruneReport {
  const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
  const report: PruneReport = {
    trashRemoved: 0,
    historyRemoved: 0,
    journalRemoved: 0,
    olderThanDays,
  };

  // Trash: entries record deletedAt in their frontmatter.
  const trashRoot = path.join(storeRoot, 'trash');
  const walkTrash = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkTrash(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      const parsed = safeParseFile(full);
      const deletedAt = typeof parsed?.frontmatter.deletedAt === 'string' ? parsed.frontmatter.deletedAt : null;
      const time = deletedAt ? Date.parse(deletedAt) : fs.statSync(full).mtimeMs;
      if (Number.isFinite(time) && time < cutoff) {
        fs.rmSync(full, { force: true });
        report.trashRemoved++;
      }
    }
  };
  walkTrash(trashRoot);

  // Essence history: timestamp is part of the file name.
  const historyDir = path.join(storeRoot, 'essence', 'history');
  if (fs.existsSync(historyDir)) {
    for (const name of fs.readdirSync(historyDir)) {
      const full = path.join(historyDir, name);
      const time = fs.statSync(full).mtimeMs;
      if (time < cutoff) {
        fs.rmSync(full, { force: true });
        report.historyRemoved++;
      }
    }
  }

  // Journal: ONLY committed entries are droppable by age. Prepared entries
  // are the only recovery clue for an interrupted multi-storage write —
  // deleting them would lose that clue and the startup reconcile would
  // never run (review P2 #3). Failed entries are kept as diagnostics too.
  const journal = new WorkspaceJournal(storeRoot);
  for (const entry of journal.list()) {
    if (entry.state !== 'committed') continue;
    const time = Date.parse(entry.createdAt);
    if (Number.isFinite(time) && time < cutoff) {
      journal.remove(entry.operationId);
      report.journalRemoved++;
    }
  }
  return report;
}

/** Count the host-owned wires for the report (they are never touched). */
export function countHostWires(workspaceStoreRoot: string): { count: number; root: string | null } {
  try {
    const sessionsRoot = getSessionsRoot();
    const found = findAllWorkspaceSessions();
    void workspaceStoreRoot;
    return { count: found.length, root: sessionsRoot };
  } catch {
    return { count: 0, root: null };
  }
}
