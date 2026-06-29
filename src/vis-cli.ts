#!/usr/bin/env node
/**
 * CLI entry point for `npx kimi-memory-vis`.
 *
 * Launches a local web dashboard that visualizes the workspace memory.
 */

import fs from 'fs';
import path from 'path';
import open from 'open';
import { getStoreRoot } from './config.js';
import { computeWorkspaceId } from './utils/paths.js';
import { IndexDao } from './dao/index.js';
import { MemoryStore } from './dao/memory-store.js';
import { ThemeManager } from './theme-manager.js';
import { RefinedManager } from './refined-manager.js';
import { startVisServer } from './vis/server.js';
import type { Ctx } from './types.js';

const MCP_SERVER_PORT = 58627;
const DEFAULT_VIS_PORT = 58628;

function parseArgs(argv: string[]) {
  let port = DEFAULT_VIS_PORT;
  let openBrowser = true;
  let workspaceOverride: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') {
      const next = argv[++i];
      if (next) {
        const parsed = parseInt(next, 10);
        if (!isNaN(parsed)) port = parsed;
      }
    } else if (arg === '--no-open') {
      openBrowser = false;
    } else if (arg === '--workspace' || arg === '-w') {
      const next = argv[++i];
      if (next) workspaceOverride = next;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { port, openBrowser, workspaceOverride };
}

function printHelp() {
  console.log(`kimi-memory-vis — Visualize your workspace memory.

Usage:
  npx kimi-memory-vis [options]

Options:
  --port <number>     Port to run the dashboard on (default: ${DEFAULT_VIS_PORT})
  --no-open           Do not open the browser automatically
  --workspace <path>  Use a different workspace directory instead of the current one
  -h, --help          Show this help message
`);
}

function resolveWorkspace(args: { workspaceOverride?: string }): {
  cwd: string;
  workspaceId: string;
  storeRoot: string;
} {
  const cwd = args.workspaceOverride
    ? path.resolve(args.workspaceOverride).replace(/\\/g, '/')
    : process.cwd().replace(/\\/g, '/');
  const workspaceId = computeWorkspaceId(cwd);
  const storeRoot = path.join(getStoreRoot(), workspaceId);
  return { cwd, workspaceId, storeRoot };
}

async function detectMcpServer(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 500);
    const res = await fetch(`http://127.0.0.1:${port}`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

function createContext(cwd: string, workspaceId: string, storeRoot: string): Ctx {
  for (const dir of ['memory', 'notes', 'essence', 'themes', 'refined']) {
    fs.mkdirSync(path.join(storeRoot, dir), { recursive: true });
  }

  const indexDao = new IndexDao(storeRoot);
  const memoryStore = new MemoryStore(storeRoot);
  const themeManager = new ThemeManager(path.join(storeRoot, 'themes'));
  const refinedManager = new RefinedManager(path.join(storeRoot, 'refined'));

  return {
    cwd,
    workspaceId,
    storeRoot,
    indexDao,
    memoryStore,
    themeManager,
    refinedManager,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { cwd, workspaceId, storeRoot } = resolveWorkspace(args);

  if (!fs.existsSync(storeRoot)) {
    fs.mkdirSync(storeRoot, { recursive: true });
  }

  const ctx = createContext(cwd, workspaceId, storeRoot);
  await ctx.indexDao.reconcileIndex();

  const mcpRunning = await detectMcpServer(MCP_SERVER_PORT);

  const server = startVisServer({
    ctx,
    port: args.port,
    hostname: '127.0.0.1',
    onReady: (url) => {
      console.log(`\n  kimi-memory-vis running at ${url}`);
      console.log(`  Workspace: ${cwd}`);
      console.log(`  Store:     ${storeRoot}`);
      if (mcpRunning) {
        console.log(`  MCP server detected at http://127.0.0.1:${MCP_SERVER_PORT}`);
      }
      if (args.openBrowser) {
        open(url).catch((err) => {
          console.error(`  Could not open browser: ${err.message}`);
        });
      }
    },
  });

  process.on('SIGINT', () => {
    console.log('\n  Shutting down...');
    ctx.refinedManager.close();
    server.close(() => process.exit(0));
  });

  process.on('SIGTERM', () => {
    ctx.refinedManager.close();
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
