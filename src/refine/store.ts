/**
 * SQLite storage for refined turns.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { RefinedSearchOptions, RefinedSearchMatch, RefinedTurn } from './types.js';
import { turnToRow } from './adapter.js';
import { rowToTurn } from './adapter.js';
import { LIMITS } from './constants.js';
import { buildLikeConditions, scoreText } from '../utils/search.js';
import { dateRangeSql } from '../utils/date.js';

export class RefinedStore {
  refinedRoot: string;
  private dbPath: string;
  private db: Database.Database;

  constructor(refinedRoot: string) {
    this.refinedRoot = refinedRoot;
    this.dbPath = path.join(refinedRoot, 'refined.sqlite');
    fs.mkdirSync(refinedRoot, { recursive: true });
    this.db = new Database(this.dbPath);
    this.initDb();
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
  }

  getDbPath(): string {
    return this.dbPath;
  }

  saveRefinedTurns(sessionId: string, refinedTurns: RefinedTurn[]): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO refined_turns
       (session_id, turn_id, timestamp, summary, facts, notes, entities, categories)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const existing = this.loadRefinedTurns(sessionId);
    const merged = new Map(existing.map((t) => [t.turnId, t]));
    for (const turn of refinedTurns) {
      merged.set(turn.turnId, turn);
    }

    const transaction = this.db.transaction(() => {
      for (const turn of merged.values()) {
        const row = turnToRow(turn);
        insert.run(
          row.session_id,
          row.turn_id,
          row.timestamp,
          row.summary,
          row.facts,
          row.notes,
          row.entities,
          row.categories,
        );
      }
    });
    transaction();
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
    return rows.map((r) => rowToTurn(r));
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
    return row ? rowToTurn(row) : undefined;
  }

  searchRefinedTurns(options: RefinedSearchOptions): RefinedSearchMatch[] {
    const rawQuery = typeof options.query === 'string' ? options.query.trim() : '';
    if (!rawQuery) return [];

    const terms = rawQuery
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0);
    if (terms.length === 0) return [];

    const limit =
      typeof options.limit === 'number' ? Math.max(1, Math.floor(options.limit)) : LIMITS.searchResultLimit;
    const dateFrom = options.dateFrom || null;
    const dateTo = options.dateTo || null;

    const conditions: string[] = buildLikeConditions(terms);
    const params: (string | number)[] = [];

    for (const term of terms) {
      const escaped = term.split('%').join('\\%').split('_').join('\\_');
      const like = `%${escaped}%`;
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

    const sql = `SELECT session_id, turn_id, timestamp, summary, facts, notes
                 FROM refined_turns
                 WHERE ${conditions.join(' AND ')}
                 ORDER BY timestamp DESC
                 LIMIT ?`;
    params.push(limit * LIMITS.searchCandidateMultiplier);

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<{
      session_id: string;
      turn_id: number;
      timestamp: string | null;
      summary: string;
      facts: string;
      notes: string;
    }>;

    const matches: RefinedSearchMatch[] = [];
    for (const row of rows) {
      const haystack = `${row.summary}\n${row.facts}\n${row.notes}`;
      const score = scoreText(haystack, terms);
      if (score === 0) continue;

      matches.push({
        sessionId: row.session_id,
        turnId: row.turn_id,
        timestamp: row.timestamp ?? undefined,
        summary: row.summary,
        facts: JSON.parse(row.facts || '[]'),
        notes: JSON.parse(row.notes || '[]'),
        score,
      });
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, limit);
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
    return rows.map((r) => rowToTurn(r));
  }

  close(): void {
    this.db.close();
  }
}
