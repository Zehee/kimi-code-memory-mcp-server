/**
 * Domain types for the turn refinement layer.
 */

export interface RawAction {
  name?: string;
  args?: unknown;
  result?: unknown;
}

export interface RawTurn {
  turnId?: string | number;
  timestamp?: string;
  user?: string;
  agentText?: string;
  agent?: string;
  actions?: RawAction[];
}

export interface RefinedTurnSource {
  size: number;
  mtimeNs: string;
  contentHash: string;
}

export interface RefinedTurn {
  sessionId: string;
  turnId: number;
  timestamp: string | undefined;
  summary: string;
  facts: string[];
  notes: string[];
  entities: {
    files: string[];
    tools: string[];
    errors: string[];
  };
  categories: Record<string, string[]>;
  source?: RefinedTurnSource;
}

export interface RefinedTurnState {
  turnId: number;
  extractorVersion: string | null;
  sourceContentHash: string | null;
}

export interface RefinedSearchOptions {
  query: string;
  dateFrom?: string;
  dateTo?: string;
  /**
   * Maximum number of matches to return. The limit is applied *after*
   * candidate filtering and ranking, never as a SQL truncation, so a small
   * limit can never hide additional candidates from the caller.
   */
  limit?: number;
  /**
   * Safety bound on the number of rows pulled out of SQLite in one query.
   * When the bound is hit the outcome is flagged as incomplete.
   */
  maxRows?: number;
}

export interface RefinedSearchMatch {
  sessionId: string;
  turnId: number;
  timestamp: string | undefined;
  summary: string;
  facts: string[];
  notes: string[];
  score: number;
  /** Always 'refined' today; kept explicit so merged results can be labelled. */
  source?: 'refined';
}

/** A row whose JSON column could not be parsed. */
export interface RefinedCorruptRow {
  sessionId: string;
  turnId: number;
  column: string;
  reason: string;
}

export interface RefinedSearchOutcome {
  matches: RefinedSearchMatch[];
  corruptRows: RefinedCorruptRow[];
  /** True when the row safety bound was reached and candidates may be missing. */
  rowLimitReached: boolean;
  /** Number of rows inspected by the query. */
  scannedRows: number;
}

/** Freshness of the source a refined row was derived from. */
export type RefinedSourceFreshness = 'unknown' | 'stale' | 'fresh';

/**
 * Per-session indexing progress.
 *
 * Size and mtime support unchanged-wire shortcuts. Complete-line offsets allow
 * append-only batches after a raw-prefix hash check; any other change reparses a full snapshot.
 */
export interface RefinedSessionProgress {
  sessionId: string;
  wireIdentity: string | null;
  lastOffset: number;
  lastCompleteLineOffset: number;
  lastSize: number | null;
  lastMtimeNs: string | null;
  lastIndexedAt: string | null;
  extractorVersion: string | null;
}

/** SQLite row shape for refined_turns. */
export interface RefinedRow {
  session_id: string;
  turn_id: number;
  timestamp: string | null;
  summary: string;
  facts: string;
  notes: string;
  entities: string;
  categories: string;
  extractor_version: string | null;
  source_size: number | null;
  source_mtime_ns: string | number | null;
  source_content_hash: string | null;
  refined_at: string | null;
  source_freshness: string | null;
}
