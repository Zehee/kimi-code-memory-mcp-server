/**
 * Context recovery tools: load_more_context, search_context, load_turn_context.
 */

import fs from 'node:fs';
import type {
  DeleteSearchViewArgs,
  ListSearchViewsArgs,
  LoadMoreContextArgs,
  LoadTurnContextArgs,
  LoadWorkspaceContextArgs,
  SearchContextArgs,
} from '../types.js';
import type { Ctx } from '../types.js';
import type { ToolDefinition } from './types.js';
import { adaptHandler } from './types.js';
import type { SearchMatch, TurnReference, WireTurn } from '../context/wire-context.js';
import {
  getCurrentSessionWirePath,
  findPreviousSession,
  parseWireFile,
  buildContextWindow,
  loadMoreRounds,
  searchWireContext,
  loadTurnContext,
} from '../context/wire-context.js';
import {
  DEFAULT_CLUSTER_GAP_SECONDS,
  DEFAULT_SEARCH_OUTPUT_BUDGET,
  SEARCH_USER_MAX_LEN,
  SEARCH_AGENT_MAX_LEN,
  SEARCH_SNIPPET_MAX_LEN,
} from '../config.js';
import {
  SearchViewRepository,
  InvalidSearchViewKeyError,
  SearchViewNotFoundError,
  SearchViewAccessError,
  SearchViewCorruptError,
} from '../search/search-view-repository.js';
import { deleteSearchView as deleteSharedSearchView } from '../search/delete-search-view.js';
import { refineWireTurn, type WireSourceStamp } from '../background/refine-batch.js';
import { EXTRACTOR_VERSION } from '../refine/constants.js';
import { hashRawTurn } from '../refine/freshness.js';
import { toolResult } from '../utils/tools.js';

export async function buildWorkspaceContext(
  ctx: Ctx,
  args: LoadWorkspaceContextArgs = {},
): Promise<{
  workspace: { cwd: string; workspaceId: string; storePath: string };
  recentContext: {
    sessionId: string;
    totalTurns: number;
    detailedRounds: unknown[];
    summaryRounds: unknown[];
    compactionSummaries: unknown[];
    loadedFromPrevious: boolean;
    /** True when the source session was selected by mtime (low confidence). */
    identityAssumed?: boolean;
    identitySource?: 'explicit' | 'mapped' | 'guess';
  } | null;
}> {
  const { cwd, workspaceId, storeRoot } = ctx;
  const overrides: { detailedRounds?: number; summaryRounds?: number } = {};
  if (typeof args.detailed_rounds === 'number') {
    overrides.detailedRounds = Math.max(0, Math.floor(args.detailed_rounds));
  }
  if (typeof args.summary_rounds === 'number') {
    overrides.summaryRounds = Math.max(0, Math.floor(args.summary_rounds));
  }

  // Context resumption always targets the most recent previous session: at
  // bootstrap time the current session is brand new and carries no usable
  // history of its own, so we rebuild the workspace context from the session
  // that came before it.
  const previous = findPreviousSession();
  let recentContext = null;
  if (previous) {
    const { turns, compactionSummaries } = await parseWireFile(previous.wire);
    const window = buildContextWindow(turns, overrides);
    recentContext = {
      sessionId: previous.sessionId,
      totalTurns: window.totalTurns,
      detailedRounds: window.detailedRounds,
      summaryRounds: window.summaryRounds,
      compactionSummaries: compactionSummaries.slice(-3),
      loadedFromPrevious: true,
      // The previous session is always an mtime selection: low confidence.
      identityAssumed: previous.identityAssumed === true,
      identitySource: previous.identitySource ?? 'guess',
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

export function createContextTools(ctx: Ctx): ToolDefinition[] {
  const { storeRoot, refinedManager, memoryStore } = ctx;
  const searchViews = new SearchViewRepository(storeRoot);

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

  function resolveDetail(args: SearchContextArgs): 'compact' | 'normal' | 'full' {
    const valid: Array<'compact' | 'normal' | 'full'> = ['compact', 'normal', 'full'];
    if (
      typeof args.detail === 'string' &&
      valid.includes(args.detail as 'compact' | 'normal' | 'full')
    ) {
      return args.detail as 'compact' | 'normal' | 'full';
    }
    return 'normal';
  }

  function resolveMaxOutputChars(
    args: SearchContextArgs,
    detail: 'compact' | 'normal' | 'full',
  ): number {
    if (detail === 'full') return Number.MAX_SAFE_INTEGER;
    if (typeof args.max_output_chars === 'number' && args.max_output_chars > 0) {
      return Math.max(500, Math.floor(args.max_output_chars));
    }
    return DEFAULT_SEARCH_OUTPUT_BUDGET;
  }

  function estimateOutputSize(obj: unknown): number {
    return JSON.stringify(obj).length;
  }

  interface CompactMatch {
    sessionId: string;
    turnId: number;
    timestamp: string | null;
    score: number;
  }

  interface CompactCluster {
    sessionId: string;
    hitTurnId: number;
    memberCount: number;
    refinedCount: number;
  }

  interface NormalCluster extends CompactCluster {
    members: Array<{ sessionId: string; turnId: number }>;
  }

  function buildCompactMatch(match: SearchMatch): CompactMatch {
    return {
      sessionId: match.sessionId,
      turnId: match.turnId,
      timestamp: match.timestamp,
      score: match.score,
    };
  }

  function buildNormalCluster(cluster: Cluster, refinedCount: number): NormalCluster {
    return {
      sessionId: cluster.sessionId,
      hitTurnId: cluster.hitTurnId,
      memberCount: cluster.members.length,
      refinedCount,
      members: cluster.members,
    };
  }

  function buildCompactCluster(cluster: Cluster, refinedCount: number): CompactCluster {
    return {
      sessionId: cluster.sessionId,
      hitTurnId: cluster.hitTurnId,
      memberCount: cluster.members.length,
      refinedCount,
    };
  }

  /**
   * Trim the response to the output budget.
   *
   * Returns true when something had to be dropped. The scan level counters
   * (`matchCount`, `totalMatches`) are never modified here: they describe the
   * scan, not the rendered payload.
   */
  function trimOutputToBudget(
    result: {
      matches: SearchMatch[] | CompactMatch[];
      clusters: NormalCluster[] | CompactCluster[];
    },
    maxChars: number,
  ): boolean {
    let trimmed = false;
    // Matches are already sorted by score descending; drop lowest-scoring last.
    while (estimateOutputSize(result) > maxChars && result.matches.length > 0) {
      result.matches.pop();
      trimmed = true;
    }
    while (estimateOutputSize(result) > maxChars && result.clusters.length > 0) {
      result.clusters.pop();
      trimmed = true;
    }
    // If still over budget, strip members arrays from clusters.
    if (estimateOutputSize(result) > maxChars && result.clusters.length > 0) {
      result.clusters = result.clusters.map((c) => ({
        sessionId: c.sessionId,
        hitTurnId: c.hitTurnId,
        memberCount: c.memberCount,
        refinedCount: c.refinedCount,
      })) as CompactCluster[];
      trimmed = true;
    }
    return trimmed;
  }

  function groupHitsIntoBlocks(hits: WireTurn[]): WireTurn[][] {
    const sorted = [...hits].sort((a, b) => parseInt(a.turnId, 10) - parseInt(b.turnId, 10));
    const blocks: WireTurn[][] = [];
    let current: WireTurn[] = [];
    for (const hit of sorted) {
      const turnId = parseInt(hit.turnId, 10);
      if (current.length === 0 || turnId === parseInt(current[current.length - 1].turnId, 10) + 1) {
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

  async function handleSearchContext(args: SearchContextArgs, signal?: AbortSignal) {
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query) {
      return toolResult({
        query,
        matches: [],
        clusters: [],
        refinedCount: 0,
        matchCount: 0,
        isComplete: true,
        skippedSessions: [],
      });
    }

    const clusterGapSeconds = resolveClusterGapSeconds(args);
    const maxClusterSize =
      typeof args.max_cluster_size === 'number' && args.max_cluster_size > 0
        ? Math.max(2, Math.floor(args.max_cluster_size))
        : 15;
    const detail = resolveDetail(args);
    const maxOutputChars = resolveMaxOutputChars(args, detail);

    const searchOptions: Parameters<typeof searchWireContext>[1] = {
      limit: args.limit,
      cursor: args.cursor,
      dateFrom: args.date_from,
      dateTo: args.date_to,
      refinedManager,
      signal,
    };
    if (detail === 'full') {
      searchOptions.userMaxLen = Number.MAX_SAFE_INTEGER;
      searchOptions.agentMaxLen = Number.MAX_SAFE_INTEGER;
      searchOptions.snippetMaxLen = SEARCH_SNIPPET_MAX_LEN;
    } else if (detail === 'normal') {
      searchOptions.userMaxLen = SEARCH_USER_MAX_LEN;
      searchOptions.agentMaxLen = SEARCH_AGENT_MAX_LEN;
      searchOptions.snippetMaxLen = SEARCH_SNIPPET_MAX_LEN;
    }

    const searchResult = await searchWireContext(query, searchOptions);
    const { matches, hits, matchCount, isComplete, truncationReason } = searchResult;
    if (truncationReason === 'invalid-cursor') {
      return toolResult(
        {
          success: false,
          error: `Invalid or stale cursor: ${args.cursor}`,
          query,
          matches: [],
          clusters: [],
          isComplete: false,
          truncationReason,
        },
        true,
      );
    }

    // Build clusters around each hit and refine missing or stale turns in them.
    const hitsBySession = new Map<string, WireTurn[]>();
    const wireBySession = new Map<string, string>();
    for (const { sessionId, turn, wire } of hits) {
      hitsBySession.set(sessionId, [...(hitsBySession.get(sessionId) || []), turn]);
      wireBySession.set(sessionId, wire);
    }

    const clusters: Cluster[] = [];
    const refinedCountByCluster: number[] = [];
    const sourceBySession = new Map<string, WireSourceStamp>();
    let refinedCount = 0;

    // First pass: build all clusters and aggregate per-session turn ids to refine.
    const toRefineBySession = new Map<string, Map<number, WireTurn>>();
    const skippedSessions: string[] = searchResult.skippedSessionIds
      ? [...searchResult.skippedSessionIds]
      : [];
    for (const [sessionId, sessionHits] of hitsBySession.entries()) {
      if (signal?.aborted) {
        // Cancelled: stop building clusters and skip the refinement pass
        // entirely — the caller gets the partial search result above.
        break;
      }
      const wirePath = wireBySession.get(sessionId);
      if (!wirePath) {
        skippedSessions.push(sessionId);
        continue;
      }
      const { turns } = await parseWireFile(wirePath);
      const stats = fs.statSync(wirePath, { bigint: true });
      sourceBySession.set(sessionId, {
        size: Number(stats.size),
        mtimeNs: stats.mtimeNs.toString(),
      });
      const stateById = new Map(
        refinedManager.listRefinedTurnStates(sessionId).map((state) => [state.turnId, state]),
      );

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
          const turn = turnById.get(m.turnId);
          if (!turn) continue;
          const state = stateById.get(m.turnId);
          if (
            state?.extractorVersion === EXTRACTOR_VERSION &&
            state.sourceContentHash === hashRawTurn(turn)
          ) {
            continue;
          }
          sessionToRefine.set(m.turnId, turn);
          clusterRefined++;
        }
        refinedCountByCluster.push(clusterRefined);
      }
    }

    // Second pass: batch refine per session to avoid repeated saves and redundant work.
    // A cancelled request skips the refinement side effect entirely.
    if (signal?.aborted) {
      const baseOutput = {
        query,
        matchCount,
        returnedMatches: 0,
        isComplete: false,
        truncationReason: 'request-cancelled',
        nextCursor: searchResult.nextCursor,
        refinedCount: 0,
        savedViewKey: null,
      };
      return toolResult({ ...baseOutput, matches: [], clusters: [] });
    }
    for (const [sessionId, sessionToRefine] of toRefineBySession.entries()) {
      if (sessionToRefine.size === 0) continue;
      const source = sourceBySession.get(sessionId);
      if (!source) continue;
      const refinedTurns = Array.from(sessionToRefine.values()).map((turn) =>
        refineWireTurn(refinedManager, turn, sessionId, source),
      );

      if (refinedTurns.length > 0) {
        await refinedManager.saveRefinedTurns(sessionId, refinedTurns);
        refinedCount += refinedTurns.length;
      }
    }

    // Save the search view (only references, no content) under the workspace
    // lock so it cannot interleave with a concurrent cascade delete.
    const shouldSaveView = args.save_view !== false;
    let savedViewKey: string | null = null;
    if (shouldSaveView) {
      savedViewKey = await saveSearchView({
        query,
        clusters,
        refinedCountByCluster,
        matchCount,
        isComplete: isComplete && !args.cursor,
        refinedCount,
        clusterGapSeconds,
        maxClusterSize,
        skippedSessions,
        dateFrom: args.date_from ?? null,
        dateTo: args.date_to ?? null,
        limit: searchResult.totalMatches ?? matchCount,
      });
    }

    const normalClusters = clusters.map((c, i) =>
      buildNormalCluster(c, refinedCountByCluster[i] || 0),
    );
    const compactClusters = clusters.map((c, i) =>
      buildCompactCluster(c, refinedCountByCluster[i] || 0),
    );
    const compactMatches = matches.map(buildCompactMatch);

    const baseOutput = {
      query,
      // `totalMatches` is the complete merged total; it is omitted when the
      // scan was partial because a partial scan cannot certify a total.
      totalMatches: searchResult.totalMatches,
      matchCount,
      returnedMatches: matches.length,
      isComplete,
      truncationReason,
      nextCursor: searchResult.nextCursor,
      corruptRefinedRows: searchResult.corruptRefinedRows,
      refinedCount,
      clusterGapSeconds,
      maxClusterSize,
      skippedSessions,
      skippedSessionIds: skippedSessions,
      savedViewKey,
    };

    if (detail === 'normal') {
      const normalResult = {
        ...baseOutput,
        matches,
        clusters: normalClusters,
      };
      const outputTruncated = trimOutputToBudget(normalResult, maxOutputChars);
      return toolResult({ ...normalResult, outputTruncated });
    }

    if (detail === 'compact') {
      return toolResult({
        ...baseOutput,
        matches: compactMatches,
        clusters: compactClusters,
      });
    }

    return toolResult({
      ...baseOutput,
      matches,
      clusters: normalClusters,
    });
  }

  /**
   * Persist a search view through the shared repository.
   *
   * The repository generates a fresh `search-v2-<32 hex>` key and stores the
   * full query parameters inside the file.
   */
  async function saveSearchView(input: {
    query: string;
    clusters: Cluster[];
    refinedCountByCluster?: number[];
    matchCount: number;
    isComplete: boolean;
    refinedCount: number;
    clusterGapSeconds: number;
    maxClusterSize: number;
    skippedSessions: string[];
    dateFrom: string | null;
    dateTo: string | null;
    limit: number;
  }): Promise<string | null> {
    try {
      const record = await memoryStore.withWorkspaceLock(() =>
        searchViews.save({
          query: input.query,
          filters: {
            dateFrom: input.dateFrom,
            dateTo: input.dateTo,
            limit: input.limit,
            clusterGapSeconds: input.clusterGapSeconds,
            maxClusterSize: input.maxClusterSize,
          },
          counts: {
            totalMatches: input.isComplete ? input.matchCount : 0,
            matchCount: input.matchCount,
            isComplete: input.isComplete,
            totalRefined: input.refinedCount,
            skippedSessionIds: input.skippedSessions,
          },
          clusters: input.clusters.map((c, i) => ({
            sessionId: c.sessionId,
            hitTurnId: c.hitTurnId,
            memberCount: c.members.length,
            refinedCount: input.refinedCountByCluster?.[i] || 0,
            members: c.members,
          })),
        }),
      );
      return record.key;
    } catch {
      // A failed view write must not fail the search itself.
      return null;
    }
  }

  function handleListSearchViews(args: ListSearchViewsArgs = {}) {
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : 20;
    const views = searchViews.list(limit);
    return toolResult({ views });
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

  async function handleDeleteSearchView(args: DeleteSearchViewArgs) {
    const key = typeof args.key === 'string' ? args.key.trim() : '';
    if (!key) {
      return toolResult({ success: false, error: 'Missing or invalid "key"' }, true);
    }
    const deleteRefinedTurns = args.deleteRefinedTurns === true;

    try {
      // The cascade (and the shared-reference check) lives in one shared
      // service so the MCP tool and the HTTP endpoint cannot drift apart.
      const result = await deleteSharedSearchView(ctx, key, deleteRefinedTurns);
      return toolResult({ success: true, ...result });
    } catch (err) {
      if (
        err instanceof InvalidSearchViewKeyError ||
        err instanceof SearchViewNotFoundError ||
        err instanceof SearchViewAccessError ||
        err instanceof SearchViewCorruptError
      ) {
        return toolResult({ success: false, error: err.message, code: err.code, key }, true);
      }
      return toolResult(
        { success: false, error: err instanceof Error ? err.message : String(err), key },
        true,
      );
    }
  }

  const tools: ToolDefinition[] = [
    {
      name: 'load_more_context',
      description:
        'Load older conversation rounds from the active wire.jsonl, summarized, before a given turn id.',
      inputSchema: {
        type: 'object',
        properties: {
          before_turn_id: {
            type: 'number',
            description: 'Exclusive turn id; return rounds older than this.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of older rounds to return.',
          },
        },
        required: ['before_turn_id'],
      },
      handler: adaptHandler(handleLoadMoreContext),
    },
    {
      name: 'search_context',
      description:
        "Search conversation rounds across all workspace session wires by keywords and optional date range. Default detail: 'normal' keeps output within ~6000 chars. Use detail: 'compact' for a quick overview (no match text, no cluster members). Use detail: 'full' when you need full match text and all cluster members.",
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to search for in conversation rounds' },
          date_from: { type: 'string', description: 'Optional start date in YYYY-MM-DD format' },
          date_to: { type: 'string', description: 'Optional end date in YYYY-MM-DD format' },
          limit: { type: 'number', description: 'Maximum number of matching rounds to return' },
          cursor: {
            type: 'string',
            description:
              'Resume from the nextCursor returned by a previous partial search. Cursor pages do not report a global totalMatches.',
          },
          cluster_gap_seconds: {
            type: 'number',
            description:
              '相邻 turn 被归为同一「簇」的最大时间间隔（秒）。一个簇代表一段连续的讨论或决策。默认 90 秒；协作节奏慢可适当调大，话题切换快则调小。',
          },
          max_cluster_size: {
            type: 'number',
            description: '单个 cluster 最多包含的 turn 数，防止连续讨论过长时上下文爆炸。默认 15。',
          },
          detail: {
            type: 'string',
            enum: ['compact', 'normal', 'full'],
            description:
              "Output detail level. 'normal' (default) returns truncated text and cluster members within the output budget. 'compact' returns only references/counts. 'full' disables the budget and returns longer text.",
          },
          max_output_chars: {
            type: 'number',
            description:
              'Maximum output length in characters for normal mode. Default 6000. Ignored in compact/full.',
          },
          save_view: {
            type: 'boolean',
            description:
              'Persist this search as a search view. Default true. Set false for read-only guard checks so the search does not create state.',
          },
        },
        required: ['query'],
      },
      handler: adaptHandler(handleSearchContext),
    },
    {
      name: 'list_search_views',
      description:
        'List saved search views. Each view records the clusters discovered by a previous search_context call. Use these views as candidate sets before creating or extending a theme.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum number of recent views to return' },
        },
      },
      handler: adaptHandler(handleListSearchViews),
    },
    {
      name: 'delete_search_view',
      description:
        'Delete a saved search view. Set deleteRefinedTurns to true to also remove the refined rows referenced only by this view. This invalidates the current cache rather than creating a tombstone: the background indexer will rebuild missing rows from the wire on a later pass. Rows still referenced by another search view or by a theme are kept and reported as skippedSharedRefinedTurns.',
      inputSchema: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              'Search view key without extension: "search-<12 hex>" (legacy) or "search-v2-<32 hex>".',
          },
          deleteRefinedTurns: {
            type: 'boolean',
            description: 'If true, also delete all refined turns referenced by this view.',
          },
        },
        required: ['key'],
      },
      handler: adaptHandler(handleDeleteSearchView),
    },
    {
      name: 'load_turn_context',
      description:
        'Load the full detailed content of specific conversation turns by sessionId and turnId.',
      inputSchema: {
        type: 'object',
        properties: {
          references: {
            type: 'array',
            description:
              'Array of { sessionId, turnId } references identifying the conversation rounds to load',
            items: {
              type: 'object',
              properties: {
                sessionId: { type: 'string', description: 'Session identifier' },
                turnId: { type: 'number', description: 'Turn identifier within the session' },
              },
              required: ['sessionId', 'turnId'],
            },
          },
        },
        required: ['references'],
      },
      handler: adaptHandler(handleLoadTurnContext),
    },
  ];

  return tools;
}
