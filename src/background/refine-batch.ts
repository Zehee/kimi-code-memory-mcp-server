/**
 * Incremental refinement of one session, bounded by a turn budget.
 *
 * Rows are refreshed when their source turn or extractor version changes.
 * Orphaned rows are removed only after a complete, stable snapshot was parsed.
 */

import fs from 'node:fs';
import { parseWireFile, type WireSession, type WireTurn } from '../context/wire-context.js';
import { EXTRACTOR_VERSION, FRESHNESS_UNKNOWN } from '../refine/constants.js';
import {
  buildWireIdentity,
  buildWireIdentityFromHashes,
  hashRawTurn,
  hashWireFilePrefix,
  readWirePrefixHash,
  readWireTurnCount,
  withWirePrefixHash,
} from '../refine/freshness.js';
import type { RefinedTurn } from '../refine/types.js';
import type { Ctx } from '../types.js';

export interface WireSourceStamp {
  size: number;
  mtimeNs: string;
}

export function refineWireTurn(
  manager: Ctx['refinedManager'],
  turn: WireTurn,
  sessionId: string,
  source: WireSourceStamp,
): RefinedTurn {
  const refined = manager.refineTurn({ ...turn, timestamp: turn.timestamp || undefined }, sessionId);
  return {
    ...refined,
    source: { ...source, contentHash: hashRawTurn(turn) },
  };
}

function isStableSnapshot(session: WireSession, source: WireSourceStamp): boolean {
  try {
    const stats = fs.statSync(session.wire, { bigint: true });
    return Number(stats.size) === source.size && stats.mtimeNs.toString() === source.mtimeNs;
  } catch {
    return false;
  }
}

async function findCompleteLineOffset(filePath: string, size: number): Promise<number> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - 64 * 1024);
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      const newline = buffer.lastIndexOf(0x0a);
      if (newline >= 0) return start + newline + 1;
      end = start;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

export async function refineSessionBatch(
  ctx: Pick<Ctx, 'refinedManager'>,
  session: WireSession,
  budget: number,
  signal?: AbortSignal,
): Promise<number> {
  if (budget <= 0 || signal?.aborted) return 0;

  const stats = fs.statSync(session.wire, { bigint: true });
  const source = { size: Number(stats.size), mtimeNs: stats.mtimeNs.toString() };
  const states = ctx.refinedManager.listRefinedTurnStates(session.sessionId);
  const progress = ctx.refinedManager.getSessionProgress(session.sessionId);
  const allRowsFresh = states.every(
    (state) =>
      state.extractorVersion === EXTRACTOR_VERSION &&
      state.sourceContentHash !== null &&
      state.sourceContentHash !== FRESHNESS_UNKNOWN,
  );
  if (
    progress?.lastSize === source.size &&
    progress.lastMtimeNs === source.mtimeNs &&
    progress.extractorVersion === EXTRACTOR_VERSION &&
    readWirePrefixHash(progress.wireIdentity) !== null &&
    readWireTurnCount(progress.wireIdentity) === states.length &&
    allRowsFresh
  ) {
    return 0;
  }

  const completeOffset = await findCompleteLineOffset(session.wire, source.size);
  const previousCount = readWireTurnCount(progress?.wireIdentity ?? null);
  const previousPrefixHash = readWirePrefixHash(progress?.wireIdentity ?? null);
  const previousOffset = progress?.lastCompleteLineOffset ?? 0;
  let canIncrement =
    previousCount !== null &&
    previousPrefixHash !== null &&
    previousCount === states.length &&
    previousOffset > 0 &&
    completeOffset > previousOffset &&
    progress?.extractorVersion === EXTRACTOR_VERSION &&
    allRowsFresh;
  if (
    canIncrement &&
    (await hashWireFilePrefix(session.wire, previousOffset)) !== previousPrefixHash
  ) {
    canIncrement = false;
  }

  let turns: WireTurn[];
  let currentIds: Set<number>;
  let identity: string;
  if (canIncrement) {
    const initialTurnId = previousCount ?? 0;
    const appended = await parseWireFile(session.wire, {
      startOffset: previousOffset,
      endOffset: completeOffset,
      initialTurnId,
    });
    const onlyNewTurns = appended.turns.every(
      (turn, index) => parseInt(turn.turnId, 10) === initialTurnId + index,
    );
    if (onlyNewTurns) {
      turns = appended.turns;
      currentIds = new Set(states.map((state) => state.turnId));
      for (const turn of turns) currentIds.add(parseInt(turn.turnId, 10));
      const entries: Array<[string, string]> = [...states]
        .sort((a, b) => a.turnId - b.turnId)
        .map((state) => [String(state.turnId), state.sourceContentHash!]);
      for (const turn of turns) entries.push([turn.turnId, hashRawTurn(turn)]);
      identity = buildWireIdentityFromHashes(entries);
    } else {
      turns = (await parseWireFile(session.wire, { endOffset: completeOffset })).turns;
      currentIds = new Set(turns.map((turn) => parseInt(turn.turnId, 10)));
      identity = buildWireIdentity(turns);
    }
  } else {
    turns = (await parseWireFile(session.wire, { endOffset: completeOffset })).turns;
    currentIds = new Set(turns.map((turn) => parseInt(turn.turnId, 10)));
    identity = buildWireIdentity(turns);
  }
  if (signal?.aborted) return 0;

  const stateById = new Map(states.map((state) => [state.turnId, state]));
  const stale = turns.filter((turn) => {
    const turnId = parseInt(turn.turnId, 10);
    const state = stateById.get(turnId);
    return (
      !state ||
      state.extractorVersion !== EXTRACTOR_VERSION ||
      state.sourceContentHash !== hashRawTurn(turn)
    );
  });
  const todo = stale.slice(0, budget);
  const complete = stale.length <= budget;
  const stable = complete && completeOffset === source.size && isStableSnapshot(session, source);
  const orphanedIds = stable
    ? states.map((state) => state.turnId).filter((turnId) => !currentIds.has(turnId))
    : [];

  const refinedTurns = todo.map((turn) => refineWireTurn(ctx.refinedManager, turn, session.sessionId, source));
  if (refinedTurns.length > 0) {
    await ctx.refinedManager.saveRefinedTurns(session.sessionId, refinedTurns);
  }
  if (orphanedIds.length > 0) {
    await ctx.refinedManager.deleteRefinedTurns(
      orphanedIds.map((turnId) => ({ sessionId: session.sessionId, turnId })),
    );
  }
  if (stable) {
    const prefixHash = await hashWireFilePrefix(session.wire, completeOffset);
    if (isStableSnapshot(session, source)) {
      await ctx.refinedManager.saveSessionProgress({
        sessionId: session.sessionId,
        lastOffset: completeOffset,
        lastCompleteLineOffset: completeOffset,
        lastSize: source.size,
        lastMtimeNs: source.mtimeNs,
        lastIndexedAt: new Date().toISOString(),
        wireIdentity: withWirePrefixHash(identity, prefixHash),
        extractorVersion: EXTRACTOR_VERSION,
      });
    }
  }
  return refinedTurns.length;
}
