/**
 * Context recovery tools: load_workspace_context, load_more_context, search_context, load_turn_context.
 */

import type {
  ListSearchViewsArgs,
  LoadMoreContextArgs,
  LoadTurnContextArgs,
  LoadWorkspaceContextArgs,
  SearchContextArgs,
} from '../types.js';
import type { Ctx } from '../types.js';
import type { TurnReference, WireTurn } from '../context/wire-context.js';
import {
  getCurrentSessionWirePath,
  findAllWorkspaceSessions,
  parseWireFile,
  buildContextWindow,
  loadMoreRounds,
  searchWireContext,
  loadTurnContext,
} from '../context/wire-context.js';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { DEFAULT_CLUSTER_GAP_SECONDS } from '../config.js';

function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

export function createContextTools(ctx: Ctx) {
  const { cwd, workspaceId, storeRoot, refinedManager } = ctx;

  interface Cluster {
    sessionId: string;
    hitTurnId: number;
    members: Array<{ sessionId: string; turnId: number }>;
  }

  function getTurnTime(turn: WireTurn): number | null {
    return turn.timestamp ? new Date(turn.timestamp).getTime() : null;
  }

  function resolveClusterGapSeconds(args: SearchContextArgs): number {
    if (typeof args.cluster_gap_seconds === 'number' && args.cluster_gap_seconds > 0) {
      return args.cluster_gap_seconds;
    }
    return DEFAULT_CLUSTER_GAP_SECONDS;
  }

  function groupHitsIntoBlocks(hits: WireTurn[]): WireTurn[][] {
    const sorted = [...hits].sort(
      (a, b) => parseInt(a.turnId, 10) - parseInt(b.turnId, 10),
    );
    const blocks: WireTurn[][] = [];
    let current: WireTurn[] = [];
    for (const hit of sorted) {
      const turnId = parseInt(hit.turnId, 10);
      if (
        current.length === 0 ||
        turnId === parseInt(current[current.length - 1].turnId, 10) + 1
      ) {
        current.push(hit);
      } else {
        blocks.push(current);
        current = [hit];
      }
    }
    if (current.length > 0) blocks.push(current);
    return blocks;
  }

  function expandCluster(
    sessionId: string,
    sessionTurns: WireTurn[],
    blockHitIds: number[],
    gapSeconds: number,
    occupied: Set<number>,
    maxClusterSize: number,
  ): Cluster {
    const gapMs = gapSeconds * 1000;
    const sorted = [...sessionTurns].sort(
      (a, b) => parseInt(a.turnId, 10) - parseInt(b.turnId, 10),
    );
    const indexMap = new Map(sorted.map((t, i) => [parseInt(t.turnId, 10), i]));

    const memberIds = new Set<number>(blockHitIds);
    const minHitId = Math.min(...blockHitIds);
    const maxHitId = Math.max(...blockHitIds);
    const minIndex = indexMap.get(minHitId);
    const maxIndex = indexMap.get(maxHitId);
    if (minIndex === undefined || maxIndex === undefined) {
      return { sessionId, hitTurnId: minHitId, members: [] };
    }

    // Expand backward from the leftmost hit, then forward from the rightmost hit.
    // Both multi-hit and single-hit blocks use the same time-window logic.
    // Expansion stops when the cluster would exceed maxClusterSize.

    // Expand backward.
    let idx = minIndex;
    while (idx > 0 && memberIds.size < maxClusterSize) {
      const prev = sorted[idx - 1];
      const curr = sorted[idx];
      const prevId = parseInt(prev.turnId, 10);
      if (occupied.has(prevId)) break;
      const prevTime = getTurnTime(prev);
      const currTime = getTurnTime(curr);
      if (prevTime && currTime && currTime - prevTime <= gapMs) {
        memberIds.add(prevId);
        idx--;
      } else {
        break;
      }
    }

    // Expand forward.
    idx = maxIndex;
    while (idx < sorted.length - 1 && memberIds.size < maxClusterSize) {
      const curr = sorted[idx];
      const next = sorted[idx + 1];
      const nextId = parseInt(next.turnId, 10);
      if (occupied.has(nextId)) break;
      const currTime = getTurnTime(curr);
      const nextTime = getTurnTime(next);
      if (currTime && nextTime && nextTime - currTime <= gapMs) {
        memberIds.add(nextId);
        idx++;
      } else {
        break;
      }
    }

    return {
      sessionId,
      hitTurnId: minHitId,
      members: Array.from(memberIds)
        .sort((a, b) => a - b)
        .map((turnId) => ({ sessionId, turnId })),
    };
  }

  async function buildWorkspaceContext(args: LoadWorkspaceContextArgs = {}) {
    const overrides: { detailedRounds?: number; summaryRounds?: number } = {};
    if (typeof args.detailed_rounds === 'number') {
      overrides.detailedRounds = Math.max(0, Math.floor(args.detailed_rounds));
    }
    if (typeof args.summary_rounds === 'number') {
      overrides.summaryRounds = Math.max(0, Math.floor(args.summary_rounds));
    }

    const session = getCurrentSessionWirePath();
    let recentContext = null;
    if (session) {
      const { turns, compactionSummaries } = await parseWireFile(session.wire);
      const window = buildContextWindow(turns, overrides);
      recentContext = {
        sessionId: session.sessionId,
        totalTurns: window.totalTurns,
        detailedRounds: window.detailedRounds,
        summaryRounds: window.summaryRounds,
        compactionSummaries: compactionSummaries.slice(-3),
      };
    }

    return {
      workspace: {
        cwd,
        workspaceId,
        storePath: storeRoot,
      },
      recentContext,
    };
  }

  function handleLoadWorkspaceContext(args: LoadWorkspaceContextArgs) {
    return buildWorkspaceContext(args).then((data) => toolResult(data));
  }

  async function handleLoadMoreContext(args: LoadMoreContextArgs) {
    const beforeTurnId =
      typeof args.before_turn_id === 'number' ? Math.floor(args.before_turn_id) : null;
    if (beforeTurnId === null || beforeTurnId === undefined || beforeTurnId <= 0) {
      return toolResult({ error: 'Missing or invalid "before_turn_id"' }, true);
    }

    const session = getCurrentSessionWirePath();
    if (!session) {
      return toolResult({ beforeTurnId, rounds: [], hasMore: false });
    }

    const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : undefined;

    const { turns } = await parseWireFile(session.wire);
    const rounds = loadMoreRounds(turns, beforeTurnId, limit);
    const olderCount = turns.filter((t) => parseInt(t.turnId, 10) < beforeTurnId).length;

    return toolResult({
      sessionId: session.sessionId,
      totalTurns: turns.length,
      beforeTurnId,
      rounds,
      hasMore: olderCount > rounds.length,
    });
  }

  async function handleSearchContext(args: SearchContextArgs) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return toolResult({ query, matches: [], clusters: [], refinedCount: 0 });
    }

    const clusterGapSeconds = resolveClusterGapSeconds(args);
    const maxClusterSize =
      typeof args.max_cluster_size === 'number' && args.max_cluster_size > 0
        ? Math.max(2, Math.floor(args.max_cluster_size))
        : 15;
    const { matches, hits, skippedSessionIds } = await searchWireContext(query, {
      limit: args.limit,
      dateFrom: args.date_from,
      dateTo: args.date_to,
      refinedManager,
    });

    // Build clusters around each hit and refine any unrefined turns in them.
    const hitsBySession = new Map<string, WireTurn[]>();
    for (const { sessionId, turn } of hits) {
      hitsBySession.set(sessionId, [...(hitsBySession.get(sessionId) || []), turn]);
    }

    const clusters: Cluster[] = [];
    const refinedCountByCluster: number[] = [];
    const refinedIdsBySession = new Map<string, Set<number>>();
    let refinedCount = 0;

    // First pass: build all clusters and aggregate per-session turn ids to refine.
    const toRefineBySession = new Map<string, Map<number, WireTurn>>();
    const skippedSessions: string[] = skippedSessionIds ? [...skippedSessionIds] : [];
    for (const [sessionId, sessionHits] of hitsBySession.entries()) {
      const wirePath =
        getCurrentSessionWirePath()?.sessionId === sessionId
          ? getCurrentSessionWirePath()!.wire
          : findSessionWirePath(sessionId);
      if (!wirePath) {
        skippedSessions.push(sessionId);
        continue;
      }
      const { turns } = await parseWireFile(wirePath);

      const existing = refinedManager.loadRefinedTurns(sessionId);
      const existingIds = new Set(existing.map((t) => t.turnId));
      refinedIdsBySession.set(sessionId, existingIds);

      const turnById = new Map(turns.map((t) => [parseInt(t.turnId, 10), t]));
      const sessionToRefine = new Map<number, WireTurn>();
      toRefineBySession.set(sessionId, sessionToRefine);

      // Group adjacent hits into blocks to avoid one-cluster-per-hit overlap.
      const blocks = groupHitsIntoBlocks(sessionHits);
      const occupied = new Set<number>();

      for (const block of blocks) {
        const blockHitIds = block.map((h) => parseInt(h.turnId, 10));
        const cluster = expandCluster(
          sessionId,
          turns,
          blockHitIds,
          clusterGapSeconds,
          occupied,
          maxClusterSize,
        );
        clusters.push(cluster);

        let clusterRefined = 0;
        for (const m of cluster.members) {
          occupied.add(m.turnId);
          if (existingIds.has(m.turnId)) continue;
          const turn = turnById.get(m.turnId);
          if (!turn) continue;
          sessionToRefine.set(m.turnId, turn);
          clusterRefined++;
        }
        refinedCountByCluster.push(clusterRefined);
      }
    }

    // Second pass: batch refine per session to avoid repeated saves and redundant work.
    for (const [sessionId, sessionToRefine] of toRefineBySession.entries()) {
      if (sessionToRefine.size === 0) continue;
      const refinedTurns = Array.from(sessionToRefine.values())
        .map((turn) =>
          refinedManager.refineTurn(
            { ...turn, timestamp: turn.timestamp || undefined },
            sessionId,
          ),
        )
        .filter((t): t is NonNullable<typeof t> => t !== null);

      if (refinedTurns.length > 0) {
        await refinedManager.saveRefinedTurns(sessionId, refinedTurns);
        refinedCount += refinedTurns.length;
      }
    }

    // Save the search view (only references, no content).
    saveSearchView(query, clusters, refinedCountByCluster, matches.length, refinedCount, clusterGapSeconds, maxClusterSize, skippedSessions);

    return toolResult({
      query,
      totalMatches: matches.length,
      matches,
      clusterGapSeconds,
      maxClusterSize,
      skippedSessions,
      clusters: clusters.map((c, i) => ({
        sessionId: c.sessionId,
        hitTurnId: c.hitTurnId,
        memberCount: c.members.length,
        refinedCount: refinedCountByCluster[i] || 0,
        members: c.members,
      })),
      refinedCount,
    });
  }

  function findSessionWirePath(sessionId: string): string | null {
    const sessions = findAllWorkspaceSessions();
    const session = sessions.find((s) => s.sessionId === sessionId);
    return session ? session.wire : null;
  }

  function saveSearchView(
    query: string,
    clusters: Cluster[],
    refinedCountByCluster: number[] = [],
    totalMatches = 0,
    totalRefined = 0,
    gapSeconds = DEFAULT_CLUSTER_GAP_SECONDS,
    maxClusterSize = 15,
    skippedSessions: string[] = [],
  ): void {
    const normalized = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 0)
      .sort()
      .join('-');
    const hash = crypto.createHash('md5').update(normalized).digest('hex').slice(0, 12);
    const fileName = `search-${hash}.json`;
    const dir = path.join(storeRoot, 'searches');
    fs.mkdirSync(dir, { recursive: true });

    const view = {
      query,
      createdAt: new Date().toISOString(),
      totalMatches,
      totalRefined,
      gapSeconds,
      maxClusterSize,
      skippedSessions,
      clusters: clusters.map((c, i) => ({
        sessionId: c.sessionId,
        hitTurnId: c.hitTurnId,
        memberCount: c.members.length,
        refinedCount: refinedCountByCluster[i] || 0,
        members: c.members,
      })),
    };

    const tmpPath = path.join(dir, `${fileName}.tmp`);
    fs.writeFileSync(tmpPath, JSON.stringify(view, null, 2), 'utf8');
    fs.renameSync(tmpPath, path.join(dir, fileName));
  }

  function handleListSearchViews(args: ListSearchViewsArgs = {}) {
    const dir = path.join(storeRoot, 'searches');
    if (!fs.existsSync(dir)) {
      return toolResult({ views: [] });
    }

    const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : 20;
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('search-') && f.endsWith('.json'))
      .map((fileName) => {
        const filePath = path.join(dir, fileName);
        const stat = fs.statSync(filePath);
        const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return {
          fileName,
          query: content.query || '',
          createdAt: content.createdAt || stat.mtime.toISOString(),
          clusterCount: content.clusters?.length || 0,
        };
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);

    return toolResult({ views: files });
  }

  async function handleLoadTurnContext(args: LoadTurnContextArgs) {
    const references = Array.isArray(args.references) ? (args.references as TurnReference[]) : [];
    const result = await loadTurnContext(references);

    if (result.error) {
      return toolResult({ error: result.error, rounds: [], notFound: [] }, true);
    }

    return toolResult({
      rounds: result.rounds,
      notFound: result.notFound,
    });
  }

  return {
    buildWorkspaceContext,
    handleLoadWorkspaceContext,
    handleLoadMoreContext,
    handleSearchContext,
    handleListSearchViews,
    handleLoadTurnContext,
  };
}
