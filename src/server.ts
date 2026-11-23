#!/usr/bin/env node
/**
 * Kimi Code Memory MCP Server
 *
 * A local stdio MCP server providing cross-session memory for Kimi Code CLI.
 * Data is stored as Markdown files; no external database is required.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'fs';
import path from 'path';
import { getStoreRoot } from './config.js';
import { computeWorkspaceId } from './utils/paths.js';
import { WorkspaceJournal } from './utils/workspace-journal.js';
import { BackgroundIndexer } from './background/indexer.js';
import { refineSessionBatch } from './background/refine-batch.js';
import { findAllWorkspaceSessions } from './context/wire-context.js';
import { IndexDao } from './dao/index.js';
import { MemoryStore } from './dao/memory-store.js';
import { ThemeManager } from './theme-manager.js';
import { RefinedManager } from './refined-manager.js';
import { createTools } from './tools/index.js';
import { prompts, getPrompt } from './prompts/index.js';
import { createResources } from './resources/index.js';
import type { Ctx } from './types.js';
import { VERSION } from './version.js';
import { maybeStartVisServer, stopVisServerAsync } from './vis/auto-start.js';

const cwd = process.cwd().replace(/\\/g, '/');
const workspaceId = computeWorkspaceId(cwd);
const storeRoot = path.join(getStoreRoot(), workspaceId);

// Ensure base directories exist.
for (const dir of ['memory', 'notes', 'essence', 'themes', 'refined']) {
  fs.mkdirSync(path.join(storeRoot, dir), { recursive: true });
}

const indexDao = new IndexDao(storeRoot);
const memoryStore = new MemoryStore(storeRoot);
const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
const refinedManager = new RefinedManager(path.join(storeRoot, 'refined'));

const ctx: Ctx = {
  cwd,
  workspaceId,
  storeRoot,
  indexDao,
  memoryStore,
  themeManager,
  refinedManager,
};

const tools = createTools(ctx);
const resources = createResources(ctx);

const server = new Server(
  { name: 'kimi-code-memory', version: VERSION },
  {
    capabilities: {
      tools: {},
      prompts: {},
      resources: { list: true, subscribe: false } as { subscribe: boolean },
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.toolSchemas,
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  try {
    // The SDK exposes the request's abort signal through the handler extras:
    // a cancelled request yields a partial result instead of burning the
    // whole scan budget.
    return await tools.dispatch(
      request.params.name,
      request.params.arguments || {},
      extra?.signal as AbortSignal | undefined,
    );
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            { error: err instanceof Error ? err.message : String(err) },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }
});

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts,
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments || {};
  return getPrompt(name, args);
});

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: resources.resources(),
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
  resources.readResource(request.params.uri),
);

async function main() {
  // Recover the write journal before serving any request: a crash between
  // the Markdown write and the derived updates leaves a `prepared` entry
  // whose derived stores are rebuilt here. The report goes to stderr —
  // never silently swallowed, never mixed into tool results.
  try {
    const journal = new WorkspaceJournal(storeRoot);
    const recovery = await journal.recover(() => indexDao.reconcileIndex());
    for (const item of recovery.recovered) {
      process.stderr.write(
        `[kimi-memory] journal: recovered interrupted ${item.op} (${item.targetPath ?? 'unknown path'})\n`,
      );
    }
    for (const item of recovery.failed) {
      process.stderr.write(
        `[kimi-memory] journal: FAILED to recover ${item.op} (${item.targetPath ?? 'unknown path'}): ${item.reason}\n`,
      );
    }
    for (const item of recovery.corrupt) {
      // Corrupt entries are kept on disk and reported on every startup until
      // a human resolves them — they must never look like "no journal".
      process.stderr.write(
        `[kimi-memory] journal: CORRUPT entry ${item.file} (${item.reason}) — kept for inspection\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[kimi-memory] journal recovery error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Background incremental indexing: drain the refined lag in bounded ticks
  // so interactive searches never have to refine the whole history inline.
  // The session list comes from the workspace-scoped discovery, so the
  // indexer never touches another workspace's sessions.
  // Disable with KIMI_MEMORY_BG_INDEX=0 (e.g. in tests).
  if (process.env.KIMI_MEMORY_BG_INDEX !== '0') {
    const indexer = new BackgroundIndexer(
      path.join(storeRoot, 'refined'),
      () =>
        findAllWorkspaceSessions().map((s) => ({
          sessionId: s.sessionId,
          wire: s.wire,
          mtime: s.mtime ?? 0,
        })),
      (session, budget, signal) => refineSessionBatch(ctx, session, budget, signal),
      {
        intervalMs: Number(process.env.KIMI_MEMORY_BG_INTERVAL_MS) || 60_000,
        budgetTurns: Number(process.env.KIMI_MEMORY_BG_BUDGET) || 200,
      },
    );
    indexer.start();
    backgroundIndexer = indexer;
  }

  const visResult = await maybeStartVisServer(ctx);
  if (visResult.started && visResult.url) {
    if (visResult.reused) {
      process.stderr.write(
        `[kimi-memory] vis dashboard already running at ${visResult.url}; reusing it\n`,
      );
    } else {
      process.stderr.write(`[kimi-memory] vis dashboard ready at ${visResult.url}\n`);
      try {
        const { default: openBrowser } = await import('open');
        await openBrowser(visResult.browserUrl || visResult.url);
      } catch {
        // Browser may not be available in headless/server environments; ignore.
      }
    }
  } else if (visResult.error) {
    process.stderr.write(`[kimi-memory] vis dashboard failed to start: ${visResult.error}\n`);
  }

  // When the parent (Kimi Code CLI / MCP client) is killed, the stdio pipe
  // closes. Listen for stdin end/close so we can shut down the dashboard and
  // exit cleanly instead of becoming an orphan process.
  process.stdin.on('end', gracefulShutdown);
  process.stdin.on('close', gracefulShutdown);
}

let shuttingDown = false;
let backgroundIndexer: BackgroundIndexer | null = null;

async function gracefulShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    backgroundIndexer?.stop();
    await stopVisServerAsync();
    refinedManager.close();
    await server.close();
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => void gracefulShutdown());
process.on('SIGTERM', () => void gracefulShutdown());

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
