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
}

export interface RefinedSearchOptions {
  query: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: number;
}

export interface RefinedSearchMatch {
  sessionId: string;
  turnId: number;
  timestamp: string | undefined;
  summary: string;
  facts: string[];
  notes: string[];
  score: number;
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
}
