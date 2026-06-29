/**
 * Row <-> domain mapping for refined turns.
 */

import type { RefinedRow, RefinedTurn } from './types.js';

export function rowToTurn(row: RefinedRow): RefinedTurn {
  return {
    sessionId: row.session_id,
    turnId: row.turn_id,
    timestamp: row.timestamp ?? undefined,
    summary: row.summary,
    facts: JSON.parse(row.facts || '[]'),
    notes: JSON.parse(row.notes || '[]'),
    entities: JSON.parse(row.entities || '{"files":[],"tools":[],"errors":[]}'),
    categories: JSON.parse(row.categories || '{}'),
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
  };
}
