/**
 * wire.jsonl parsing and context recovery.
 *
 * This module is intentionally Kimi Code CLI specific: it understands the
 * wire.jsonl event schema. A future abstraction layer could make this pluggable.
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import type { ContextWindow } from '../config.js';
import {
  getStoreRoot,
  sessionsRoot,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_RECENT_CHANGE_LIMIT,
} from '../config.js';
import { computeWorkspaceHash } from '../utils/paths.js';

export interface McpConfig {
  version: number;
  contextWindow: ContextWindow;
  recentChangeLimit: number;
  sessionMappings: Record<string, SessionMapping>;
}

export interface SessionMapping {
  slugDir: string;
  discoveredAt: string;
}

export interface WireSession {
  sessionId: string;
  wire: string;
  mtime?: number;
  slugDir?: string;
}

export interface WireAction {
  name: string;
  args: string;
  result: string;
}

export interface WireTurn {
  turnId: string;
  timestamp: string | null;
  user: string;
  agentText: string;
  actions: WireAction[];
}

export interface CompactionSummary {
  time: string | null;
  summary: string;
}

export interface ContextWindowOverrides {
  detailedRounds?: number;
  summaryRounds?: number;
}

export interface SearchOptions {
  limit?: number;
  dateFrom?: string;
  dateTo?: string;
}

export interface LoadTurnOptions {
  maxReferences?: number;
}

export interface TurnReference {
  sessionId: string;
  turnId: number;
}

export interface DetailedRound {
  turnId: number;
  timestamp: string | null;
  user: string;
  agent: string;
  actions: WireAction[];
}

export interface SummaryRound {
  turnId: number;
  timestamp: string | null;
  summary: string;
}

const mcpConfigPath = path.join(getStoreRoot(), 'mcp-config.json');

/**
 * Load the global MCP configuration, creating defaults if absent.
 */
export function loadMcpConfig(): McpConfig {
  try {
    const text = fs.readFileSync(mcpConfigPath, 'utf8');
    const parsed = JSON.parse(text);
    return {
      version: parsed.version || 1,
      contextWindow: { ...DEFAULT_CONTEXT_WINDOW, ...(parsed.contextWindow || {}) },
      recentChangeLimit:
        typeof parsed.recentChangeLimit === 'number'
          ? Math.max(0, Math.floor(parsed.recentChangeLimit))
          : DEFAULT_RECENT_CHANGE_LIMIT,
      sessionMappings: parsed.sessionMappings || {},
    };
  } catch {
    return {
      version: 1,
      contextWindow: { ...DEFAULT_CONTEXT_WINDOW },
      recentChangeLimit: DEFAULT_RECENT_CHANGE_LIMIT,
      sessionMappings: {},
    };
  }
}

/**
 * Persist the global MCP configuration.
 */
export function saveMcpConfig(config: McpConfig): void {
  fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
  fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2), 'utf8');
}

function normalizeCwd(): string {
  return process.cwd().replace(/\\/g, '/');
}

/**
 * Find all session directory candidates for a workspace hash.
 */
function findCandidateSessionDirs(hash: string): string[] {
  if (!fs.existsSync(sessionsRoot)) return [];
  return fs
    .readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(`_${hash}`))
    .map((entry) => entry.name);
}

/**
 * Within a single wd_* directory, find the most recently active session.
 */
function findLatestSessionInDir(slugDir: string): WireSession | null {
  const dir = path.join(sessionsRoot, slugDir);
  if (!fs.existsSync(dir)) return null;
  const sessions = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('session_'))
    .map((entry) => {
      const wire = path.join(dir, entry.name, 'agents', 'main', 'wire.jsonl');
      let mtime = 0;
      try {
        mtime = fs.statSync(wire).mtimeMs;
      } catch {
        mtime = 0;
      }
      return { sessionId: entry.name, wire, mtime };
    })
    .filter((s) => s.mtime > 0)
    .sort((a, b) => b.mtime - a.mtime);
  return sessions[0] || null;
}

/**
 * Discover the active session for the current workspace and cache the mapping.
 */
export function discoverCurrentSession(): WireSession | null {
  const cwd = normalizeCwd();
  const hash = computeWorkspaceHash(cwd);
  const candidates = findCandidateSessionDirs(hash);

  let best: WireSession | null = null;
  let bestSlugDir: string | null = null;
  for (const slugDir of candidates) {
    const session = findLatestSessionInDir(slugDir);
    if (session && (!best || session.mtime! > best.mtime!)) {
      best = session;
      bestSlugDir = slugDir;
    }
  }

  if (best && bestSlugDir) {
    const config = loadMcpConfig();
    config.sessionMappings[cwd] = {
      slugDir: bestSlugDir,
      discoveredAt: new Date().toISOString(),
    };
    saveMcpConfig(config);
  }

  return best;
}

/**
 * Resolve the active session wire path, using the cached mapping if valid.
 */
export function getCurrentSessionWirePath(): WireSession | null {
  const cwd = normalizeCwd();
  const config = loadMcpConfig();
  const mapping = config.sessionMappings[cwd];

  if (mapping?.slugDir) {
    const session = findLatestSessionInDir(mapping.slugDir);
    if (session) return session;
  }

  return discoverCurrentSession();
}

/**
 * Find all historical sessions for the current workspace.
 */
export function findAllWorkspaceSessions(): WireSession[] {
  const cwd = normalizeCwd();
  const hash = computeWorkspaceHash(cwd);
  const candidates = findCandidateSessionDirs(hash);
  const sessions = [];
  for (const slugDir of candidates) {
    const dir = path.join(sessionsRoot, slugDir);
    if (!fs.existsSync(dir)) continue;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session_')) continue;
      const wire = path.join(dir, entry.name, 'agents', 'main', 'wire.jsonl');
      if (!fs.existsSync(wire)) continue;
      sessions.push({ sessionId: entry.name, wire, slugDir });
    }
  }
  return sessions;
}

function truncate(text: unknown, maxLen: number): string {
  if (text === null || text === undefined) return '';
  const s = String(text);
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

function summarizeToolArgs(name: string, args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  const priorityKeys = ['path', 'command', 'key', 'query', 'description', 'folder', 'skill', 'url'];
  const parts: string[] = [];
  for (const key of priorityKeys) {
    if (record[key] === null || record[key] === undefined) continue;
    let value = String(record[key]);
    if (key === 'command') value = truncate(value, 120);
    else value = truncate(value, 200);
    parts.push(`${key}=${value}`);
    if (parts.length >= 3) break;
  }
  return parts.join(', ');
}

function summarizeToolResult(result: unknown): string {
  if (result === null || result === undefined) return '';
  const r = result as {
    isError?: boolean;
    error?: unknown;
    output?: unknown;
    content?: unknown;
    result?: unknown;
  };
  if (r.isError || r.error) {
    const err = r.error || r.output || r.content || 'failed';
    return `error: ${truncate(err, 200)}`;
  }
  const output = r.output || r.content || r.result || '';
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return `success: ${truncate(text, 200)}`;
}

/**
 * Parse a wire.jsonl file and return conversation turns + session-level
 * compaction summaries.
 */
export function parseWireFile(
  wirePath: string,
): Promise<{ turns: WireTurn[]; compactionSummaries: CompactionSummary[] }> {
  return new Promise((resolve, reject) => {
    if (!wirePath || !fs.existsSync(wirePath)) {
      return resolve({ turns: [], compactionSummaries: [] });
    }

    const turns = new Map<string, WireTurn>();
    const pendingActions = new Map<string, WireAction>();
    const compactionSummaries: CompactionSummary[] = [];
    let nextUserTurnId = 0;

    function ensureTurn(turnId: string | number): WireTurn {
      const id = String(turnId);
      if (!turns.has(id)) {
        turns.set(id, {
          turnId: id,
          timestamp: null,
          user: '',
          agentText: '',
          actions: [],
        });
      }
      return turns.get(id)!;
    }

    const stream = fs.createReadStream(wirePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }

      if (event.type === 'turn.prompt') {
        const turnId = String(nextUserTurnId);
        nextUserTurnId += 1;
        const turn = ensureTurn(turnId);
        const text = ((event.input || []) as Array<{ type?: string; text?: unknown }>)
          .filter((p) => p && p.type === 'text')
          .map((p) => String(p.text ?? ''))
          .join('\n');
        turn.user = text;
        if (event.time && !turn.timestamp) {
          turn.timestamp = new Date(event.time).toISOString();
        }
        return;
      }

      if (event.type === 'context.apply_compaction' && event.summary) {
        compactionSummaries.push({
          time: event.time ? new Date(event.time).toISOString() : null,
          summary: String(event.summary),
        });
        return;
      }

      if (event.type !== 'context.append_loop_event') return;
      const ev = event.event;
      if (!ev || !ev.type) return;

      const turnId = ev.turnId;

      if (ev.type === 'step.begin' && turnId !== null && turnId !== undefined) {
        const turn = ensureTurn(turnId);
        if (event.time && !turn.timestamp) {
          turn.timestamp = new Date(event.time).toISOString();
        }
        return;
      }

      if (ev.type === 'content.part' && turnId !== null && turnId !== undefined) {
        const turn = ensureTurn(turnId);
        const part = ev.part || {};
        if (part.type === 'text' && part.text) {
          turn.agentText += part.text;
        }
        return;
      }

      if (ev.type === 'tool.call' && turnId !== null && turnId !== undefined) {
        const turn = ensureTurn(turnId);
        const action = {
          name: ev.name || '',
          args: summarizeToolArgs(ev.name, ev.args),
          result: '',
        };
        turn.actions.push(action);
        if (ev.toolCallId) {
          pendingActions.set(ev.toolCallId, action);
        }
        return;
      }

      if (ev.type === 'tool.result') {
        const action = pendingActions.get(ev.toolCallId) || pendingActions.get(ev.parentUuid);
        if (action) {
          action.result = summarizeToolResult(ev.result);
          pendingActions.delete(ev.toolCallId);
          pendingActions.delete(ev.parentUuid);
        }
        return;
      }
    });

    rl.on('error', reject);
    rl.on('close', () => {
      const sortedTurns = Array.from(turns.values()).sort(
        (a, b) => parseInt(a.turnId, 10) - parseInt(b.turnId, 10),
      );
      resolve({ turns: sortedTurns, compactionSummaries });
    });
  });
}

function toDetailedRound(turn: WireTurn): DetailedRound {
  return {
    turnId: parseInt(turn.turnId, 10),
    timestamp: turn.timestamp,
    user: truncate(turn.user, 2000),
    agent: truncate(turn.agentText, 4000),
    actions: turn.actions.map((a) => ({
      name: a.name,
      args: a.args,
      result: a.result,
    })),
  };
}

function toSummaryRound(turn: WireTurn): SummaryRound {
  const actionNames = turn.actions.map((a) => a.name).filter(Boolean);
  const parts = [`User: ${truncate(turn.user, 120)}`];
  if (turn.agentText) {
    parts.push(`Agent: ${truncate(turn.agentText, 120)}`);
  }
  if (actionNames.length) {
    parts.push(`Actions: ${actionNames.join(', ')}`);
  }
  return {
    turnId: parseInt(turn.turnId, 10),
    timestamp: turn.timestamp,
    summary: parts.join(' | '),
  };
}

/**
 * Build the default context window: last N rounds detailed, preceding M rounds
 * summarized.
 */
export function buildContextWindow(
  turns: WireTurn[],
  overrides: ContextWindowOverrides = {},
): { detailedRounds: DetailedRound[]; summaryRounds: SummaryRound[]; totalTurns: number } {
  const config = loadMcpConfig();
  const detailedCount = overrides.detailedRounds ?? config.contextWindow.detailedRounds;
  const summaryCount = overrides.summaryRounds ?? config.contextWindow.defaultSummaryRounds;

  const total = turns.length;
  const detailedEnd = Math.min(detailedCount, total);
  const summaryEnd = Math.min(detailedEnd + summaryCount, total);

  const detailedRounds = turns.slice(total - detailedEnd).map(toDetailedRound);
  const summaryRounds = turns.slice(total - summaryEnd, total - detailedEnd).map(toSummaryRound);

  return { detailedRounds, summaryRounds, totalTurns: total };
}

/**
 * Load older rounds before a given turnId, summarized by default.
 */
export function loadMoreRounds(
  turns: WireTurn[],
  beforeTurnId: number,
  limit?: number,
): SummaryRound[] {
  const config = loadMcpConfig();
  const chunkSize = limit ?? config.contextWindow.loadMoreChunkSize;
  const older = turns.filter((t) => parseInt(t.turnId, 10) < beforeTurnId);
  const selected = older.slice(-chunkSize);
  return selected.map(toSummaryRound);
}

function scoreRound(turn: WireTurn, terms: string[]): number {
  const haystack = `${turn.user}\n${turn.agentText}\n${turn.actions
    .map((a) => a.name)
    .join(' ')}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const matches = haystack.match(re);
    if (matches) score += matches.length;
  }
  return score;
}

function extractSnippet(text: string, terms: string[], maxLen = 200): string {
  if (!terms.length) return truncate(text, maxLen);
  const lower = text.toLowerCase();
  let bestPos = -1;
  let bestTermLen = 0;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && term.length > bestTermLen) {
      bestPos = idx;
      bestTermLen = term.length;
    }
  }
  if (bestPos === -1) return truncate(text, maxLen);
  const start = Math.max(0, bestPos - 60);
  const end = Math.min(text.length, bestPos + bestTermLen + 60);
  let snippet = text.slice(start, end);
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

/**
 * Search across all workspace session wires for rounds matching the query.
 */
export async function searchWireContext(query: string, options: SearchOptions = {}) {
  const limit = typeof options.limit === 'number' ? Math.max(1, Math.floor(options.limit)) : 10;
  const dateFrom = options.dateFrom || null;
  const dateTo = options.dateTo || null;
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const sessions = findAllWorkspaceSessions();
  const matches = [];

  for (const session of sessions) {
    const { turns } = await parseWireFile(session.wire);
    for (const turn of turns) {
      const roundDate = turn.timestamp ? turn.timestamp.slice(0, 10) : null;
      if (dateFrom && roundDate && roundDate < dateFrom) continue;
      if (dateTo && roundDate && roundDate > dateTo) continue;

      const score = scoreRound(turn, terms);
      if (score === 0) continue;

      const fullText = `${turn.user}\n${turn.agentText}`;
      matches.push({
        sessionId: session.sessionId,
        turnId: parseInt(turn.turnId, 10),
        timestamp: turn.timestamp,
        score,
        user: truncate(turn.user, 1000),
        agent: truncate(turn.agentText, 2000),
        snippet: extractSnippet(fullText, terms, 240),
        actions: turn.actions.map((a) => a.name).filter(Boolean),
      });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return {
    query,
    totalMatches: matches.length,
    matches: matches.slice(0, limit),
  };
}

/**
 * Load the full detailed content of specific conversation turns.
 */
export async function loadTurnContext(references: TurnReference[], options: LoadTurnOptions = {}) {
  const maxRefs =
    typeof options.maxReferences === 'number' ? Math.max(1, Math.floor(options.maxReferences)) : 20;

  if (!Array.isArray(references)) {
    return { rounds: [], notFound: [], error: 'references must be an array' };
  }

  const validRefs = references
    .filter((r) => r && typeof r.sessionId === 'string' && typeof r.turnId === 'number')
    .slice(0, maxRefs);

  if (validRefs.length === 0) {
    return { rounds: [], notFound: [] };
  }

  const sessionGroups = new Map<string, Set<number>>();
  for (const ref of validRefs) {
    if (!sessionGroups.has(ref.sessionId)) {
      sessionGroups.set(ref.sessionId, new Set<number>());
    }
    sessionGroups.get(ref.sessionId)!.add(ref.turnId);
  }

  const allSessions = findAllWorkspaceSessions();
  const sessionMap = new Map(allSessions.map((s) => [s.sessionId, s.wire]));

  const rounds: Array<{ sessionId: string } & DetailedRound> = [];
  const notFound: TurnReference[] = [];

  for (const [sessionId, turnIds] of sessionGroups.entries()) {
    const wire = sessionMap.get(sessionId);
    if (!wire) {
      for (const turnId of turnIds) {
        notFound.push({ sessionId, turnId });
      }
      continue;
    }

    const { turns } = await parseWireFile(wire);
    const turnMap = new Map(turns.map((t) => [parseInt(t.turnId, 10), t]));

    for (const turnId of turnIds) {
      const turn = turnMap.get(turnId);
      if (turn) {
        rounds.push({ sessionId, ...toDetailedRound(turn) });
      } else {
        notFound.push({ sessionId, turnId });
      }
    }
  }

  const orderMap = new Map<string, number>();
  validRefs.forEach((ref, idx) => {
    const key = `${ref.sessionId}:${ref.turnId}`;
    if (!orderMap.has(key)) orderMap.set(key, idx);
  });
  rounds.sort((a, b) => {
    const keyA = `${a.sessionId}:${a.turnId}`;
    const keyB = `${b.sessionId}:${b.turnId}`;
    return (orderMap.get(keyA) ?? 0) - (orderMap.get(keyB) ?? 0);
  });

  return { rounds, notFound };
}
