/**
 * Refined turn orchestrator.
 *
 * Delegates extraction, storage, and row mapping to focused modules under
 * src/refine/. This file keeps the original public API and owns cross-cutting
 * concerns such as the write mutex.
 */

import { Mutex } from './utils/mutex.js';
import { RefinedStore } from './refine/store.js';
import { extract } from './refine/extractor.js';
import type {
  RawTurn,
  RefinedTurn,
  RefinedSearchOptions,
  RefinedSearchMatch,
} from './refine/types.js';

export {
  type RawAction,
  type RawTurn,
  type RefinedTurn,
  type RefinedSearchOptions,
  type RefinedSearchMatch,
} from './refine/types.js';

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
    return extract(turn, sessionId);
  }

  async saveRefinedTurns(sessionId: string, refinedTurns: RefinedTurn[]): Promise<void> {
    return this.mutex.runExclusive(() => {
      this.store.saveRefinedTurns(sessionId, refinedTurns);
    });
  }

  loadRefinedTurns(sessionId: string): RefinedTurn[] {
    return this.store.loadRefinedTurns(sessionId);
  }

  loadRefinedTurn(sessionId: string, turnId: number): RefinedTurn | undefined {
    return this.store.loadRefinedTurn(sessionId, turnId);
  }

  getDbPath(): string {
    return this.store.getDbPath();
  }

  searchRefinedTurns(options: RefinedSearchOptions): RefinedSearchMatch[] {
    return this.store.searchRefinedTurns(options);
  }

  close(): void {
    this.store.close();
  }
}
