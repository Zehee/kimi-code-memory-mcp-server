/**
 * Refined turn orchestrator.
 *
 * Delegates extraction, storage, and row mapping to focused modules under
 * src/refine/. This file keeps the original public API and owns cross-cutting
 * concerns such as the write mutex.
 */

import { Mutex } from './utils/mutex.js';
import { getRedactionPatterns, redactValue } from './utils/redaction.js';
import { metrics } from './utils/metrics.js';
import { RefinedStore } from './refine/store.js';
import { extract } from './refine/extractor.js';
import type {
  RawTurn,
  RefinedTurn,
  RefinedSearchOptions,
  RefinedSearchMatch,
  RefinedSearchOutcome,
  RefinedSessionProgress,
  RefinedTurnState,
} from './refine/types.js';

export {
  type RawAction,
  type RawTurn,
  type RefinedTurn,
  type RefinedSearchOptions,
  type RefinedSearchMatch,
  type RefinedSearchOutcome,
  type RefinedSessionProgress,
  type RefinedTurnSource,
  type RefinedTurnState,
  type RefinedCorruptRow,
} from './refine/types.js';

export { RefinedCorruptRowError, RefinedStoreBusyError } from './refine/store.js';

let warnedInvalidPatterns = false;

/**
 * How often a busy database is re-attempted before the error surfaces, and
 * the base of the retry backoff. `busy_timeout` absorbs short contention;
 * the retry covers bursts that outlive it (e.g. three writers committing
 * large transactions simultaneously).
 */
const BUSY_RETRY_ATTEMPTS = 2;
const BUSY_RETRY_BASE_MS = 40;

function sleepSync(ms: number): void {
  // Synchronous sleep that also works off the main thread.
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    /* fall back to a busy no-op: the next attempt is still worth making */
  }
}

function isBusyError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /database is locked|database table is locked|SQLITE_BUSY/i.test(message) ||
    (err instanceof Error && err.name === 'RefinedStoreBusyError');
}

export class RefinedManager {
  refinedRoot: string;
  private store: RefinedStore;
  private mutex: Mutex;

  constructor(refinedRoot: string) {
    this.refinedRoot = refinedRoot;
    this.store = new RefinedStore(refinedRoot);
    this.mutex = new Mutex();
  }

  refineTurn(turn: RawTurn, sessionId: string): RefinedTurn {
    const refined = extract(turn, sessionId);
    // Best-effort redaction of our derived copy (see utils/redaction.ts):
    // applied once, before anything reaches the refined store.
    const { patterns, invalid } = getRedactionPatterns();
    if (invalid.length > 0 && !warnedInvalidPatterns) {
      warnedInvalidPatterns = true;
      process.stderr.write(
        `[kimi-memory] ignoring ${invalid.length} invalid KIMI_MEMORY_REDACT_PATTERNS entr(y/ies)\n`,
      );
    }
    return redactValue(refined, patterns);
  }

  async saveRefinedTurns(sessionId: string, refinedTurns: RefinedTurn[]): Promise<void> {
    return this.withBusyRetry(() =>
      this.mutex.runExclusive(() => {
        this.store.saveRefinedTurns(sessionId, refinedTurns);
      }),
    );
  }

  loadRefinedTurns(sessionId: string): RefinedTurn[] {
    return this.store.loadRefinedTurns(sessionId);
  }

  listRefinedTurnIds(sessionId: string): number[] {
    return this.store.listRefinedTurnIds(sessionId);
  }

  listRefinedTurnStates(sessionId: string): RefinedTurnState[] {
    return this.store.listRefinedTurnStates(sessionId);
  }

  loadRefinedTurn(sessionId: string, turnId: number): RefinedTurn | undefined {
    return this.store.loadRefinedTurn(sessionId, turnId);
  }

  getDbPath(): string {
    return this.store.getDbPath();
  }

  getSchemaVersion(): number {
    return this.store.getSchemaVersion();
  }

  /**
   * Search refined turns.
   *
   * The `limit` is applied after ranking, never as a SQL truncation, so the
   * caller can merge these candidates with raw wire matches without losing
   * rows to an early cut-off.
   */
  searchRefinedTurns(options: RefinedSearchOptions): RefinedSearchMatch[] {
    return this.store.searchRefinedTurns(options);
  }

  searchRefinedTurnsDetailed(options: RefinedSearchOptions): RefinedSearchOutcome {
    return this.store.searchRefinedTurnsDetailed(options);
  }

  countAll(): number {
    return this.store.countAll();
  }

  listRecentTurns(limit: number): RefinedTurn[] {
    return this.store.listRecentTurns(limit);
  }

  async deleteRefinedTurns(refs: Array<{ sessionId: string; turnId: number }>): Promise<number> {
    return this.withBusyRetry(() =>
      this.mutex.runExclusive(() => this.store.deleteRefinedTurns(refs)),
    );
  }

  /**
   * Run `fn` and retry while the database reports SQLITE_BUSY.
   *
   * Each process already serializes its own writes through the mutex; this
   * loop handles CROSS-PROCESS contention that outlives `busy_timeout`
   * instead of surfacing a retryable error to callers that may not retry.
   */
  private async withBusyRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < BUSY_RETRY_ATTEMPTS; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!isBusyError(err)) throw err;
        lastError = err;
        metrics.increment('refined_busy_retry');
        sleepSync(BUSY_RETRY_BASE_MS * 2 ** attempt);
      }
    }
    metrics.increment('refined_busy_exhausted');
    throw lastError;
  }

  getSessionProgress(sessionId: string): RefinedSessionProgress | null {
    return this.store.getSessionProgress(sessionId);
  }

  async saveSessionProgress(progress: RefinedSessionProgress): Promise<void> {
    return this.withBusyRetry(() =>
      this.mutex.runExclusive(() => {
        this.store.saveSessionProgress(progress);
      }),
    );
  }

  close(): void {
    this.store.close();
  }
}
