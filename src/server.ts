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
import { IndexDao } from './dao/index.js';
import { MemoryStore } from './dao/memory-store.js';
import { ThemeManager } from './theme-manager.js';
import { RefinedManager } from './refined-manager.js';
import { createTools } from './tools/index.js';
import { prompts, getPrompt } from './prompts/index.js';
import { createResources } from './resources/index.js';
import type { Ctx } from './types.js';
import { VERSION } from './version.js';
import { maybeStartVisServer, stopVisServer } from './vis/auto-start.js';

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

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    return await tools.dispatch(request.params.name, request.params.arguments || {});
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2),
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
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const visResult = await maybeStartVisServer(ctx);
  if (visResult.started && visResult.url) {
    process.stderr.write(`[kimi-memory] vis dashboard ready at ${visResult.url}\n`);
    try {
      const { default: openBrowser } = await import('open');
      await openBrowser(visResult.url);
    } catch {
      // Browser may not be available in headless/server environments; ignore.
    }
  } else if (visResult.error) {
    process.stderr.write(`[kimi-memory] vis dashboard failed to start: ${visResult.error}\n`);
  }
}

process.on('SIGINT', () => {
  stopVisServer();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopVisServer();
  process.exit(0);
});

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Fatal error: ${message}\n`);
  process.exit(1);
});
