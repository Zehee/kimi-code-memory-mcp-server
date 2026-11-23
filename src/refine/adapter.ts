/**
 * Row <-> domain mapping for refined turns.
 *
 * JSON columns are validated while decoding: a corrupted column raises an
 * explicit error instead of silently turning into an empty array.
 */

import type { RefinedRow, RefinedTurn } from './types.js';

/** Raised when a stored JSON column cannot be decoded. */
export class RefinedCorruptRowError extends Error {
  readonly sessionId: string;
  readonly turnId: number;
  readonly column: string;

  constructor(sessionId: string, turnId: number, column: string, reason: string) {
    super(
      `Corrupted refined row ${sessionId}:${turnId} — column "${column}" is not valid JSON: ${reason}`,
    );
    this.name = 'RefinedCorruptRowError';
    this.sessionId = sessionId;
    this.turnId = turnId;
    this.column = column;
  }
}

function parseJsonColumn<T>(
  raw: string | null,
  fallback: T,
  sessionId: string,
  turnId: number,
  column: string,
): T {
  const text = raw ?? '';
  if (!text.trim()) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new RefinedCorruptRowError(sessionId, turnId, column, reason);
  }
}

export function rowToTurn(row: RefinedRow): RefinedTurn {
  return {
    sessionId: row.session_id,
    turnId: row.turn_id,
    timestamp: row.timestamp ?? undefined,
    summary: row.summary ?? '',
    facts: parseJsonColumn<string[]>(row.facts, [], row.session_id, row.turn_id, 'facts'),
    notes: parseJsonColumn<string[]>(row.notes, [], row.session_id, row.turn_id, 'notes'),
    entities: parseJsonColumn(
      row.entities,
      { files: [], tools: [], errors: [] },
      row.session_id,
      row.turn_id,
      'entities',
    ),
    categories: parseJsonColumn(
      row.categories,
      {},
      row.session_id,
      row.turn_id,
      'categories',
    ),
  };
}

export function turnToRow(turn: RefinedTurn): RefinedRow {
  return {
    session_id: turn.sessionId,
    turn_id: turn.turnId,
    timestamp: turn.timestamp ?? null,
    summary: turn.summary,
    facts: JSON.stringify(turn.facts),
    notes: JSON.stringify(turn.notes),
    entities: JSON.stringify(turn.entities),
    categories: JSON.stringify(turn.categories),
    extractor_version: null,
    source_size: turn.source?.size ?? null,
    source_mtime_ns: turn.source?.mtimeNs ?? null,
    source_content_hash: turn.source?.contentHash ?? null,
    refined_at: null,
    source_freshness: turn.source ? 'fresh' : null,
  };
}
