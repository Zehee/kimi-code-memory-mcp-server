#!/usr/bin/env node
/**
 * CLI entry for kimi-code-memory-mcp-server setup.
 *
 * Usage:
 *   npx kimi-code-memory-mcp-server setup
 *   npx kimi-code-memory-mcp-server setup --undo
 *   npx kimi-code-memory-mcp-server setup --dry-run
 *   npx kimi-code-memory-mcp-server setup --kimi-code-home /path/to/.kimi-code
 */

import { runSetup, type SetupOptions } from './setup.js';

function parseArgs(argv: string[]): SetupOptions {
  const options: SetupOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--force':
        options.force = true;
        break;
      case '--undo':
        options.undo = true;
        break;
      case '--kimi-code-home':
        options.kimiCodeHome = argv[++i];
        break;
      case '--help':
      case '-h':
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown option: ${arg}`);
          printHelp();
          process.exit(1);
        }
        break;
    }
  }
  return options;
}

function printHelp(): void {
  console.log(`kimi-code-memory-mcp-server setup

Integrates the MCP server with Kimi Code CLI by updating:
  - ~/.kimi-code/AGENTS.md
  - ~/.kimi-code/skills/memory-manage
  - ~/.kimi-code/mcp.json

Options:
  --dry-run            Preview changes without writing files
  --force              Overwrite existing skill without prompting
  --undo               Remove injected configuration
  --kimi-code-home <p> Use a custom Kimi Code home directory
  --help, -h           Show this help
`);
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const result = await runSetup(options);

  console.log(`Kimi Code home: ${result.kimiCodeHome}`);
  console.log(`AGENTS.md:      ${result.agentsMdPath}`);
  console.log(`Skill:          ${result.skillPath}`);
  console.log(`mcp.json:       ${result.mcpJsonPath}`);
  console.log('');

  for (const action of result.actions) {
    console.log(`✓ ${action}`);
  }

  if (result.warnings.length > 0) {
    console.log('');
    console.log('Warnings:');
    for (const warning of result.warnings) {
      console.log(`⚠ ${warning}`);
    }
  }
}

main().catch((err) => {
  console.error('Setup failed:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
