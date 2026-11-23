/**
 * Setup / teardown helpers for integrating the MCP server with Kimi Code CLI.
 *
 * This module modifies the user's Kimi Code home directory:
 *   - ~/.kimi-code/AGENTS.md      (injected memory protocol block)
 *   - ~/.kimi-code/skills/memory-manage
 *   - ~/.kimi-code/mcp.json       (kimi-memory server entry)
 *
 * Installation is reversible:
 *   1. preflight   — validate every target and detect ownership conflicts
 *   2. plan        — describe every intended change (also used by --dry-run)
 *   3. backup      — copy the original state of every touched target
 *   4. apply       — write each target atomically
 *   5. manifest    — record ownership, hashes and backup locations
 *
 * Any failure during step 4 rolls every already-applied step back in reverse
 * order, restoring the original user configuration (including files that did
 * not exist before the install).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { atomicWriteFile } from './utils/paths.js';

const INJECT_START = '<!-- KIMI-MEMORY-INJECTED-START -->';
const INJECT_END = '<!-- KIMI-MEMORY-INJECTED-END -->';
const INJECT_COMMENT_LINES = [
  '<!-- 以下内容由 kimi-code-memory-mcp-server 自动生成，请勿手动编辑此区块。 -->',
  '<!-- 如需更新或移除，请运行 kimi-memory-setup --undo -->',
];

const MCP_SERVER_KEY = 'kimi-memory';
const SETUP_DIR_NAME = 'memory-setup';
const MANIFEST_FILE_NAME = 'manifest.json';
const BACKUP_DIR_NAME = 'backups';
const MANIFEST_SCHEMA_VERSION = 1;

export type SetupStepKind = 'agents-md' | 'skill' | 'mcp-entry';

export type SetupStepAction =
  | 'create'
  | 'update'
  | 'replace'
  | 'remove'
  | 'restore'
  | 'skip'
  | 'conflict'
  | 'keep';

export interface SetupStep {
  kind: SetupStepKind;
  /** Absolute path of the affected file or directory. */
  target: string;
  action: SetupStepAction;
  /** Human readable, content-free description of the change. */
  detail: string;
}

export interface SetupConflict {
  kind: SetupStepKind;
  target: string;
  reason: string;
}

export interface SetupOptions {
  /** Preview changes without writing anything. */
  dryRun?: boolean;
  /** Overwrite existing non-owned skill / mcp.json entry without prompting. */
  force?: boolean;
  /** Remove injected blocks instead of adding them. */
  undo?: boolean;
  /** Override the detected Kimi Code home directory. */
  kimiCodeHome?: string;
  /** Delete previously created backups without touching the current install. */
  purgeBackups?: boolean;
  /**
   * Where the memory protocol block goes:
   *
   * - `global` (default): `~/.kimi-code/AGENTS.md` — affects every workspace.
   * - `workspace`: `AGENTS.md` in the current working directory — a team can
   *   opt a single project in (checked into version control) without
   *   touching every other project on the machine.
   */
  scope?: 'global' | 'workspace';
  /**
   * Test seam. Throwing from this hook aborts the operation and triggers the
   * rollback of every already applied step.
   */
  fault?: (op: string) => void;
}

export interface SetupResult {
  kimiCodeHome: string;
  agentsMdPath: string;
  skillPath: string;
  mcpJsonPath: string;
  manifestPath: string;
  actions: string[];
  warnings: string[];
  steps: SetupStep[];
  conflicts: SetupConflict[];
  dryRun: boolean;
}

export interface ManifestEntry {
  kind: SetupStepKind;
  /** Absolute path of the managed target. */
  targetPath: string;
  /** Whether the target existed before this tool installed it. */
  existedBefore: boolean;
  /** Hash of the target content before the install (null when it did not exist). */
  previousHash: string | null;
  /** Hash of the content installed by this tool (file / directory / mcp entry). */
  installedHash: string | null;
  /** Hash of the whole target file after the install (mcp.json only). */
  installedFileHash: string | null;
  /** Absolute path of the backup taken before the install. */
  backupPath: string | null;
  /** Hash of the injected AGENTS.md block (agents-md only). */
  injectedBlockHash: string | null;
  /** MCP server key owned by this tool (mcp-entry only). */
  mcpEntryKey: string | null;
  /**
   * `exact`   — an undo may restore the whole original target from the backup.
   * `surgical` — the target changed after the install, so an undo may only
   *              remove the part this tool owns.
   */
  originalMode: 'exact' | 'surgical';
  installedAt: string;
}

export interface SetupManifest {
  schemaVersion: number;
  tool: string;
  kimiCodeHome: string;
  updatedAt: string;
  entries: ManifestEntry[];
}

export class SetupConflictError extends Error {
  conflicts: SetupConflict[];

  constructor(conflicts: SetupConflict[]) {
    const summary = conflicts.map((c) => `${c.kind} -> ${c.target}: ${c.reason}`).join('; ');
    super(`Setup refused to continue because of ${conflicts.length} conflict(s): ${summary}`);
    this.name = 'SetupConflictError';
    this.conflicts = conflicts;
  }
}

// ---------------------------------------------------------------------------
// low level helpers
// ---------------------------------------------------------------------------

function getKimiCodeHome(options: SetupOptions): string {
  if (options.kimiCodeHome) return path.resolve(options.kimiCodeHome);
  const fromEnv = process.env.KIMI_CODE_HOME;
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.homedir(), '.kimi-code');
}

function getPackageRoot(): string {
  // __dirname in dist/ points to dist/, package root is one level up.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dirExists(p: string): boolean {
  try {
    return fs.existsSync(p) && fs.statSync(p).isDirectory();
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

function sha256(data: string | Buffer): string {
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

/** Stable JSON representation (sorted object keys) used for content hashes. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = canonicalize(source[key]);
    return out;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'undefined';
}

function listRelativeFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, prefix: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) walk(abs, rel);
      else out.push(rel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** Hash of a directory tree: relative path + content hash of every file. */
function hashDirectory(dir: string): string | null {
  if (!dirExists(dir)) return null;
  const hash = crypto.createHash('sha256');
  for (const rel of listRelativeFiles(dir)) {
    hash.update(rel).update('\u0000');
    try {
      hash.update(sha256(fs.readFileSync(path.join(dir, rel))));
    } catch {
      hash.update('unreadable');
    }
    hash.update('\n');
  }
  return 'sha256:' + hash.digest('hex');
}

function writeTextAtomic(target: string, content: string): void {
  atomicWriteFile(target, content);
}

function removePath(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    /* best effort cleanup */
  }
}

/** Remove a directory that became empty, so an undo leaves no empty folders. */
function removeEmptyParent(dir: string): void {
  try {
    if (!dirExists(dir)) return;
    if (fs.readdirSync(dir).length > 0) return;
    fs.rmdirSync(dir);
  } catch {
    /* best effort cleanup */
  }
}

function timestampId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

function manifestDir(kimiCodeHome: string): string {
  return path.join(kimiCodeHome, SETUP_DIR_NAME);
}

function manifestPathFor(kimiCodeHome: string): string {
  return path.join(manifestDir(kimiCodeHome), MANIFEST_FILE_NAME);
}

function backupRootFor(kimiCodeHome: string): string {
  return path.join(manifestDir(kimiCodeHome), BACKUP_DIR_NAME);
}

export function readSetupManifest(kimiCodeHome: string): SetupManifest | null {
  const raw = readText(manifestPathFor(kimiCodeHome));
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as SetupManifest;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeSetupManifest(kimiCodeHome: string, manifest: SetupManifest): void {
  const target = manifestPathFor(kimiCodeHome);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  writeTextAtomic(target, JSON.stringify(manifest, null, 2) + '\n');
}

function findManifestEntry(
  manifest: SetupManifest | null,
  kind: SetupStepKind,
  targetPath?: string,
): ManifestEntry | undefined {
  if (!manifest) return undefined;
  const matches = manifest.entries.filter((entry) => entry.kind === kind);
  if (targetPath) {
    // Several installs can coexist for one kind (global and per-workspace
    // AGENTS.md): prefer the entry for the exact target being modified.
    const exact = matches.filter((entry) => entry.targetPath === targetPath);
    if (exact.length > 0) return exact[exact.length - 1];
  }
  return matches[matches.length - 1];
}

// ---------------------------------------------------------------------------
// AGENTS.md block helpers
// ---------------------------------------------------------------------------

interface InjectedBlock {
  start: number;
  end: number;
  text: string;
}

function findInjectedBlock(text: string): InjectedBlock | null {
  const start = text.indexOf(INJECT_START);
  const end = text.indexOf(INJECT_END);
  if (start === -1 || end === -1 || end < start) return null;
  const endIndex = end + INJECT_END.length;
  return { start, end: endIndex, text: text.slice(start, endIndex) };
}

function buildInjectedBlock(injectedContent: string): string {
  return [INJECT_START, ...INJECT_COMMENT_LINES, injectedContent.trim(), INJECT_END].join('\n');
}

function applyInjectedBlock(existing: string, block: string): string {
  const found = findInjectedBlock(existing);
  if (found) {
    return existing.slice(0, found.start) + block + existing.slice(found.end);
  }
  const separator = existing.trim() ? '\n\n' : '';
  return block + separator + existing;
}

function removeInjectedBlock(existing: string): string {
  const found = findInjectedBlock(existing);
  if (!found) return existing;
  const before = existing.slice(0, found.start).replace(/\n+\s*$/, '');
  const after = existing.slice(found.end).replace(/^\s*\n+/, '');
  if (before && after) return before + '\n\n' + after;
  return before || after;
}

// ---------------------------------------------------------------------------
// mcp.json helpers
// ---------------------------------------------------------------------------

interface McpConfig {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

function parseMcpConfig(text: string, filePath: string): McpConfig {
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Existing ${filePath} is not valid JSON.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Existing ${filePath} is not a JSON object.`);
  }
  return parsed as McpConfig;
}

function getMcpServers(config: McpConfig): Record<string, unknown> {
  const servers = config.mcpServers;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return {};
  return servers as Record<string, unknown>;
}

/**
 * Drop the `mcpServers` key when it became empty, so an undo restores the
 * original shape of the configuration file instead of leaving an empty object.
 */
function withoutEmptyServers(
  config: McpConfig,
  servers: Record<string, unknown>,
): McpConfig {
  const remaining: McpConfig = { ...config };
  if (Object.keys(servers).length > 0) {
    remaining.mcpServers = servers;
  } else {
    delete remaining.mcpServers;
  }
  return remaining;
}

function buildMcpServerEntry(): Record<string, unknown> {
  // Launch the server via the same Node binary running this setup, pointing at
  // the installed package's dist/server.js by absolute path. A bare `npx` entry
  // fails with `spawn npx ENOENT` under clients whose process environment lacks
  // npm's bin dir (e.g. the native Windows binary), and avoids npx registry
  // resolution delay at every startup.
  return {
    command: process.execPath,
    args: [path.join(getPackageRoot(), 'dist', 'server.js')],
    enabled: true,
    deferred: true,
    startupTimeoutMs: 120000,
  };
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

interface InstallContext {
  options: SetupOptions;
  kimiCodeHome: string;
  agentsMdPath: string;
  skillPath: string;
  mcpJsonPath: string;
  manifestPath: string;
  skillSource: string;
  injectedContent: string;
  manifest: SetupManifest | null;
  steps: SetupStep[];
  actions: string[];
  warnings: string[];
  conflicts: SetupConflict[];
}

interface PreparedTarget {
  kind: SetupStepKind;
  target: string;
  /** Whether the target existed before the first installation (undo state). */
  existedBefore: boolean;
  /** Whether the target exists on disk right now (backup / rollback state). */
  existedBeforeRun: boolean;
  previousHash: string | null;
  installedHash: string | null;
  installedFileHash: string | null;
  injectedBlockHash: string | null;
  mcpEntryKey: string | null;
  /** Content that will be written (null for the skill directory). */
  newContent: string | null;
  /** Backup location for the original state. */
  backupPath: string | null;
  /** Whether a fresh backup of the current state must be taken. */
  takeBackup: boolean;
  /** Whether an undo may restore the whole original target. */
  originalMode: 'exact' | 'surgical';
  action: SetupStepAction;
  detail: string;
  /** Short, stable message reported to the caller. */
  message: string;
}

function prepareInstall(ctx: InstallContext): PreparedTarget[] {
  const prepared: PreparedTarget[] = [];
  const priorManifest = ctx.manifest;
  const force = !!ctx.options.force;

  // ---- AGENTS.md ----------------------------------------------------------
  const agentsExisting = readText(ctx.agentsMdPath);
  const agentsExisted = agentsExisting !== null;
  const block = buildInjectedBlock(ctx.injectedContent);
  const existingBlock = agentsExisting === null ? null : findInjectedBlock(agentsExisting);
  const priorAgents = findManifestEntry(priorManifest, 'agents-md', ctx.agentsMdPath);
  const agentsCurrentHash = agentsExisting === null ? null : sha256(agentsExisting);

  let agentsOwned = true;
  let agentsReason = '';
  let agentsOwnedByManifest = false;
  if (existingBlock) {
    const blockHash = sha256(existingBlock.text);
    agentsOwnedByManifest =
      !!priorAgents && !!priorAgents.injectedBlockHash && priorAgents.injectedBlockHash === blockHash;
    const identicalToBundled = blockHash === sha256(block);
    agentsOwned = agentsOwnedByManifest || identicalToBundled;
    if (!agentsOwned) {
      agentsReason =
        'an injected memory protocol block already exists and was not written by this tool';
    }
  }

  const agentsNewContent = applyInjectedBlock(agentsExisting ?? '', block);
  const agentsChanged = agentsNewContent !== (agentsExisting ?? '');
  if (existingBlock && !agentsOwned && !force) {
    ctx.conflicts.push({
      kind: 'agents-md',
      target: ctx.agentsMdPath,
      reason: agentsReason,
    });
  }

  // Ownership bookkeeping: a re-install must not lose the state of the
  // original installation (whether the file existed and where its backup is).
  let agentsExistedBefore = agentsExisted;
  let agentsPreviousHash = agentsCurrentHash;
  let agentsBackupPath: string | null = null;
  let agentsTakeBackup = agentsExisted;
  let agentsMode: 'exact' | 'surgical' = 'exact';

  if (agentsOwnedByManifest && priorAgents) {
    agentsExistedBefore = priorAgents.existedBefore;
    agentsPreviousHash = priorAgents.previousHash;
    agentsBackupPath = priorAgents.backupPath;
    agentsTakeBackup = false;
    agentsMode =
      priorAgents.installedFileHash && priorAgents.installedFileHash === agentsCurrentHash
        ? priorAgents.originalMode ?? 'exact'
        : 'surgical';
  } else if (existingBlock) {
    // A block that this tool did not write (or a legacy install without a
    // manifest): the original content is unknown, so an undo may only remove
    // the block.
    agentsBackupPath = null;
    agentsTakeBackup = false;
    agentsMode = 'surgical';
  }

  prepared.push({
    kind: 'agents-md',
    target: ctx.agentsMdPath,
    existedBefore: agentsExistedBefore,
    existedBeforeRun: agentsExisted,
    previousHash: agentsPreviousHash,
    installedHash: sha256(agentsNewContent),
    installedFileHash: sha256(agentsNewContent),
    injectedBlockHash: sha256(block),
    mcpEntryKey: null,
    newContent: agentsNewContent,
    backupPath: agentsBackupPath,
    takeBackup: agentsTakeBackup,
    originalMode: agentsMode,
    action: !agentsExisted ? 'create' : agentsChanged ? 'update' : 'skip',
    detail: agentsChanged
      ? agentsExisted
        ? 'Inject the memory protocol block into the existing AGENTS.md'
        : 'Create AGENTS.md with the memory protocol block'
      : 'AGENTS.md already contains the current memory protocol block',
    message: existingBlock
      ? 'Updated existing injected memory protocol block.'
      : 'Injected memory protocol block at the top of AGENTS.md.',
  });

  // ---- skill --------------------------------------------------------------
  const skillExisted = dirExists(ctx.skillPath);
  const bundledHash = hashDirectory(ctx.skillSource);
  const currentSkillHash = hashDirectory(ctx.skillPath);
  const priorSkill = findManifestEntry(priorManifest, 'skill');
  const skillOwnedByManifest =
    !!priorSkill && !!priorSkill.installedHash && priorSkill.installedHash === currentSkillHash;
  const skillIdenticalToBundled = !!bundledHash && bundledHash === currentSkillHash;
  const skillOwned = !skillExisted || skillOwnedByManifest || skillIdenticalToBundled;
  if (skillExisted && !skillOwned && !force) {
    ctx.conflicts.push({
      kind: 'skill',
      target: ctx.skillPath,
      reason: 'a skill directory already exists and was not installed by this tool',
    });
  }

  let skillExistedBefore = skillExisted;
  let skillPreviousHash = currentSkillHash;
  let skillBackupPath: string | null = null;
  let skillTakeBackup = skillExisted;
  let skillMode: 'exact' | 'surgical' = 'exact';
  if (skillOwnedByManifest && priorSkill) {
    skillExistedBefore = priorSkill.existedBefore;
    skillPreviousHash = priorSkill.previousHash;
    skillBackupPath = priorSkill.backupPath;
    skillTakeBackup = false;
    skillMode = priorSkill.originalMode ?? 'exact';
    // The skill content changed since our last install (user edited it or a
    // newer version of this tool shipped different content) and this run is
    // about to replace it: take a FRESH backup of the current directory so
    // undo restores the pre-replace state instead of the first-install
    // snapshot (same class of loss as review P1 #1).
    if (currentSkillHash !== null && currentSkillHash !== priorSkill.installedHash) {
      skillTakeBackup = true;
      skillBackupPath = null;
      skillPreviousHash = currentSkillHash;
      skillExistedBefore = true;
      skillMode = 'exact';
    }
  }

  prepared.push({
    kind: 'skill',
    target: ctx.skillPath,
    existedBefore: skillExistedBefore,
    existedBeforeRun: skillExisted,
    previousHash: skillPreviousHash,
    installedHash: bundledHash,
    installedFileHash: bundledHash,
    injectedBlockHash: null,
    mcpEntryKey: null,
    newContent: null,
    backupPath: skillBackupPath,
    takeBackup: skillTakeBackup,
    originalMode: skillMode,
    action: !skillExisted ? 'create' : 'replace',
    detail: skillExisted
      ? 'Replace the memory-manage skill directory'
      : 'Install the memory-manage skill directory',
    message: skillExisted ? 'Replaced memory-manage skill.' : 'Installed memory-manage skill.',
  });

  // ---- mcp.json -----------------------------------------------------------
  const mcpExisting = readText(ctx.mcpJsonPath);
  const mcpExisted = mcpExisting !== null;
  const config = parseMcpConfig(mcpExisting ?? '', ctx.mcpJsonPath);
  const servers = getMcpServers(config);
  const hasEntry = Object.prototype.hasOwnProperty.call(servers, MCP_SERVER_KEY);
  const priorMcp = findManifestEntry(priorManifest, 'mcp-entry');
  const newEntry = buildMcpServerEntry();
  const entryHash = sha256(canonicalJson(newEntry));
  const mcpCurrentHash = mcpExisting === null ? null : sha256(mcpExisting);

  let mcpOwned = true;
  let mcpReason = '';
  if (hasEntry) {
    const currentEntryHash = sha256(canonicalJson(servers[MCP_SERVER_KEY]));
    const ownedByManifest = !!priorMcp && priorMcp.installedHash === currentEntryHash;
    const identicalToBundled = currentEntryHash === entryHash;
    mcpOwned = ownedByManifest || identicalToBundled;
    if (!mcpOwned) {
      mcpReason = `the "${MCP_SERVER_KEY}" MCP server entry already exists and was not written by this tool`;
    }
  }
  if (hasEntry && !mcpOwned && !force) {
    ctx.conflicts.push({
      kind: 'mcp-entry',
      target: ctx.mcpJsonPath,
      reason: mcpReason,
    });
  }

  const nextConfig: McpConfig = { ...config, mcpServers: { ...servers, [MCP_SERVER_KEY]: newEntry } };
  const mcpNewContent = JSON.stringify(nextConfig, null, 2) + '\n';
  const mcpChanged = mcpNewContent !== (mcpExisting ?? '');

  let mcpExistedBefore = mcpExisted;
  let mcpPreviousHash = mcpCurrentHash;
  let mcpBackupPath: string | null = null;
  let mcpTakeBackup = mcpExisted;
  let mcpMode: 'exact' | 'surgical' = 'exact';
  if (priorMcp) {
    mcpExistedBefore = priorMcp.existedBefore;
    mcpPreviousHash = priorMcp.previousHash;
    mcpBackupPath = priorMcp.backupPath;
    mcpTakeBackup = false;
    const fileUnchanged = !!priorMcp.installedFileHash && priorMcp.installedFileHash === mcpCurrentHash;
    mcpMode = fileUnchanged ? priorMcp.originalMode ?? 'exact' : 'surgical';

    // The user modified the file since our last install, and this run is
    // about to change it again: take a FRESH backup of the current state so
    // a later undo restores the pre-overwrite content (with the user's
    // edits) instead of the first-install backup — which would silently
    // destroy those edits (review P1 #1).
    if (!fileUnchanged && mcpChanged) {
      mcpTakeBackup = true;
      mcpBackupPath = null;
      mcpPreviousHash = mcpCurrentHash;
      mcpExistedBefore = true;
      mcpMode = 'exact';
    }
  }

  prepared.push({
    kind: 'mcp-entry',
    target: ctx.mcpJsonPath,
    existedBefore: mcpExistedBefore,
    existedBeforeRun: mcpExisted,
    previousHash: mcpPreviousHash,
    installedHash: entryHash,
    installedFileHash: sha256(mcpNewContent),
    injectedBlockHash: null,
    mcpEntryKey: MCP_SERVER_KEY,
    newContent: mcpNewContent,
    backupPath: mcpBackupPath,
    takeBackup: mcpTakeBackup,
    originalMode: mcpMode,
    action: !mcpExisted ? 'create' : mcpChanged ? 'update' : 'skip',
    detail: hasEntry
      ? 'Update the kimi-memory MCP server entry'
      : 'Register the kimi-memory MCP server entry',
    message: hasEntry
      ? 'Updated kimi-memory MCP server entry.'
      : 'Added kimi-memory MCP server entry.',
  });

  return prepared;
}

function copyDirectory(source: string, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function applyTarget(
  ctx: InstallContext,
  prepared: PreparedTarget,
  backupDir: string,
): void {
  // Backup the original state before touching the target. A re-install over
  // content this tool already owns keeps the backup of the first install.
  if (prepared.takeBackup) {
    const backupPath =
      prepared.kind === 'skill'
        ? path.join(backupDir, 'skills', 'memory-manage')
        : path.join(backupDir, path.basename(prepared.target));
    ctx.options.fault?.(`backup:${prepared.kind}`);
    if (prepared.kind === 'skill') {
      copyDirectory(prepared.target, backupPath);
    } else {
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(prepared.target, backupPath);
    }
    prepared.backupPath = backupPath;
  }

  ctx.options.fault?.(`write:${prepared.kind}`);
  if (prepared.kind === 'skill') {
    const parent = path.dirname(prepared.target);
    fs.mkdirSync(parent, { recursive: true });
    const staging = path.join(parent, `.memory-manage.staging-${timestampId()}`);
    try {
      ctx.options.fault?.('copy:skill');
      copyDirectory(ctx.skillSource, staging);
      removePath(prepared.target);
      ctx.options.fault?.('rename:skill');
      fs.renameSync(staging, prepared.target);
      // Record the hash of the content that was actually installed.
      prepared.installedHash = hashDirectory(prepared.target);
      prepared.installedFileHash = prepared.installedHash;
    } catch (err) {
      removePath(staging);
      throw err;
    }
  } else if (prepared.newContent !== null) {
    writeTextAtomic(prepared.target, prepared.newContent);
  }
}

function rollbackTarget(prepared: PreparedTarget): void {
  if (prepared.existedBeforeRun) {
    // Without a backup the target was not modified yet: leave it alone.
    if (!prepared.backupPath) return;
    try {
      if (prepared.kind === 'skill') {
        removePath(prepared.target);
        copyDirectory(prepared.backupPath, prepared.target);
      } else {
        fs.mkdirSync(path.dirname(prepared.target), { recursive: true });
        fs.copyFileSync(prepared.backupPath, prepared.target);
      }
    } catch {
      /* best effort rollback */
    }
  } else {
    removePath(prepared.target);
  }
}

async function runInstall(ctx: InstallContext): Promise<void> {
  const prepared = prepareInstall(ctx);

  if (ctx.conflicts.length > 0) {
    for (const conflict of ctx.conflicts) {
      ctx.steps.push({
        kind: conflict.kind,
        target: conflict.target,
        action: 'conflict',
        detail: conflict.reason,
      });
    }
    throw new SetupConflictError(ctx.conflicts);
  }

  for (const item of prepared) {
    ctx.steps.push({
      kind: item.kind,
      target: item.target,
      action: item.action,
      detail: item.detail,
    });
  }

  if (ctx.options.dryRun) {
    for (const item of prepared) {
      ctx.actions.push(`[dry-run] ${item.detail}`);
    }
    ctx.actions.push('[dry-run] No files were written.');
    return;
  }

  if (!dirExists(ctx.kimiCodeHome)) {
    ctx.warnings.push(
      `Kimi Code home not found at ${ctx.kimiCodeHome}; it will be created. Is Kimi Code CLI installed?`,
    );
  }

  const backupDir = path.join(backupRootFor(ctx.kimiCodeHome), timestampId());
  const applied: PreparedTarget[] = [];

  try {
    for (const item of prepared) {
      // The item is registered before it is applied, so a failure in the
      // middle of a step still restores the previous state.
      applied.push(item);
      applyTarget(ctx, item, backupDir);
    }
  } catch (err) {
    for (const item of applied.reverse()) rollbackTarget(item);
    removePath(backupDir);
    ctx.warnings.push(
      `Setup failed and was rolled back: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }

  // Write the manifest last: it is the proof of ownership for undo.
  const entries: ManifestEntry[] = prepared.map((item) => ({
    kind: item.kind,
    targetPath: item.target,
    existedBefore: item.existedBefore,
    previousHash: item.previousHash,
    installedHash: item.installedHash,
    installedFileHash: item.installedFileHash,
    backupPath: item.backupPath,
    injectedBlockHash: item.injectedBlockHash,
    mcpEntryKey: item.mcpEntryKey,
    originalMode: item.originalMode,
    installedAt: new Date().toISOString(),
  }));

  // Merge with the manifest on disk: this install replaces the entries for
  // the targets it touched, every other target (e.g. a per-workspace
  // AGENTS.md next to the global one) keeps its ownership record.
  const existingManifest = readSetupManifest(ctx.kimiCodeHome);
  const existingEntries = existingManifest?.entries ?? [];
  const mergedEntries: ManifestEntry[] = [
    ...existingEntries.filter(
      (entry) =>
        !entries.some(
          (fresh) => fresh.kind === entry.kind && fresh.targetPath === entry.targetPath,
        ),
    ),
    ...entries,
  ];

  const manifest: SetupManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    tool: 'kimi-code-memory-mcp-server',
    kimiCodeHome: ctx.kimiCodeHome,
    updatedAt: new Date().toISOString(),
    entries: mergedEntries,
  };

  try {
    ctx.options.fault?.('write:manifest');
    writeSetupManifest(ctx.kimiCodeHome, manifest);
  } catch (err) {
    for (const item of applied.reverse()) rollbackTarget(item);
    removePath(backupDir);
    ctx.warnings.push(
      `Setup failed while writing the manifest and was rolled back: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw err;
  }

  for (const item of prepared) {
    ctx.actions.push(item.message);
  }
  ctx.actions.push(`Manifest written to ${ctx.manifestPath}`);
}

// ---------------------------------------------------------------------------
// undo
// ---------------------------------------------------------------------------

function undoAgentsMd(
  ctx: InstallContext,
  entry: ManifestEntry,
): { removed: boolean; kept: boolean } {
  const current = readText(entry.targetPath);
  if (current === null) {
    ctx.actions.push('AGENTS.md no longer exists; nothing to undo.');
    return { removed: true, kept: false };
  }

  const found = findInjectedBlock(current);
  if (!found) {
    ctx.actions.push('AGENTS.md no longer contains the injected block; nothing to undo.');
    return { removed: true, kept: false };
  }

  if (entry.injectedBlockHash && sha256(found.text) !== entry.injectedBlockHash) {
    ctx.warnings.push(
      `The injected block in ${entry.targetPath} was modified after installation; it was kept.`,
    );
    ctx.steps.push({
      kind: 'agents-md',
      target: entry.targetPath,
      action: 'keep',
      detail: 'Injected block was modified by the user; kept as is.',
    });
    return { removed: false, kept: true };
  }

  // Untouched since the install: restore the original file byte for byte.
  const canRestoreOriginal = entry.originalMode !== 'surgical';
  if (canRestoreOriginal && entry.installedFileHash && sha256(current) === entry.installedFileHash) {
    if (!entry.existedBefore) {
      removePath(entry.targetPath);
      ctx.actions.push('Removed injected memory protocol block.');
      ctx.actions.push(`Removed ${entry.targetPath} (it did not exist before the install).`);
    } else if (entry.backupPath && fileExists(entry.backupPath)) {
      writeTextAtomic(entry.targetPath, fs.readFileSync(entry.backupPath, 'utf8'));
      ctx.actions.push('Removed injected memory protocol block.');
      ctx.actions.push(`Restored the original ${entry.targetPath} from the backup.`);
    } else {
      writeTextAtomic(entry.targetPath, removeInjectedBlock(current));
      ctx.actions.push('Removed injected memory protocol block.');
    }
  } else {
    writeTextAtomic(entry.targetPath, removeInjectedBlock(current));
    ctx.actions.push('Removed injected memory protocol block.');
    ctx.actions.push(`Kept the other changes in ${entry.targetPath}.`);
  }

  ctx.steps.push({
    kind: 'agents-md',
    target: entry.targetPath,
    action: 'restore',
    detail: 'Removed the injected memory protocol block.',
  });
  return { removed: true, kept: false };
}

function undoSkill(ctx: InstallContext, entry: ManifestEntry): { removed: boolean; kept: boolean } {
  if (!dirExists(entry.targetPath)) {
    ctx.actions.push('The memory-manage skill directory no longer exists; nothing to undo.');
    return { removed: true, kept: false };
  }

  const currentHash = hashDirectory(entry.targetPath);
  if (entry.installedHash && currentHash !== entry.installedHash) {
    ctx.warnings.push(
      `The skill directory ${entry.targetPath} was modified after installation; it was kept.`,
    );
    ctx.steps.push({
      kind: 'skill',
      target: entry.targetPath,
      action: 'keep',
      detail: 'Skill directory was modified by the user; kept as is.',
    });
    return { removed: false, kept: true };
  }

  if (!entry.existedBefore) {
    removePath(entry.targetPath);
    ctx.actions.push('Removed memory-manage skill.');
  } else if (entry.backupPath && dirExists(entry.backupPath)) {
    removePath(entry.targetPath);
    copyDirectory(entry.backupPath, entry.targetPath);
    ctx.actions.push('Removed memory-manage skill.');
    ctx.actions.push(`Restored the previous skill directory ${entry.targetPath} from the backup.`);
  } else {
    removePath(entry.targetPath);
    ctx.actions.push('Removed memory-manage skill.');
  }

  ctx.steps.push({
    kind: 'skill',
    target: entry.targetPath,
    action: 'remove',
    detail: 'Removed the installed memory-manage skill directory.',
  });
  removeEmptyParent(path.dirname(entry.targetPath));
  return { removed: true, kept: false };
}

function undoMcpEntry(
  ctx: InstallContext,
  entry: ManifestEntry,
): { removed: boolean; kept: boolean } {
  const current = readText(entry.targetPath);
  if (current === null) {
    ctx.actions.push(`${entry.targetPath} no longer exists; nothing to undo.`);
    return { removed: true, kept: false };
  }

  const config = parseMcpConfig(current, entry.targetPath);
  const servers = getMcpServers(config);
  const key = entry.mcpEntryKey ?? MCP_SERVER_KEY;
  if (!Object.prototype.hasOwnProperty.call(servers, key)) {
    ctx.actions.push(`The "${key}" MCP server entry is already absent; nothing to undo.`);
    return { removed: true, kept: false };
  }

  const currentEntryHash = sha256(canonicalJson(servers[key]));
  if (entry.installedHash && currentEntryHash !== entry.installedHash) {
    ctx.warnings.push(
      `The "${key}" MCP server entry was modified after installation; it was kept.`,
    );
    ctx.steps.push({
      kind: 'mcp-entry',
      target: entry.targetPath,
      action: 'keep',
      detail: `The "${key}" entry was modified by the user; kept as is.`,
    });
    return { removed: false, kept: true };
  }

  // Untouched since the install: restore the original file byte for byte.
  const canRestoreOriginal = entry.originalMode !== 'surgical';
  if (canRestoreOriginal && entry.installedFileHash && sha256(current) === entry.installedFileHash) {
    if (!entry.existedBefore) {
      removePath(entry.targetPath);
      ctx.actions.push('Removed kimi-memory MCP server entry.');
      ctx.actions.push(`Removed ${entry.targetPath} (it did not exist before the install).`);
    } else if (entry.backupPath && fileExists(entry.backupPath)) {
      writeTextAtomic(entry.targetPath, fs.readFileSync(entry.backupPath, 'utf8'));
      ctx.actions.push('Removed kimi-memory MCP server entry.');
      ctx.actions.push(`Restored the original ${entry.targetPath} from the backup.`);
    } else {
      delete servers[key];
      writeTextAtomic(entry.targetPath, JSON.stringify(withoutEmptyServers(config, servers), null, 2) + '\n');
      ctx.actions.push('Removed kimi-memory MCP server entry.');
    }
  } else {
    // The file changed elsewhere: only drop the entry owned by this tool.
    delete servers[key];
    const remaining = withoutEmptyServers(config, servers);
    if (!entry.existedBefore && Object.keys(remaining).length === 0) {
      removePath(entry.targetPath);
      ctx.actions.push('Removed kimi-memory MCP server entry.');
      ctx.actions.push(`Removed ${entry.targetPath} (it did not exist before the install).`);
    } else {
      writeTextAtomic(entry.targetPath, JSON.stringify(remaining, null, 2) + '\n');
      ctx.actions.push('Removed kimi-memory MCP server entry.');
      ctx.actions.push(`Kept the other changes in ${entry.targetPath}.`);
    }
  }

  ctx.steps.push({
    kind: 'mcp-entry',
    target: entry.targetPath,
    action: 'remove',
    detail: `Removed the "${key}" MCP server entry.`,
  });
  return { removed: true, kept: false };
}

function runUndo(ctx: InstallContext): void {
  const manifest = ctx.manifest;
  if (!manifest) {
    ctx.warnings.push(
      `No setup manifest found at ${ctx.manifestPath}; nothing to undo. Nothing was changed.`,
    );
    ctx.actions.push('Nothing to undo (no manifest found).');
    return;
  }

  const remaining: ManifestEntry[] = [];

  // `--scope workspace --undo` means "disable memory for THIS project": only
  // the workspace AGENTS.md entry is removed; the global block, skill and
  // MCP entry stay installed for every other workspace.
  const workspaceOnly = ctx.options.scope === 'workspace';

  for (const entry of manifest.entries) {
    if (workspaceOnly) {
      if (entry.kind !== 'agents-md' || entry.targetPath !== ctx.agentsMdPath) {
        remaining.push(entry);
        continue;
      }
    }
    let outcome: { removed: boolean; kept: boolean };
    if (entry.kind === 'agents-md') outcome = undoAgentsMd(ctx, entry);
    else if (entry.kind === 'skill') outcome = undoSkill(ctx, entry);
    else outcome = undoMcpEntry(ctx, entry);

    if (!outcome.removed) remaining.push(entry);
  }

  if (remaining.length === 0) {
    removePath(ctx.manifestPath);
    ctx.actions.push('Setup manifest removed.');
  } else {
    writeSetupManifest(ctx.kimiCodeHome, {
      ...manifest,
      updatedAt: new Date().toISOString(),
      entries: remaining,
    });
    ctx.actions.push(
      `Setup manifest kept for ${remaining.length} entry/entries that were modified by the user.`,
    );
  }
}

// ---------------------------------------------------------------------------
// public entry point
// ---------------------------------------------------------------------------

/**
 * Run setup or teardown.
 */
export async function runSetup(options: SetupOptions = {}): Promise<SetupResult> {
  const kimiCodeHome = getKimiCodeHome(options);
  const ctx: InstallContext = {
    options,
    kimiCodeHome,
    agentsMdPath:
      options.scope === 'workspace'
        ? path.join(process.cwd(), 'AGENTS.md')
        : path.join(kimiCodeHome, 'AGENTS.md'),
    skillPath: path.join(kimiCodeHome, 'skills', 'memory-manage'),
    mcpJsonPath: path.join(kimiCodeHome, 'mcp.json'),
    manifestPath: manifestPathFor(kimiCodeHome),
    skillSource: path.join(getPackageRoot(), 'skills', 'memory-manage'),
    injectedContent: '',
    manifest: readSetupManifest(kimiCodeHome),
    steps: [],
    actions: [],
    warnings: [],
    conflicts: [],
  };

  if (options.purgeBackups) {
    const backupRoot = backupRootFor(kimiCodeHome);
    if (dirExists(backupRoot)) {
      removePath(backupRoot);
      ctx.actions.push(`Removed all setup backups under ${backupRoot}.`);
    } else {
      ctx.actions.push('No setup backups to remove.');
    }
    return {
      kimiCodeHome,
      agentsMdPath: ctx.agentsMdPath,
      skillPath: ctx.skillPath,
      mcpJsonPath: ctx.mcpJsonPath,
      manifestPath: ctx.manifestPath,
      actions: ctx.actions,
      warnings: ctx.warnings,
      steps: ctx.steps,
      conflicts: ctx.conflicts,
      dryRun: !!options.dryRun,
    };
  }

  if (options.undo) {
    runUndo(ctx);
  } else {
    const injectedContent = readText(path.join(getPackageRoot(), 'assets', 'user-agents.md'));
    if (!injectedContent) {
      throw new Error(
        `Bundled user-agents.md template not found at ${path.join(
          getPackageRoot(),
          'assets',
          'user-agents.md',
        )}`,
      );
    }
    if (!dirExists(ctx.skillSource)) {
      throw new Error(`Bundled skill not found at ${ctx.skillSource}`);
    }
    ctx.injectedContent = injectedContent;
    await runInstall(ctx);
  }

  return {
    kimiCodeHome,
    agentsMdPath: ctx.agentsMdPath,
    skillPath: ctx.skillPath,
    mcpJsonPath: ctx.mcpJsonPath,
    manifestPath: ctx.manifestPath,
    actions: ctx.actions,
    warnings: ctx.warnings,
    steps: ctx.steps,
    conflicts: ctx.conflicts,
    dryRun: !!options.dryRun,
  };
}
