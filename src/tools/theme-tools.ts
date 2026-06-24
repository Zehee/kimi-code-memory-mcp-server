/**
 * Theme tracing tools: tag_theme, trace_theme, list_themes, refine_session_turns.
 */

import fs from 'fs';
import path from 'path';
import type { Ctx, RefineSessionTurnsArgs, TagThemeArgs, TraceThemeArgs } from '../types.js';
import { sanitizeFolder, sanitizeKey, toTitle } from '../utils/validation.js';
import { parseFrontmatter } from '../utils/frontmatter.js';
import { findAllWorkspaceSessions, parseWireFile } from '../context/wire-context.js';

function toolResult(data: unknown, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

function safeParseFile(filePath: string) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    return parseFrontmatter(text) || { frontmatter: {}, body: text };
  } catch {
    return null;
  }
}

export function createThemeTools(ctx: Ctx) {
  const { storeRoot, themeManager, refinedManager } = ctx;

  async function handleTagTheme(args: TagThemeArgs) {
    const theme = args.theme;
    if (!theme || typeof theme !== 'string') {
      return toolResult({ success: false, error: 'Missing or invalid "theme"' }, true);
    }

    const ref: {
      sessionId?: string;
      turnId?: number;
      memoryKey?: string;
      folder?: string;
      title?: string;
    } = {};
    if (args.sessionId && typeof args.turnId === 'number') {
      const allSessions = findAllWorkspaceSessions();
      const session = allSessions.find((s) => s.sessionId === args.sessionId);
      if (!session) {
        return toolResult({ success: false, error: 'Session not found' }, true);
      }
      const { turns } = await parseWireFile(session.wire);
      const turnExists = turns.some((t) => String(t.turnId) === String(args.turnId));
      if (!turnExists) {
        return toolResult({ success: false, error: 'Turn not found' }, true);
      }
      ref.sessionId = args.sessionId;
      ref.turnId = args.turnId;
    }
    if (args.memoryKey) {
      const memoryFolderRaw = typeof args.memoryFolder === 'string' ? args.memoryFolder : 'memory';
      const memoryFolder = sanitizeFolder(memoryFolderRaw);
      if (!memoryFolder) {
        return toolResult({ success: false, error: 'Invalid memoryFolder path' }, true);
      }
      const sanitizedMemoryKey = sanitizeKey(args.memoryKey);
      const memoryFilePath = path.join(storeRoot, memoryFolder, `${sanitizedMemoryKey}.md`);
      if (!fs.existsSync(memoryFilePath)) {
        return toolResult({ success: false, error: 'Memory not found' }, true);
      }
      const parsed = safeParseFile(memoryFilePath);
      ref.memoryKey = sanitizedMemoryKey;
      ref.folder = memoryFolder;
      ref.title =
        typeof args.memoryTitle === 'string'
          ? args.memoryTitle
          : String(parsed?.frontmatter?.title || toTitle(sanitizedMemoryKey));
    }

    if (!ref.sessionId && !ref.memoryKey) {
      return toolResult(
        { success: false, error: 'Provide either sessionId+turnId or memoryKey' },
        true,
      );
    }

    await themeManager.addThemeAssociation(theme, ref);
    return toolResult({ success: true, theme: sanitizeKey(theme), ref });
  }

  async function handleTraceTheme(args: TraceThemeArgs) {
    const theme = args.theme;
    if (!theme || typeof theme !== 'string') {
      return toolResult({ found: false, error: 'Missing or invalid "theme"' }, true);
    }

    const association = themeManager.loadTheme(theme);
    if (!association) {
      return toolResult({ found: false, theme });
    }

    association.turns.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );
    association.memories.sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
    );

    const includeContent = args.includeTurnContent === true;
    const result = {
      found: true,
      theme: association.theme,
      displayName: association.displayName || association.theme,
      createdAt: association.createdAt,
      updatedAt: association.updatedAt,
      turnCount: association.turns.length,
      memoryCount: association.memories.length,
      turns: association.turns,
      memories: association.memories,
    };

    if (includeContent && association.turns.length > 0) {
      const loadedTurns = [];
      const allSessions = findAllWorkspaceSessions();
      const sessionById = new Map(allSessions.map((s) => [s.sessionId, s]));

      for (const ref of association.turns) {
        if (!ref.sessionId || ref.turnId === undefined) continue;
        try {
          const refinedTurns = refinedManager.loadRefinedTurns(ref.sessionId);
          const refined = refinedTurns.find((t) => String(t.turnId) === String(ref.turnId));

          const session = sessionById.get(ref.sessionId);
          let fullTurn = null;
          if (session) {
            const { turns } = await parseWireFile(session.wire);
            fullTurn = turns.find((t) => String(t.turnId) === String(ref.turnId));
          }

          loadedTurns.push({
            ...ref,
            refined: refined || null,
            content: fullTurn
              ? {
                  user: fullTurn.user,
                  agent: fullTurn.agentText || (fullTurn as { agent?: string }).agent,
                  timestamp: fullTurn.timestamp,
                  actions: fullTurn.actions,
                }
              : null,
          });
        } catch (err) {
          loadedTurns.push({
            ...ref,
            content: null,
            refined: null,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      result.turns = loadedTurns;
    }

    return toolResult(result);
  }

  function handleListThemes() {
    return toolResult({ themes: themeManager.listThemes() });
  }

  async function handleRefineSessionTurns(args: RefineSessionTurnsArgs) {
    let session = null;
    const requestedSessionId = args.sessionId || args.session_id;
    if (requestedSessionId) {
      const allSessions = findAllWorkspaceSessions();
      session = allSessions.find((s) => s.sessionId === requestedSessionId);
      if (!session) {
        return toolResult({ success: false, error: 'Session not found' }, true);
      }
    }
    if (!session) {
      const { getCurrentSessionWirePath } = await import('../context/wire-context.js');
      session = getCurrentSessionWirePath();
    }
    if (!session) {
      return toolResult({ success: false, error: 'No session wire found' }, true);
    }

    const { turns } = await parseWireFile(session.wire);

    let targetTurnIds = null;
    if (Array.isArray(args.turnIds) && args.turnIds.length > 0) {
      targetTurnIds = new Set(args.turnIds.map((id) => parseInt(String(id), 10)));
    }

    let targetTurns = turns;
    if (targetTurnIds) {
      targetTurns = turns.filter((t) => targetTurnIds.has(parseInt(t.turnId, 10)));
    }

    const limit = typeof args.limit === 'number' ? Math.max(0, Math.floor(args.limit)) : null;
    if (limit !== null && targetTurns.length > limit) {
      targetTurns = limit === 0 ? [] : targetTurns.slice(-limit);
    }

    const refinedTurns = targetTurns.map((turn) =>
      refinedManager.refineTurn(
        { ...turn, timestamp: turn.timestamp || undefined },
        session.sessionId,
      ),
    );
    await refinedManager.saveRefinedTurns(session.sessionId, refinedTurns);

    return toolResult({
      success: true,
      sessionId: session.sessionId,
      refinedCount: refinedTurns.length,
      outputPath: refinedManager.refinedTurnsPath(session.sessionId),
      sample: refinedTurns.slice(0, 2),
    });
  }

  return {
    handleTagTheme,
    handleTraceTheme,
    handleListThemes,
    handleRefineSessionTurns,
  };
}
