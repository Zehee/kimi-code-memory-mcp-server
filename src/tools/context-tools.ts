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

function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

export function createContextTools(ctx: Ctx) {
  const { cwd, workspaceId, storeRoot, refinedManager } = ctx;

  const CLUSTER_GAP_MS = 90 * 1000;

  interface Cluster {
    sessionId: string;
    hitTurnId: number;
    members: Array<{ sessionId: string; turnId: number }>;
  }

  function getTurnTime(turn: WireTurn): number | null {
    return turn.timestamp ? new Date(turn.timestamp).getTime() : null;
  }

  function expandCluster(sessionId: string, sessionTurns: WireTurn[], hitTurnId: number): Cluster {
    const sorted = [...sessionTurns].sort(
      (a, b) => parseInt(a.turnId, 10) - parseInt(b.turnId, 10),
    );
    const indexMap = new Map(sorted.map((t, i) => [parseInt(t.turnId, 10), i]));
    const hitIndex = indexMap.get(hitTurnId);
    if (hitIndex === undefined) return { sessionId, hitTurnId, members: [] };

    const memberIds = new Set<number>();
    memberIds.add(hitTurnId);

    // Expand backward.
    let idx = hitIndex;
    while (idx > 0) {
      const prev = sorted[idx - 1];
      const curr = sorted[idx];
      const prevTime = getTurnTime(prev);
      const currTime = getTurnTime(curr);
      if (prevTime && currTime && currTime - prevTime <= CLUSTER_GAP_MS) {
        memberIds.add(parseInt(prev.turnId, 10));
        idx--;
      } else {
        break;
      }
    }

    // Expand forward.
    idx = hitIndex;
    while (idx < sorted.length - 1) {
      const curr = sorted[idx];
      const next = sorted[idx + 1];
      const currTime = getTurnTime(curr);
      const nextTime = getTurnTime(next);
      if (currTime && nextTime && nextTime - currTime <= CLUSTER_GAP_MS) {
        memberIds.add(parseInt(next.turnId, 10));
        idx++;
      } else {
        break;
      }
    }

    return {
      sessionId,
      hitTurnId,
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

    const { matches, hits } = await searchWireContext(query, {
      limit: args.limit,
      dateFrom: args.date_from,
      dateTo: args.date_to,
    });

    // Build clusters around each hit and refine any unrefined turns in them.
    const hitsBySession = new Map<string, WireTurn[]>();
    const sessionTurns = new Map<string, WireTurn[]>();
    for (const { sessionId, turn } of hits) {
      hitsBySession.set(sessionId, [...(hitsBySession.get(sessionId) || []), turn]);
    }

    const clusters: Cluster[] = [];
    const refinedIdsBySession = new Map<string, Set<number>>();
    let refinedCount = 0;

    for (const [sessionId, sessionHits] of hitsBySession.entries()) {
      const { turns } = await parseWireFile(
        getCurrentSessionWirePath()?.sessionId === sessionId
          ? getCurrentSessionWirePath()!.wire
          : findSessionWirePath(sessionId),
      );
      sessionTurns.set(sessionId, turns);

      const existing = refinedManager.loadRefinedTurns(sessionId);
      const existingIds = new Set(existing.map((t) => t.turnId));
      refinedIdsBySession.set(sessionId, existingIds);

      for (const hit of sessionHits) {
        const hitTurnId = parseInt(hit.turnId, 10);
        const cluster = expandCluster(sessionId, turns, hitTurnId);
        clusters.push(cluster);

        const toRefine = cluster.members
          .filter((m) => !existingIds.has(m.turnId))
          .map((m) => {
            const turn = turns.find((t) => parseInt(t.turnId, 10) === m.turnId);
            return turn
              ? refinedManager.refineTurn(
                  { ...turn, timestamp: turn.timestamp || undefined },
                  sessionId,
                )
              : null;
          })
          .filter((t): t is NonNullable<typeof t> => t !== null);

        if (toRefine.length > 0) {
          await refinedManager.saveRefinedTurns(sessionId, toRefine);
          refinedCount += toRefine.length;
        }
      }
    }

    // Save the search view (only references, no content).
    saveSearchView(query, clusters);

    return toolResult({
      query,
      totalMatches: matches.length,
      matches,
      clusters: clusters.map((c) => ({
        sessionId: c.sessionId,
        hitTurnId: c.hitTurnId,
        memberCount: c.members.length,
        members: c.members,
      })),
      refinedCount,
    });
  }

  function findSessionWirePath(sessionId: string): string {
    const sessions = findAllWorkspaceSessions();
    const session = sessions.find((s) => s.sessionId === sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return session.wire;
  }

  function saveSearchView(query: string, clusters: Cluster[]): void {
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
      clusters: clusters.map((c) => ({
        sessionId: c.sessionId,
        hitTurnId: c.hitTurnId,
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
