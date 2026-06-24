/**
 * Tool registry: schemas and dispatch.
 */

import { createMemoryTools } from './memory-tools.js';
import { createContextTools } from './context-tools.js';
import { createThemeTools } from './theme-tools.js';
import { createSystemTools } from './system-tools.js';

export function createTools(ctx) {
  const memory = createMemoryTools(ctx);
  const context = createContextTools(ctx);
  const theme = createThemeTools(ctx);
  const system = createSystemTools(ctx);

  const handlers = {
    remember: memory.handleRemember,
    recall: memory.handleRecall,
    recall_recent: memory.handleRecallRecent,
    search: memory.handleSearch,
    list_tags: memory.handleListTags,
    list: memory.handleList,
    delete: memory.handleDelete,
    move: memory.handleMove,

    load_workspace_context: context.handleLoadWorkspaceContext,
    load_more_context: context.handleLoadMoreContext,
    search_context: context.handleSearchContext,
    load_turn_context: context.handleLoadTurnContext,

    tag_theme: theme.handleTagTheme,
    trace_theme: theme.handleTraceTheme,
    list_themes: theme.handleListThemes,
    refine_session_turns: theme.handleRefineSessionTurns,

    get_current_workspace: system.handleGetCurrentWorkspace,
    organize_memories: system.handleOrganize,
    sync_workspace_index: system.handleSyncWorkspaceIndex,
    bootstrap_workspace: system.handleBootstrapWorkspace,
  };

  const toolSchemas = [
    {
      name: 'remember',
      description: 'Write or overwrite a memory entry as a Markdown file with YAML frontmatter.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Unique identifier used as filename base' },
          content: { type: 'string', description: 'Markdown body content' },
          folder: {
            type: 'string',
            description: 'Subfolder under the workspace (default: memory)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Tags stored in YAML frontmatter',
          },
          themes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional theme names to associate with this memory',
          },
        },
        required: ['key'],
      },
    },
    {
      name: 'recall',
      description: 'Read a memory entry by key and folder.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key' },
          folder: { type: 'string', description: 'Subfolder (default: memory)' },
        },
        required: ['key'],
      },
    },
    {
      name: 'recall_recent',
      description: 'Return the most recently updated memory entries, optionally filtered.',
      inputSchema: {
        type: 'object',
        properties: {
          n: { type: 'number', description: 'Maximum number of entries to return (default: 10)' },
          folder: { type: 'string', description: 'Filter to a specific subfolder' },
          tag: { type: 'string', description: 'Filter to entries containing this tag' },
        },
      },
    },
    {
      name: 'search',
      description: 'Case-insensitive keyword search across memory titles and contents.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword to search' },
          folder: { type: 'string', description: 'Limit search to a subfolder' },
        },
        required: ['query'],
      },
    },
    {
      name: 'list_tags',
      description: 'List all tags used in the current workspace.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'get_current_workspace',
      description: 'Return the current cwd, workspace id and store path.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'load_workspace_context',
      description:
        'Load the workspace context for session resumption: recent conversation parsed from the active wire.jsonl.',
      inputSchema: {
        type: 'object',
        properties: {
          detailed_rounds: {
            type: 'number',
            description: 'Number of most recent rounds to return in full detail.',
          },
          summary_rounds: {
            type: 'number',
            description: 'Number of preceding rounds to return as summaries.',
          },
        },
      },
    },
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
    },
    {
      name: 'search_context',
      description:
        'Search conversation rounds across all workspace session wires by keywords and optional date range.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keywords to search for in conversation rounds' },
          date_from: { type: 'string', description: 'Optional start date in YYYY-MM-DD format' },
          date_to: { type: 'string', description: 'Optional end date in YYYY-MM-DD format' },
          limit: { type: 'number', description: 'Maximum number of matching rounds to return' },
        },
        required: ['query'],
      },
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
    },
    {
      name: 'list',
      description: 'List all memory entries in the workspace, optionally filtered by folder.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Filter to a specific subfolder' },
        },
      },
    },
    {
      name: 'delete',
      description: 'Delete a memory entry by key and folder.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key' },
          folder: { type: 'string', description: 'Subfolder (default: memory)' },
        },
        required: ['key'],
      },
    },
    {
      name: 'move',
      description: 'Move a memory entry to another folder, optionally renaming it.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key' },
          folder: { type: 'string', description: 'Source subfolder (default: memory)' },
          toFolder: { type: 'string', description: 'Destination subfolder' },
          newKey: { type: 'string', description: 'Optional new key to rename the memory' },
        },
        required: ['key', 'toFolder'],
      },
    },
    {
      name: 'organize_memories',
      description:
        'Two-stage workspace memory organizer. Empty call returns existing essence + pending memory files + rules. Call with content to store the organized essence.md.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description:
              'Organized essence Markdown body. Key facts should cite sources inline using `> 来源：memory/<folder>/key`.',
          },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Optional list of memory/ keys incorporated into the essence, returned in the tool result for tracking.',
          },
        },
      },
    },
    {
      name: 'sync_workspace_index',
      description:
        'Reconciles index.json with the filesystem. Empty call scans and reports mismatches. Call with folderComments to set folder descriptions.',
      inputSchema: {
        type: 'object',
        properties: {
          folderComments: {
            type: 'object',
            description: 'Optional map of folder paths to comments.',
          },
        },
      },
    },
    {
      name: 'bootstrap_workspace',
      description:
        'Session bootstrap: loads workspace context, essence, notes refs, and a memory index tree with recent changes marked [new].',
      inputSchema: {
        type: 'object',
        properties: {
          detailed_rounds: {
            type: 'number',
            description: 'Number of most recent rounds to return in full detail.',
          },
          summary_rounds: {
            type: 'number',
            description: 'Number of preceding rounds to return as summaries.',
          },
        },
      },
    },
    {
      name: 'tag_theme',
      description:
        'Associate a conversation turn or an existing memory with a theme. Creates the theme file if it does not exist.',
      inputSchema: {
        type: 'object',
        properties: {
          theme: { type: 'string', description: 'Theme identifier' },
          sessionId: { type: 'string', description: 'Optional session id of a conversation turn' },
          turnId: { type: 'number', description: 'Optional turn id within the session' },
          memoryKey: { type: 'string', description: 'Optional memory key to associate' },
          memoryFolder: { type: 'string', description: 'Optional memory folder (default: memory)' },
          memoryTitle: {
            type: 'string',
            description: 'Optional display title for the memory reference',
          },
        },
        required: ['theme'],
      },
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
    },
    {
      name: 'list_themes',
      description: 'List all theme identifiers stored in the current workspace.',
      inputSchema: { type: 'object', properties: {} },
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
    },
  ];

  function dispatch(name, args = {}) {
    const handler = handlers[name];
    if (!handler) {
      return Promise.resolve({
        content: [
          { type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }, null, 2) },
        ],
        isError: true,
      });
    }
    return Promise.resolve(handler(args));
  }

  return { toolSchemas, dispatch };
}
