/**
 * Context recovery tools: load_workspace_context, load_more_context, search_context, load_turn_context.
 */

import type {
  LoadMoreContextArgs,
  LoadTurnContextArgs,
  LoadWorkspaceContextArgs,
  SearchContextArgs,
} from '../types.js';
import type { Ctx } from '../types.js';
import type { TurnReference } from '../context/wire-context.js';
import {
  getCurrentSessionWirePath,
  parseWireFile,
  buildContextWindow,
  loadMoreRounds,
  searchWireContext,
  loadTurnContext,
} from '../context/wire-context.js';

function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

export function createContextTools(ctx: Ctx) {
  const { cwd, workspaceId, storeRoot } = ctx;

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
      return toolResult({ query, matches: [] });
    }

    const result = await searchWireContext(query, {
      limit: args.limit,
      dateFrom: args.date_from,
      dateTo: args.date_to,
    });

    return toolResult(result);
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
    handleLoadTurnContext,
  };
}
