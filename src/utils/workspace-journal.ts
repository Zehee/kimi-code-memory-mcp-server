/**
 * Workspace write journal.
 *
 * Cross-storage writes (Markdown file + index + theme associations) cannot be
 * made atomic with the primitives available here. The journal closes the gap:
 * every multi-step write records a `prepared` entry before its first mutation
 * and a `committed` entry after its last one. A crash between the two leaves
 * a `prepared` entry behind, which the next startup turns into an explicit
 * reconciliation (the Markdown file is the source of truth, index and themes
 * are rebuilt from it) and a visible report — data is never silently lost.
 *
 * Entries live in `<storeRoot>/.journal/` (dot-prefixed, so directory scans
 * ignore it) and are written atomically.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { atomicWriteFile } from './paths.js';
import { metrics } from './metrics.js';

export const JOURNAL_SCHEMA_VERSION = 1;

export type JournalOp = 'remember' | 'move' | 'delete' | 'restore' | 'essence';

export type JournalState = 'prepared' | 'committed' | 'failed';

export interface JournalEntry {
  schemaVersion: number;
  operationId: string;
  op: JournalOp;
  state: JournalState;
  /** Store-relative primary path of the operation (target of the write). */
  targetPath?: string;
  /** Store-relative source path for move/restore operations. */
  sourcePath?: string;
  /** Trash copy path for delete/restore operations. */
  trashPath?: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export interface JournalRecoveryItem {
  operationId: string;
  op: JournalOp;
  state: JournalState;
  targetPath?: string;
  createdAt: string;
  error?: string;
}

export interface JournalRecoveryResult {
  /** Entries that were found unfinished and reconciled. */
  recovered: JournalRecoveryItem[];
  /** Entries that were committed but not yet cleaned up. */
  confirmed: JournalRecoveryItem[];
  /** Entries that could not be processed (reported, never swallowed). */
  failed: Array<JournalRecoveryItem & { reason: string }>;
  /**
   * Corrupt entries (invalid JSON, unknown schema/state). They are reported
   * and LEFT ON DISK — the file may still be repairable by a human and must
   * not look like "there was no journal" (review P2 #4).
   */
  corrupt: Array<{ file: string; reason: string }>;
}

function readEntry(filePath: string): { entry: JournalEntry } | { corrupt: string } | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { corrupt: 'invalid JSON' };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { corrupt: 'payload is not a JSON object' };
  }
  const record = parsed as Partial<JournalEntry>;
  if (record.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    return {
      corrupt: `unsupported schemaVersion ${JSON.stringify(record.schemaVersion)} (expected ${JOURNAL_SCHEMA_VERSION})`,
    };
  }
  if (typeof record.operationId !== 'string' || !record.operationId) {
    return { corrupt: 'missing operationId' };
  }
  if (typeof record.op !== 'string') {
    return { corrupt: 'missing op' };
  }
  if (record.state !== 'prepared' && record.state !== 'committed' && record.state !== 'failed') {
    return { corrupt: `unknown state ${JSON.stringify(record.state)}` };
  }
  return {
    entry: {
      schemaVersion: record.schemaVersion,
      operationId: record.operationId,
      op: record.op as JournalOp,
      state: record.state,
      targetPath: typeof record.targetPath === 'string' ? record.targetPath : undefined,
      sourcePath: typeof record.sourcePath === 'string' ? record.sourcePath : undefined,
      trashPath: typeof record.trashPath === 'string' ? record.trashPath : undefined,
      createdAt: typeof record.createdAt === 'string' ? record.createdAt : '',
      updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : '',
      error: typeof record.error === 'string' ? record.error : undefined,
    },
  };
}

function toItem(entry: JournalEntry): JournalRecoveryItem {
  return {
    operationId: entry.operationId,
    op: entry.op,
    state: entry.state,
    targetPath: entry.targetPath,
    createdAt: entry.createdAt,
    error: entry.error,
  };
}

function metricsIncrementCorrupt(count: number): void {
  if (count > 0) metrics.increment('journal_corrupt_entries', count);
}

export class WorkspaceJournal {
  readonly storeRoot: string;
  readonly dir: string;

  constructor(storeRoot: string) {
    this.storeRoot = storeRoot;
    this.dir = path.join(storeRoot, '.journal');
  }

  private entryPath(operationId: string): string {
    const safe = operationId.replace(/[^A-Za-z0-9_-]/g, '_');
    return path.join(this.dir, `${safe}.json`);
  }

  /**
   * Record that an operation is about to start. Must be called before the
   * first mutation, while the caller holds the workspace lock.
   */
  prepare(op: JournalOp, paths: { targetPath?: string; sourcePath?: string; trashPath?: string } = {}): JournalEntry {
    const now = new Date().toISOString();
    const entry: JournalEntry = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      operationId: `${op}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
      op,
      state: 'prepared',
      targetPath: paths.targetPath,
      sourcePath: paths.sourcePath,
      trashPath: paths.trashPath,
      createdAt: now,
      updatedAt: now,
    };
    fs.mkdirSync(this.dir, { recursive: true });
    atomicWriteFile(this.entryPath(entry.operationId), JSON.stringify(entry, null, 2), 'utf8');
    return entry;
  }

  /** Mark the operation as fully applied. */
  commit(operationId: string): void {
    const read = readEntry(this.entryPath(operationId));
    if (!read || !('entry' in read)) return;
    const entry = read.entry;
    entry.state = 'committed';
    entry.updatedAt = new Date().toISOString();
    atomicWriteFile(this.entryPath(operationId), JSON.stringify(entry, null, 2), 'utf8');
  }

  /** Record that the operation failed. */
  fail(operationId: string, error: string): void {
    const read = readEntry(this.entryPath(operationId));
    if (!read || !('entry' in read)) return;
    const entry = read.entry;
    entry.state = 'failed';
    entry.error = error;
    entry.updatedAt = new Date().toISOString();
    atomicWriteFile(this.entryPath(operationId), JSON.stringify(entry, null, 2), 'utf8');
  }

  /**
   * List every valid journal entry, oldest first. Corrupt entries are
   * reported separately via `listCorrupt`.
   */
  list(): JournalEntry[] {
    const { entries } = this.listDetailed();
    return entries;
  }

  /**
   * Valid entries plus the corrupt files that were skipped. The corrupt
   * list must be surfaced by every recovery/report path — a corrupt entry
   * must never look like "there was no journal" (review P2 #4).
   */
  listDetailed(): { entries: JournalEntry[]; corrupt: Array<{ file: string; reason: string }> } {
    let names: string[] = [];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.json'));
    } catch {
      return { entries: [], corrupt: [] };
    }
    const entries: JournalEntry[] = [];
    const corrupt: Array<{ file: string; reason: string }> = [];
    for (const name of names) {
      const read = readEntry(path.join(this.dir, name));
      if (read && 'entry' in read) entries.push(read.entry);
      else if (read && 'corrupt' in read) corrupt.push({ file: name, reason: read.corrupt });
    }
    entries.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return { entries, corrupt };
  }

  /**
   * Recover the journal after a crash or an unclean shutdown.
   *
   * `reconcile` rebuilds the derived stores (index, theme references) from
   * the Markdown authority; it runs once, no matter how many entries need it.
   *
   * The callback may return an outcome object; a `synced: false` result is
   * treated as a FAILED reconciliation: the entries stay on disk (they are
   * the only recovery clue) and are reported as failed instead of being
   * dropped as if recovery had succeeded (review P2, round 6 #2).
   *
   * Committed entries are dropped, prepared/failed entries are reported and
   * dropped after a successful reconciliation.
   */
  async recover(reconcile?: () => Promise<unknown> | unknown): Promise<JournalRecoveryResult> {
    const { entries, corrupt } = this.listDetailed();
    const result: JournalRecoveryResult = {
      recovered: [],
      confirmed: [],
      failed: [],
      corrupt: corrupt.map((entry) => ({ ...entry })),
    };
    metricsIncrementCorrupt(corrupt.length);

    // The reconcile callback ALWAYS runs once — even with an empty journal —
    // because callers use recover() as their repair pass (startup, sync): it
    // must never be skipped just because there is nothing to recover.
    let reconcileError: string | null = null;
    if (reconcile) {
      try {
        const outcome = await reconcile();
        // A reconcile that reports `synced: false` did NOT fully restore the
        // derived stores (e.g. duplicate ids, corrupt files): treat it as a
        // failure and keep every entry — they are the only recovery clue
        // (review P2, round 6 #2).
        if (
          outcome &&
          typeof outcome === 'object' &&
          (outcome as { synced?: unknown }).synced === false
        ) {
          reconcileError =
            'index reconcile reported failures (synced: false) — entries kept for retry';
        }
      } catch (err) {
        reconcileError = err instanceof Error ? err.message : String(err);
      }
    }

    for (const entry of entries) {
      const item = toItem(entry);
      try {
        if (entry.state === 'committed') {
          // Fully applied: the entry only records that the cleanup never ran.
          result.confirmed.push(item);
          this.remove(entry.operationId);
          continue;
        }
        if (reconcileError) {
          // The reconcile could not fully restore the derived stores: keep
          // the entry on disk — it is the only recovery clue.
          result.failed.push({ ...item, reason: reconcileError });
          continue;
        }
        // Prepared / failed entries: the Markdown authority was reconciled
        // successfully, so the interrupted write is resolved and the entry
        // can be dropped.
        result.recovered.push(item);
        this.remove(entry.operationId);
      } catch (err) {
        result.failed.push({
          ...item,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /** Remove a journal entry. */
  remove(operationId: string): void {
    try {
      fs.unlinkSync(this.entryPath(operationId));
    } catch {
      // Already gone.
    }
  }
}

/**
 * Run a multi-storage write under the journal: `prepared` before the first
 * mutation, `committed` after the last one, `failed` (or dropped for benign
 * rejections) on error.
 *
 * This is the single journaling entry point shared by the MCP tools and the
 * HTTP API so the two surfaces cannot drift apart. Callers that reject a
 * write before any mutation (e.g. an optimistic-concurrency conflict) mark
 * the failure as benign via `benign` and the entry is dropped.
 */
export async function runJournaled<T>(
  journal: WorkspaceJournal,
  op: JournalOp,
  paths: { targetPath?: string; sourcePath?: string; trashPath?: string },
  fn: () => Promise<T>,
  options: {
    /** Benign rejections happen before any mutation: drop the entry. */
    benign?: (err: unknown) => boolean;
    /** Results that mean "nothing was mutated": drop the entry. */
    dropResult?: (result: T) => boolean;
    /**
     * Keys stripped from the returned result object. Lets handlers use
     * internal markers (e.g. `notFound`) for the drop decision without
     * leaking journal plumbing into the public response.
     */
    strip?: string[];
  } = {},
): Promise<T> {
  const entry = journal.prepare(op, paths);
  try {
    const result = await fn();
    if (options.dropResult?.(result)) {
      journal.remove(entry.operationId);
    } else {
      journal.commit(entry.operationId);
    }
    if (options.strip && result && typeof result === 'object') {
      const cleaned = { ...(result as Record<string, unknown>) };
      for (const key of options.strip) delete cleaned[key];
      return cleaned as T;
    }
    return result;
  } catch (err) {
    if (options.benign?.(err)) {
      journal.remove(entry.operationId);
    } else {
      journal.fail(entry.operationId, err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}
