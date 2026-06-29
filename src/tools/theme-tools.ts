/**
 * Theme tracing tools: tag_theme, trace_theme, list_themes, refine_session_turns.
 */

import fs from 'fs';
import path from 'path';
import type { Ctx, RefineSessionTurnsArgs, TagThemeArgs, TraceThemeArgs } from '../types.js';
import type { ToolDefinition } from './types.js';
import { adaptHandler } from './types.js';
import { sanitizeFolder, sanitizeKey, toTitle } from '../utils/validation.js';
import { toolResult } from '../utils/tools.js';
import { safeParseFile } from '../utils/file-helpers.js';
import { findAllWorkspaceSessions, parseWireFile } from '../context/wire-context.js';

export function createThemeTools(ctx: Ctx): ToolDefinition[] {
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
      outputPath: refinedManager.getDbPath(),
      sample: refinedTurns.slice(0, 2),
    });
  }

  const tools: ToolDefinition[] = [
    {
      name: 'tag_theme',
      description:
        '仔细分析 turn 内容与 theme 确定相关后，将 turn 挂载到 theme。禁止仅凭关键词匹配挂载；必须确认内容 genuinely belongs to the theme 才可关联。如果 theme 不存在会自动创建。',
      inputSchema: {
        type: 'object',
        properties: {
          theme: {
            type: 'string',
            description: 'Theme identifier. A theme is a semantic group, not a keyword tag.',
          },
          sessionId: {
            type: 'string',
            description: 'Optional session id of a conversation turn to attach',
          },
          turnId: { type: 'number', description: 'Optional turn id within the session' },
          memoryKey: { type: 'string', description: 'Optional memory key to attach' },
          memoryFolder: { type: 'string', description: 'Optional memory folder (default: memory)' },
          memoryTitle: {
            type: 'string',
            description: 'Optional display title for the memory reference',
          },
        },
        required: ['theme'],
      },
      handler: adaptHandler(handleTagTheme),
    },
    {
      name: 'trace_theme',
      description:
        'Trace the evolution of a theme across sessions and memories. Returns associated turns and memories sorted by time.',
      inputSchema: {
        type: 'object',
        properties: {
          theme: { type: 'string', description: 'Theme identifier' },
          includeTurnContent: {
            type: 'boolean',
            description: 'If true, load full turn content from wire.jsonl (default: false)',
          },
        },
        required: ['theme'],
      },
      handler: adaptHandler(handleTraceTheme),
    },
    {
      name: 'list_themes',
      description: 'List all theme identifiers stored in the current workspace.',
      inputSchema: { type: 'object', properties: {} },
      handler: adaptHandler(handleListThemes),
    },
    {
      name: 'refine_session_turns',
      description:
        'Read a session wire.jsonl and generate Refined Turn Summaries. Output is written to refined/<sessionId>.jsonl.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: {
            type: 'string',
            description: 'Session identifier (default: current session)',
          },
          session_id: { type: 'string', description: 'Alias for sessionId' },
          turnIds: {
            type: 'array',
            items: { type: 'number' },
            description: 'Optional list of turnIds to refine',
          },
          limit: {
            type: 'number',
            description: 'Optional limit: refine only the most recent N turns',
          },
        },
      },
      handler: adaptHandler(handleRefineSessionTurns),
    },
  ];

  return tools;
}
