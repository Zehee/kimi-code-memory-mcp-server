/**
 * SQLite storage for refined turns.
 *
 * Storage contract:
 *   - WAL journal mode + busy timeout so several MCP processes can share the
 *     database without failing fast with SQLITE_BUSY;
 *   - schema migrations driven by `PRAGMA user_version`;
 *   - `saveRefinedTurns` UPSERTs only the rows it is given (no read-modify-
 *     write of a whole session);
 *   - corrupted JSON columns raise an explicit error instead of degrading
 *     silently.
 *
 * Freshness columns and session progress support unchanged-wire shortcuts.
 * Rows deliberately record `unknown` source freshness unless proven otherwise.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import type {
  RefinedSearchOptions,
  RefinedSearchMatch,
  RefinedSearchOutcome,
  RefinedCorruptRow,
  RefinedSessionProgress,
  RefinedTurn,
  RefinedTurnState,
} from './types.js';
import { turnToRow, rowToTurn, RefinedCorruptRowError } from './adapter.js';
import {
  REFINED_MAX_SCAN_ROWS,
  REFINED_SCHEMA_VERSION,
  EXTRACTOR_VERSION,
  FRESHNESS_UNKNOWN,
  SQLITE_BUSY_TIMEOUT_MS,
} from './constants.js';
import { buildLikeConditions, hasAllTerms, likePattern, normalizeTerms, scoreText } from '../utils/search.js';
import { dateRangeSql } from '../utils/date.js';
import { metrics } from '../utils/metrics.js';

/** Raised when SQLite reports a lock conflict that a retry may resolve. */
export class RefinedStoreBusyError extends Error {
  readonly retryable = true;

  constructor(message: string) {
    super(message);
    this.name = 'RefinedStoreBusyError';
  }
}

const FRESHNESS_COLUMNS = [
  'extractor_version',
  'source_size',
  'source_mtime_ns',
  'source_content_hash',
  'refined_at',
  'source_freshness',
] as const;

export class RefinedStore {
  refinedRoot: string;
  private dbPath: string;
  private db: DatabaseSync;
  private closed = false;

  constructor(refinedRoot: string) {
    this.refinedRoot = refinedRoot;
    this.dbPath = path.join(refinedRoot, 'refined.sqlite');
    fs.mkdirSync(refinedRoot, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.configureConnection();
    this.initDb();
  }

  private configureConnection(): void {
    // WAL keeps readers running while another process writes. busy_timeout
    // makes lock waits bounded instead of failing immediately.
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
    } catch {
      // Some filesystems (network shares) refuse WAL; the database still works
      // in rollback-journal mode.
    }
    this.db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
  }

  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refined_turns (
        session_id TEXT NOT NULL,
        turn_id INTEGER NOT NULL,
        timestamp TEXT,
        summary TEXT,
        facts TEXT,
        notes TEXT,
        entities TEXT,
        categories TEXT,
        PRIMARY KEY (session_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_refined_session ON refined_turns(session_id);
      CREATE INDEX IF NOT EXISTS idx_refined_timestamp ON refined_turns(timestamp);
    `);

    this.migrate();

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refined_session_progress (
        session_id TEXT PRIMARY KEY,
        wire_identity TEXT,
        last_offset INTEGER NOT NULL DEFAULT 0,
        last_complete_line_offset INTEGER NOT NULL DEFAULT 0,
        last_size INTEGER,
        last_mtime_ns INTEGER,
        last_indexed_at TEXT,
        extractor_version TEXT
      );
    `);
  }

  private currentUserVersion(): number {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    return Number(row?.user_version ?? 0);
  }

  /**
   * Bring the database up to REFINED_SCHEMA_VERSION.
   *
   * Every step is idempotent and runs inside a transaction, so an interrupted
   * migration leaves the previous schema intact.
   */
  private migrate(): void {
    const version = this.currentUserVersion();
    if (version >= REFINED_SCHEMA_VERSION) return;

    this.runInTransaction(() => {
      const existing = this.tableColumns('refined_turns');
      for (const column of FRESHNESS_COLUMNS) {
        if (existing.includes(column)) continue;
        this.db.exec(`ALTER TABLE refined_turns ADD COLUMN ${column} TEXT`);
      }

      // Legacy rows have no known provenance: mark them unknown/stale so no
      // consumer can mistake them for freshly indexed data.
      this.db.exec(
        `UPDATE refined_turns
            SET extractor_version = COALESCE(extractor_version, '${FRESHNESS_UNKNOWN}'),
                source_content_hash = COALESCE(source_content_hash, '${FRESHNESS_UNKNOWN}'),
                source_freshness = COALESCE(source_freshness, '${FRESHNESS_UNKNOWN}')`,
      );

      this.db.exec(`PRAGMA user_version = ${REFINED_SCHEMA_VERSION};`);
    });
  }

  private tableColumns(table: string): string[] {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }

  getDbPath(): string {
    return this.dbPath;
  }

  getSchemaVersion(): number {
    return this.currentUserVersion();
  }

  /**
   * Read a PRAGMA value from the store connection (diagnostics / tests).
   */
  getPragma(name: string): unknown {
    const row = this.db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const values = Object.values(row);
    return values.length === 1 ? values[0] : row;
  }

  /** node:sqlite has no transaction() helper; wrap fn in BEGIN/COMMIT/ROLLBACK. */
  private runInTransaction<T>(fn: () => T): T {
    let began = false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      began = true;
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      if (began) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          // The transaction may already be rolled back by SQLite.
        }
      }
      throw this.normalizeError(err);
    }
  }

  private normalizeError(err: unknown): unknown {
    const message = err instanceof Error ? err.message : String(err);
    if (/SQLITE_BUSY|database is locked|database table is locked/i.test(message)) {
      metrics.increment('sqlite_busy');
      return new RefinedStoreBusyError(
        `Refined database is busy (retryable): ${message}`,
      );
    }
    return err;
  }

  /**
   * UPSERT the given turns. Only the supplied rows are written; rows that
   * already exist for the same (session, turn) are updated in place.
   */
  saveRefinedTurns(sessionId: string, refinedTurns: RefinedTurn[]): void {
    if (!Array.isArray(refinedTurns) || refinedTurns.length === 0) return;

    const insert = this.db.prepare(
      `INSERT INTO refined_turns
         (session_id, turn_id, timestamp, summary, facts, notes, entities, categories,
          extractor_version, source_size, source_mtime_ns, source_content_hash, refined_at, source_freshness)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, turn_id) DO UPDATE SET
         timestamp = excluded.timestamp,
         summary = excluded.summary,
         facts = excluded.facts,
         notes = excluded.notes,
         entities = excluded.entities,
         categories = excluded.categories,
         extractor_version = COALESCE(excluded.extractor_version, refined_turns.extractor_version),
         source_size = COALESCE(excluded.source_size, refined_turns.source_size),
         source_mtime_ns = COALESCE(excluded.source_mtime_ns, refined_turns.source_mtime_ns),
         source_content_hash = COALESCE(excluded.source_content_hash, refined_turns.source_content_hash),
         refined_at = COALESCE(excluded.refined_at, refined_turns.refined_at),
         source_freshness = COALESCE(excluded.source_freshness, refined_turns.source_freshness)`,
    );

    const refinedAt = new Date().toISOString();
    this.runInTransaction(() => {
      for (const turn of refinedTurns) {
        const row = turnToRow(turn);
        insert.run(
          row.session_id || sessionId,
          row.turn_id,
          row.timestamp,
          row.summary,
          row.facts,
          row.notes,
          row.entities,
          row.categories,
          EXTRACTOR_VERSION,
          row.source_size,
          row.source_mtime_ns,
          row.source_content_hash,
          refinedAt,
          row.source_freshness ?? FRESHNESS_UNKNOWN,
        );
      }
    });
  }

  loadRefinedTurns(sessionId: string): RefinedTurn[] {
    const stmt = this.db.prepare(
      'SELECT * FROM refined_turns WHERE session_id = ? ORDER BY turn_id',
    );
    const rows = stmt.all(sessionId) as Array<{
      session_id: string;
      turn_id: number;
      timestamp: string | null;
      summary: string;
      facts: string;
      notes: string;
      entities: string;
      categories: string;
    }>;
    return rows.map((r) => rowToTurn(r as Parameters<typeof rowToTurn>[0]));
  }

  listRefinedTurnIds(sessionId: string): number[] {
    const stmt = this.db.prepare('SELECT turn_id FROM refined_turns WHERE session_id = ?');
    const rows = stmt.all(sessionId) as Array<{ turn_id: number }>;
    return rows.map((row) => row.turn_id);
  }

  listRefinedTurnStates(sessionId: string): RefinedTurnState[] {
    const stmt = this.db.prepare(
      `SELECT turn_id, extractor_version, source_content_hash
         FROM refined_turns WHERE session_id = ?`,
    );
    const rows = stmt.all(sessionId) as Array<{
      turn_id: number;
      extractor_version: string | null;
      source_content_hash: string | null;
    }>;
    return rows.map((row) => ({
      turnId: row.turn_id,
      extractorVersion: row.extractor_version,
      sourceContentHash: row.source_content_hash,
    }));
  }

  loadRefinedTurn(sessionId: string, turnId: number): RefinedTurn | undefined {
    const stmt = this.db.prepare(
      'SELECT * FROM refined_turns WHERE session_id = ? AND turn_id = ?',
    );
    const row = stmt.get(sessionId, turnId) as
      | {
          session_id: string;
          turn_id: number;
          timestamp: string | null;
          summary: string;
          facts: string;
          notes: string;
          entities: string;
          categories: string;
        }
      | undefined;
    return row ? rowToTurn(row as Parameters<typeof rowToTurn>[0]) : undefined;
  }

  /**
   * Search the refined table.
   *
   * The SQL filter already implements AND semantics (one LIKE group per
   * term); the same AND rule is re-applied on the decoded row so the refined
   * path and the raw wire path agree on which turns match.
   */
  searchRefinedTurnsDetailed(options: RefinedSearchOptions): RefinedSearchOutcome {
    const rawQuery = typeof options.query === 'string' ? options.query.trim() : '';
    const terms = normalizeTerms(rawQuery);
    if (terms.length === 0) {
      return { matches: [], corruptRows: [], rowLimitReached: false, scannedRows: 0 };
    }

    const limit =
      typeof options.limit === 'number' && options.limit > 0
        ? Math.max(1, Math.floor(options.limit))
        : null;
    const maxRows =
      typeof options.maxRows === 'number' && options.maxRows > 0
        ? Math.max(1, Math.floor(options.maxRows))
        : REFINED_MAX_SCAN_ROWS;
    const dateFrom = options.dateFrom || null;
    const dateTo = options.dateTo || null;

    const conditions: string[] = buildLikeConditions(terms);
    const params: (string | number)[] = [];

    for (const term of terms) {
      const like = likePattern(term);
      params.push(like, like, like);
    }

    const dateRange = dateRangeSql(dateFrom || undefined, dateTo || undefined);
    if (dateRange.from) {
      conditions.push('timestamp >= ?');
      params.push(dateRange.from);
    }
    if (dateRange.to) {
      conditions.push('timestamp <= ?');
      params.push(dateRange.to);
    }

    // The row bound is a safety net, not a ranking limit: it is one order of
    // magnitude above any realistic page size so it never hides candidates
    // from the merge step.
    const sql = `SELECT session_id, turn_id, timestamp, summary, facts, notes
                 FROM refined_turns
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY timestamp DESC
                 LIMIT ?`;
    params.push(maxRows + 1);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      session_id: string;
      turn_id: number;
      timestamp: string | null;
      summary: string;
      facts: string;
      notes: string;
    }>;

    const rowLimitReached = rows.length > maxRows;
    const effectiveRows = rowLimitReached ? rows.slice(0, maxRows) : rows;

    const matches: RefinedSearchMatch[] = [];
    const corruptRows: RefinedCorruptRow[] = [];

    for (const row of effectiveRows) {
      const haystack = `${row.summary}\n${row.facts}\n${row.notes}`;
      if (!hasAllTerms(haystack, terms)) continue;
      const score = scoreText(haystack, terms);
      if (score === 0) continue;

      let facts: string[] = [];
      let notes: string[] = [];
      try {
        facts = JSON.parse(row.facts || '[]');
        notes = JSON.parse(row.notes || '[]');
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        corruptRows.push({
          sessionId: row.session_id,
          turnId: row.turn_id,
          column: 'facts/notes',
          reason,
        });
        continue;
      }

      matches.push({
        sessionId: row.session_id,
        turnId: row.turn_id,
        timestamp: row.timestamp ?? undefined,
        summary: row.summary,
        facts,
        notes,
        score,
        source: 'refined',
      });
    }

    matches.sort(compareRefinedMatches);

    return {
      matches: limit ? matches.slice(0, limit) : matches,
      corruptRows,
      rowLimitReached,
      scannedRows: effectiveRows.length,
    };
  }

  searchRefinedTurns(options: RefinedSearchOptions): RefinedSearchMatch[] {
    return this.searchRefinedTurnsDetailed(options).matches;
  }

  countAll(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM refined_turns').get() as { c: number };
    return row?.c ?? 0;
  }

  listRecentTurns(limit: number): RefinedTurn[] {
    const stmt = this.db.prepare(
      'SELECT * FROM refined_turns ORDER BY timestamp DESC LIMIT ?',
    );
    const rows = stmt.all(limit) as Array<{
      session_id: string;
      turn_id: number;
      timestamp: string | null;
      summary: string;
      facts: string;
      notes: string;
      entities: string;
      categories: string;
    }>;
    return rows.map((r) => rowToTurn(r as Parameters<typeof rowToTurn>[0]));
  }

  deleteRefinedTurns(refs: Array<{ sessionId: string; turnId: number }>): number {
    if (!Array.isArray(refs) || refs.length === 0) return 0;
    const deleteStmt = this.db.prepare('DELETE FROM refined_turns WHERE session_id = ? AND turn_id = ?');
    return this.runInTransaction(() => {
      let count = 0;
      for (const ref of refs) {
        const info = deleteStmt.run(ref.sessionId, ref.turnId);
        count += Number(info.changes);
      }
      return count;
    });
  }

  /* ------------------------------------------------------------------ */
  /* Session index progress                                              */
  /* ------------------------------------------------------------------ */

  getSessionProgress(sessionId: string): RefinedSessionProgress | null {
    const stmt = this.db.prepare(
      'SELECT * FROM refined_session_progress WHERE session_id = ?',
    );
    stmt.setReadBigInts(true);
    const row = stmt.get(sessionId) as
      | {
          session_id: string;
          wire_identity: string | null;
          last_offset: number | bigint;
          last_complete_line_offset: number | bigint;
          last_size: number | bigint | null;
          last_mtime_ns: number | bigint | null;
          last_indexed_at: string | null;
          extractor_version: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      wireIdentity: row.wire_identity,
      lastOffset: Number(row.last_offset ?? 0),
      lastCompleteLineOffset: Number(row.last_complete_line_offset ?? 0),
      lastSize: row.last_size === null ? null : Number(row.last_size),
      lastMtimeNs: row.last_mtime_ns === null ? null : String(row.last_mtime_ns),
      lastIndexedAt: row.last_indexed_at ?? null,
      extractorVersion: row.extractor_version ?? null,
    };
  }

  /**
   * Record indexing progress for a session.
   *
   * Size/mtime bookkeeping lets the background indexer skip unchanged wires.
   * The complete-line offset covers append-only batches whose raw prefix hash
   * matches; all other changes fall back to a full snapshot before checkpointing.
   */
  saveSessionProgress(progress: RefinedSessionProgress): void {
    const stmt = this.db.prepare(
      `INSERT INTO refined_session_progress
         (session_id, wire_identity, last_offset, last_complete_line_offset, last_size,
          last_mtime_ns, last_indexed_at, extractor_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         wire_identity = excluded.wire_identity,
         last_offset = excluded.last_offset,
         last_complete_line_offset = excluded.last_complete_line_offset,
         last_size = excluded.last_size,
         last_mtime_ns = excluded.last_mtime_ns,
         last_indexed_at = excluded.last_indexed_at,
         extractor_version = excluded.extractor_version`,
    );
    this.runInTransaction(() => {
      stmt.run(
        progress.sessionId,
        progress.wireIdentity ?? null,
        Math.max(0, Math.floor(progress.lastOffset ?? 0)),
        Math.max(0, Math.floor(progress.lastCompleteLineOffset ?? 0)),
        progress.lastSize ?? null,
        progress.lastMtimeNs ?? null,
        progress.lastIndexedAt ?? null,
        progress.extractorVersion ?? null,
      );
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}

function compareRefinedMatches(a: RefinedSearchMatch, b: RefinedSearchMatch): number {
  if (b.score !== a.score) return b.score - a.score;
  const at = a.timestamp ? Date.parse(a.timestamp) : 0;
  const bt = b.timestamp ? Date.parse(b.timestamp) : 0;
  if (bt !== at) return bt - at;
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  return a.turnId - b.turnId;
}

export { RefinedCorruptRowError };
