/**
 * Setup / teardown helpers for integrating the MCP server with Kimi Code CLI.
 *
 * This module modifies the user's Kimi Code home directory:
 *   - ~/.kimi-code/AGENTS.md      (injected memory protocol block)
 *   - ~/.kimi-code/skills/memory-manage
 *   - ~/.kimi-code/mcp.json       (kimi-memory server entry)
 *
 * All modifications are guarded by backup + marked injection blocks so they
 * can be undone later.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const INJECT_START = '<!-- KIMI-MEMORY-INJECTED-START -->';
const INJECT_END = '<!-- KIMI-MEMORY-INJECTED-END -->';

export interface SetupResult {
  kimiCodeHome: string;
  agentsMdPath: string;
  skillPath: string;
  mcpJsonPath: string;
  actions: string[];
  warnings: string[];
}

export interface SetupOptions {
  /** Preview changes without writing anything. */
  dryRun?: boolean;
  /** Overwrite existing skill / mcp.json entry without prompting. */
  force?: boolean;
  /** Remove injected blocks instead of adding them. */
  undo?: boolean;
  /** Override the detected Kimi Code home directory. */
  kimiCodeHome?: string;
}

function getKimiCodeHome(options: SetupOptions): string {
  if (options.kimiCodeHome) return path.resolve(options.kimiCodeHome);
  const fromEnv = process.env.KIMI_CODE_HOME;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.kimi-code');
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function readText(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function writeText(p: string, content: string, dryRun: boolean): void {
  if (dryRun) return;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function backupFile(p: string, dryRun: boolean): void {
  if (dryRun || !fileExists(p)) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${p}.bak.${timestamp}`;
  fs.copyFileSync(p, backupPath);
}

function getPackageRoot(): string {
  // __dirname in dist/ points to dist/, package root is one level up.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

import { fileURLToPath } from 'url';

/**
 * Inject or replace the marked block in AGENTS.md.
 */
function updateAgentsMd(agentsPath: string, injectedContent: string, options: SetupOptions): string {
  const dryRun = !!options.dryRun;
  const undo = !!options.undo;
  const existing = readText(agentsPath) ?? '';

  const startIdx = existing.indexOf(INJECT_START);
  const endIdx = existing.indexOf(INJECT_END);

  let newContent: string;

  if (undo) {
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
      return 'No injected block found; nothing to undo.';
    }
    // Remove the block plus surrounding blank lines.
    const before = existing.slice(0, startIdx).replace(/\n+\s*$/, '');
    const after = existing.slice(endIdx + INJECT_END.length).replace(/^\s*\n+/, '');
    newContent = before ? before + '\n\n' + after : after;
    if (!dryRun) backupFile(agentsPath, dryRun);
    writeText(agentsPath, newContent, dryRun);
    return 'Removed injected memory protocol block.';
  }

  const block = [
    INJECT_START,
    '<!-- 以下内容由 kimi-code-memory-mcp-server 自动生成，请勿手动编辑此区块。 -->',
    '<!-- 如需更新或移除，请运行 npx kimi-code-memory-mcp-server setup --undo -->',
    injectedContent.trim(),
    INJECT_END,
  ].join('\n');

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing block.
    newContent = existing.slice(0, startIdx) + block + existing.slice(endIdx + INJECT_END.length);
    if (!dryRun) backupFile(agentsPath, dryRun);
    writeText(agentsPath, newContent, dryRun);
    return 'Updated existing injected memory protocol block.';
  }

  // No existing block: prepend to file.
  const separator = existing.trim() ? '\n\n' : '';
  newContent = block + separator + existing;
  if (!dryRun) backupFile(agentsPath, dryRun);
  writeText(agentsPath, newContent, dryRun);
  return 'Injected memory protocol block at the top of AGENTS.md.';
}

/**
 * Copy the bundled skill into the user's Kimi Code skills directory.
 */
function installSkill(skillTarget: string, options: SetupOptions): string {
  const dryRun = !!options.dryRun;
  const force = !!options.force;
  const undo = !!options.undo;

  if (undo) {
    if (!fileExists(skillTarget)) return 'Skill not installed; nothing to undo.';
    if (!dryRun) fs.rmSync(skillTarget, { recursive: true, force: true });
    return 'Removed memory-manage skill.';
  }

  if (fileExists(skillTarget) && !force) {
    return 'Skill already exists; use --force to overwrite.';
  }

  const source = path.join(getPackageRoot(), 'skills', 'memory-manage');
  if (!fileExists(source)) {
    throw new Error(`Bundled skill not found at ${source}`);
  }

  if (!dryRun) {
    fs.rmSync(skillTarget, { recursive: true, force: true });
    fs.cpSync(source, skillTarget, { recursive: true });
  }
  return force ? 'Replaced memory-manage skill.' : 'Installed memory-manage skill.';
}

/**
 * Add or remove the kimi-memory MCP server entry in mcp.json.
 */
function updateMcpJson(mcpPath: string, options: SetupOptions): string {
  const dryRun = !!options.dryRun;
  const undo = !!options.undo;

  let config: { mcpServers?: Record<string, unknown> } = {};
  const existingText = readText(mcpPath);
  if (existingText) {
    try {
      config = JSON.parse(existingText);
      if (typeof config !== 'object' || config === null) config = {};
    } catch {
      throw new Error(`Existing ${mcpPath} is not valid JSON.`);
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  if (undo) {
    if (!Object.prototype.hasOwnProperty.call(config.mcpServers, 'kimi-memory')) {
      return 'kimi-memory MCP server entry not found; nothing to undo.';
    }
    delete config.mcpServers['kimi-memory'];
    if (!dryRun) writeText(mcpPath, JSON.stringify(config, null, 2) + '\n', dryRun);
    return 'Removed kimi-memory MCP server entry.';
  }

  const serverEntry = {
    command: 'npx',
    args: ['-y', 'kimi-code-memory-mcp-server'],
    enabled: true,
  };

  const hadEntry = Object.prototype.hasOwnProperty.call(config.mcpServers, 'kimi-memory');
  config.mcpServers['kimi-memory'] = serverEntry;

  if (!dryRun) writeText(mcpPath, JSON.stringify(config, null, 2) + '\n', dryRun);
  return hadEntry ? 'Updated kimi-memory MCP server entry.' : 'Added kimi-memory MCP server entry.';
}

/**
 * Run setup or teardown.
 */
export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const kimiCodeHome = getKimiCodeHome(options);
  const agentsMdPath = path.join(kimiCodeHome, 'AGENTS.md');
  const skillPath = path.join(kimiCodeHome, 'skills', 'memory-manage');
  const mcpJsonPath = path.join(kimiCodeHome, 'mcp.json');

  const actions: string[] = [];
  const warnings: string[] = [];

  if (!fileExists(kimiCodeHome)) {
    warnings.push(`Kimi Code home not found at ${kimiCodeHome}. Is Kimi Code CLI installed?`);
  }

  // AGENTS.md
  const injectedSource = path.join(getPackageRoot(), 'assets', 'user-agents.md');
  const injectedContent = readText(injectedSource);
  if (!injectedContent) {
    throw new Error(`Bundled user-agents.md template not found at ${injectedSource}`);
  }
  actions.push(updateAgentsMd(agentsMdPath, injectedContent, options));

  // Skill
  actions.push(installSkill(skillPath, options));

  // mcp.json
  actions.push(updateMcpJson(mcpJsonPath, options));

  return {
    kimiCodeHome,
    agentsMdPath,
    skillPath,
    mcpJsonPath,
    actions,
    warnings,
  };
}
