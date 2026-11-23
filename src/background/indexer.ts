/**
 * Background incremental indexer.
 *
 * Drains the refined lag in the background so the interactive search does
 * not have to refine the whole history inline: the queue is bounded (a
 * budget per tick), low priority (idle interval), cancellable on shutdown,
 * and fully observable through metrics (`refined_lag_turns` gauge,
 * `background_refined_turns` counter).
 *
 * Workspace scoping: the session list comes from the same discovery the
 * search uses (the caller injects it), so the indexer only ever refines
 * sessions that belong to the current workspace's store.
 */

import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { parseWireFile } from '../context/wire-context.js';
import { EXTRACTOR_VERSION, FRESHNESS_UNKNOWN } from '../refine/constants.js';
import { hashRawTurn, readWirePrefixHash, readWireTurnCount } from '../refine/freshness.js';
import { metrics } from '../utils/metrics.js';

export interface BackgroundIndexerOptions {
  /** Interval between ticks (default 60s). */
  intervalMs?: number;
  /** Maximum turns refined per tick (default 200). */
  budgetTurns?: number;
}

export interface SessionWire {
  sessionId: string;
  wire: string;
  /** Last modification time, when the provider already knows it. */
  mtime?: number;
}

export class BackgroundIndexer {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly budgetTurns: number;
  private readonly refinedRoot: string;
  private readonly listSessions: () => Array<SessionWire>;
  /** Hook that refines a batch of turns; injected to keep this module testable. */
  private readonly refineBatch: (session: SessionWire, budget: number, signal?: AbortSignal) => Promise<number>;

  constructor(
    refinedRoot: string,
    listSessions: () => Array<SessionWire>,
    refineBatch: (session: SessionWire, budget: number, signal?: AbortSignal) => Promise<number>,
    options: BackgroundIndexerOptions = {},
  ) {
    this.refinedRoot = refinedRoot;
    this.listSessions = listSessions;
    this.refineBatch = refineBatch;
    this.intervalMs = options.intervalMs ?? 60_000;
    this.budgetTurns = options.budgetTurns ?? 200;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runTick(), this.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Missing or stale turns for the 200 most recently active sessions. Valid
   * checkpoints and fresh rows avoid reparsing; other wires are parsed
   * asynchronously so a large file never becomes a synchronous whole-file read.
   */
  async measureLag(): Promise<number> {
    const wires = this.listSessions()
      .map((entry) => {
        let mtime = entry.mtime ?? 0;
        if (!mtime) {
          try {
            mtime = fs.statSync(entry.wire).mtimeMs;
          } catch {
            mtime = 0;
          }
        }
        return { ...entry, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 200);

    let lag = 0;
    let db: DatabaseSync | null = null;
    try {
      const dbPath = path.join(this.refinedRoot, 'refined.sqlite');
      if (fs.existsSync(dbPath)) db = new DatabaseSync(dbPath, { readOnly: true });
      const refinedStateStmt = db?.prepare(
        `SELECT turn_id, extractor_version, source_content_hash
           FROM refined_turns WHERE session_id = ?`,
      );
      const progressStmt = db?.prepare(
        `SELECT last_size, last_mtime_ns, wire_identity, extractor_version
           FROM refined_session_progress WHERE session_id = ?`,
      );
      progressStmt?.setReadBigInts(true);
      for (const { sessionId, wire } of wires) {
        try {
          const stats = fs.statSync(wire, { bigint: true });
          const progress = progressStmt?.get(sessionId) as
            | {
                last_size: bigint | null;
                last_mtime_ns: bigint | null;
                wire_identity: string | null;
                extractor_version: string | null;
              }
            | undefined;
          const states = (refinedStateStmt?.all(sessionId) ?? []) as Array<{
            turn_id: number;
            extractor_version: string | null;
            source_content_hash: string | null;
          }>;
          const checkpointCount =
            progress?.last_size === stats.size &&
            String(progress.last_mtime_ns) === String(stats.mtimeNs) &&
            progress.extractor_version === EXTRACTOR_VERSION &&
            readWirePrefixHash(progress.wire_identity) !== null
              ? readWireTurnCount(progress.wire_identity)
              : null;
          const allRowsFresh =
            checkpointCount === states.length &&
            states.every(
              (state) =>
                state.extractor_version === EXTRACTOR_VERSION &&
                state.source_content_hash !== null &&
                state.source_content_hash !== FRESHNESS_UNKNOWN,
            );
          if (checkpointCount !== null && allRowsFresh) continue;

          const { turns } = await parseWireFile(wire);
          const stateById = new Map(states.map((state) => [state.turn_id, state]));
          lag += turns.filter((turn) => {
            const state = stateById.get(parseInt(turn.turnId, 10));
            return (
              !state ||
              state.extractor_version !== EXTRACTOR_VERSION ||
              state.source_content_hash !== hashRawTurn(turn)
            );
          }).length;
        } catch {
          // A disappearing or unreadable session is retried on the next tick.
        }
      }
    } catch {
      // The refined store may not exist or may still be initializing.
    } finally {
      db?.close();
    }
    return lag;
  }

  /** One bounded drain tick. Safe to call concurrently; ticks serialize. */
  async runTick(signal?: AbortSignal): Promise<number> {
    if (this.running || signal?.aborted) return 0;
    this.running = true;
    let refined = 0;
    try {
      for (const session of this.listSessions()) {
        if (signal?.aborted || refined >= this.budgetTurns) break;
        try {
          refined += await this.refineBatch(session, this.budgetTurns - refined, signal);
        } catch {
          // One failing session must not stop the drain; the next tick retries.
          metrics.increment('background_index_errors');
        }
      }
      if (refined > 0) metrics.increment('background_refined_turns', refined);
      metrics.gauge('refined_lag_turns', await this.measureLag());
    } finally {
      this.running = false;
    }
    return refined;
  }
}
