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
  getSessionsRoot,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_RECENT_CHANGE_LIMIT,
  SEARCH_SNIPPET_MAX_LEN,
  SEARCH_USER_MAX_LEN,
  SEARCH_AGENT_MAX_LEN,
} from '../config.js';
import { scoreText, extractSnippet, hasAllTerms, normalizeTerms } from '../utils/search.js';
import { canonicalCwdHashInput } from '../search/canonical-path.js';
import { metrics } from '../utils/metrics.js';
import {
  normalizeWorkDir,
  resolveWorkspaceDescriptors,
  resolveHostSessionEntries,
  workspaceIdFromSessionDir,
} from '../search/host-workspace.js';
import type { RefinedManager } from '../refined-manager.js';

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
  /**
   * True when the session was identified by guessing (mtime) instead of by an
   * explicit identity. Sessions with `identityAssumed === true` are
   * low-confidence and must not drive destructive operations.
   */
  identityAssumed?: boolean;
  /**
   * How the identity was resolved: an explicit override, the cached
   * host/config mapping, or an mtime guess (low confidence).
   */
  identitySource?: 'explicit' | 'mapped' | 'guess';
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
  refinedManager?: RefinedManager;
  userMaxLen?: number;
  agentMaxLen?: number;
  snippetMaxLen?: number;
  /**
   * Maximum number of wire bytes that may be parsed in one request. When the
   * budget is exhausted the scan stops and reports a partial result.
   */
  maxScanBytes?: number;
  /** First unfinished session returned as nextCursor by the previous page. */
  cursor?: string;
  /**
   * Abort signal from the MCP request. When it fires mid-scan the result is
   * partial (`truncationReason: 'request-cancelled'`) instead of pretending
   * the scan finished.
   */
  signal?: AbortSignal;
}

export interface SearchMatch {
  sessionId: string;
  turnId: number;
  timestamp: string | null;
  score: number;
  user: string;
  agent: string;
  snippet: string;
  actions: string[];
  /**
   * `wire` when the original turn was available and authoritative,
   * `refined-only` when only the refined summary survived.
   */
  source?: 'wire' | 'refined-only';
}

export interface SearchResult {
  query: string;
  /**
   * Complete merged match count. Only present when the scan visited every
   * candidate (`isComplete === true`); a partial scan never claims a total.
   */
  totalMatches?: number;
  /** Matches discovered during the scan, before `limit` was applied. */
  matchCount: number;
  /** True when every candidate source was scanned. */
  isComplete: boolean;
  /** Why the scan stopped early. */
  truncationReason?: string;
  /** Sessions that could not be scanned. */
  skippedSessionIds: string[];
  /** Session id the scan should resume from. */
  nextCursor?: string;
  /** Number of refined rows that could not be decoded. */
  corruptRefinedRows?: number;
  matches: SearchMatch[];
  hits: Array<{ sessionId: string; turn: WireTurn; wire: string }>;
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

function getMcpConfigPath(): string {
  return path.join(getStoreRoot(), 'mcp-config.json');
}

/**
 * Load the global MCP configuration, creating defaults if absent.
 */
export function loadMcpConfig(): McpConfig {
  try {
    const text = fs.readFileSync(getMcpConfigPath(), 'utf8');
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
  const mcpConfigPath = getMcpConfigPath();
  fs.mkdirSync(path.dirname(mcpConfigPath), { recursive: true });
  fs.writeFileSync(mcpConfigPath, JSON.stringify(config, null, 2), 'utf8');
}

/**
 * Environment variable that pins the current session.
 *
 * This is a **manual / test override only**. The Kimi host runs the MCP
 * server as a workspace level baseline service: it does not inject a session
 * id into the server environment and the MCP initialize handshake carries no
 * per-session identity. Do not rely on the host providing this value.
 */
export const SESSION_ID_ENV = 'KIMI_MEMORY_SESSION_ID';

/** Default number of matches returned by a search. */
export const DEFAULT_SEARCH_LIMIT = 10;

/** Hard upper bound for the number of returned matches. */
export const MAX_SEARCH_LIMIT = 100;

/** Default per-request wire scan budget (32 MiB). */
export const DEFAULT_MAX_SCAN_BYTES = 32 * 1024 * 1024;

/** Environment variable that overrides the wire scan budget. */
export const MAX_SCAN_BYTES_ENV = 'KIMI_MEMORY_MAX_SCAN_BYTES';

/**
 * Session id configured manually through the environment, if any.
 *
 * Manual override only — the host does not provide it.
 */
export function getExplicitSessionId(): string | null {
  const raw = process.env[SESSION_ID_ENV];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Work directory of the current process, normalized the way the host
 * normalizes it (slashes, trimmed trailing slash, **no realpath**).
 *
 * The value is the bucketing basis for host workspace directories, so it must
 * stay byte-compatible with the hash the host wrote.
 */
function currentWorkDir(): string {
  return normalizeWorkDir(process.cwd());
}

/**
 * Key used for the legacy `mcp-config.json` session mapping.
 *
 * This is the historical key (slashes only). It must not change, otherwise
 * existing mappings are orphaned.
 */
function legacyCwdKey(): string {
  return process.cwd().replace(/\\/g, '/');
}

/**
 * Secondary mapping key (realpath based). Only used to look up mappings that
 * were written by a build that used the canonical path.
 */
function canonicalCwdKey(): string {
  return canonicalCwdHashInput();
}

/**
 * Host workspace directories that may contain sessions of the current work
 * directory (`wd_*` by cwd hash, `wm_*` by the host's project/session index).
 */
function findCandidateSessionDirs(): string[] {
  const sessionsRoot = getSessionsRoot();
  return resolveWorkspaceDescriptors(currentWorkDir(), sessionsRoot).map((d) => d.id);
}

/**
 * Within a single workspace directory, find the most recently active session.
 */
function findLatestSessionInDir(slugDir: string): WireSession | null {
  const dir = path.join(getSessionsRoot(), slugDir);
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
  const latest = sessions[0];
  return latest ? { ...latest, identityAssumed: true, identitySource: 'guess' } : null;
}

/**
 * Resolve an explicitly configured session id to a session on disk.
 */
function findSessionById(sessionId: string): WireSession | null {
  const sessions = findAllWorkspaceSessions();
  const found = sessions.find((s) => s.sessionId === sessionId);
  return found
    ? { ...found, identityAssumed: false, identitySource: 'explicit' }
    : null;
}

/**
 * Discover the active session for the current workspace and cache the mapping.
 *
 * Resolution order:
 *   1. explicit session id (manual override, environment variable);
 *   2. cached slug mapping (still an mtime guess);
 *   3. newest wire by mtime — low confidence, `identityAssumed: true`.
 */
export function discoverCurrentSession(): WireSession | null {
  const explicit = getExplicitSessionId();
  if (explicit) {
    const resolved = findSessionById(explicit);
    if (resolved) return resolved;
    // The pinned session is not on disk (yet). Fall through to the guess, but
    // the result stays low-confidence.
  }

  const candidates = findCandidateSessionDirs();

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
    config.sessionMappings[legacyCwdKey()] = {
      slugDir: bestSlugDir,
      discoveredAt: new Date().toISOString(),
    };
    saveMcpConfig(config);
  }

  return best ? { ...best, identityAssumed: true, identitySource: 'guess' } : null;
}

/**
 * Resolve the active session wire path, using the cached mapping if valid.
 */
export function getCurrentSessionWirePath(): WireSession | null {
  const explicit = getExplicitSessionId();
  if (explicit) {
    const resolved = findSessionById(explicit);
    if (resolved) return resolved;
  }

  const config = loadMcpConfig();
  const mapping =
    config.sessionMappings[legacyCwdKey()] ?? config.sessionMappings[canonicalCwdKey()];

  if (mapping?.slugDir) {
    const session = findLatestSessionInDir(mapping.slugDir);
    if (session) {
      return {
        ...session,
        identityAssumed: true,
        identitySource: 'mapped',
      };
    }
  }

  return discoverCurrentSession();
}

/**
 * Find all historical sessions for the current work directory.
 *
 * Covers implicit (`wd_*`) and managed (`wm_*`) host workspaces: the host
 * workspace directories are resolved from the cwd hash, from
 * `projects.json` and from `session_index.jsonl`. When the host metadata is
 * missing or corrupted, the legacy cwd hash lookup is used on its own.
 */
export function findAllWorkspaceSessions(): WireSession[] {
  const sessionsRoot = getSessionsRoot();
  const workDir = currentWorkDir();
  const sessions: WireSession[] = [];
  const seen = new Set<string>();

  const addSession = (sessionId: string, wire: string, slugDir: string): void => {
    const key = `${slugDir}::${sessionId}`;
    if (seen.has(key)) return;
    seen.add(key);
    let mtime = 0;
    try {
      mtime = fs.statSync(wire).mtimeMs;
    } catch {
      mtime = 0;
    }
    sessions.push({ sessionId, wire, slugDir, mtime });
  };

  // Workspace directories (wd_* by hash, wm_* by the host index).
  for (const descriptor of resolveWorkspaceDescriptors(workDir, sessionsRoot)) {
    const dir = path.join(sessionsRoot, descriptor.id);
    if (!fs.existsSync(dir)) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('session_')) continue;
      const wire = path.join(dir, entry.name, 'agents', 'main', 'wire.jsonl');
      if (!fs.existsSync(wire)) continue;
      addSession(entry.name, wire, descriptor.id);
    }
  }

  // Sessions the host recorded for this work directory. This is what makes a
  // managed workspace (or a workspace whose primary directory changed)
  // discoverable even when its directory name carries no cwd hash.
  for (const entry of resolveHostSessionEntries(workDir, sessionsRoot)) {
    const wire = path.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
    if (!fs.existsSync(wire)) continue;
    const slugDir =
      workspaceIdFromSessionDir(entry.sessionDir, sessionsRoot) ??
      path.basename(path.dirname(entry.sessionDir));
    addSession(entry.sessionId, wire, slugDir);
  }

  return sessions;
}

/**
 * Find the most recently active session in the current workspace, excluding the
 * current session. Used to resume context from the previous session when the
 * current one is brand new and has no usable history of its own.
 *
 * The explicitly configured session id is always excluded, even when the
 * mtime guess resolved to a different session.
 */
export function findPreviousSession(): WireSession | null {
  const explicit = getExplicitSessionId();
  const current = getCurrentSessionWirePath();
  const currentId = current?.sessionId;
  const candidates = findAllWorkspaceSessions()
    .filter((s) => s.sessionId !== currentId && s.sessionId !== explicit)
    .map((s) => ({ ...s, identityAssumed: true, identitySource: 'guess' as const }))
    .filter((s) => (s.mtime ?? 0) > 0)
    .sort((a, b) => (b.mtime ?? 0) - (a.mtime ?? 0));
  return candidates[0] || null;
}

function toIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function truncate(text: unknown, maxLen: number): string {
  if (text === null || text === undefined) return '';
  const s = String(text);
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

function buildMatchFromRefined(
  refined: {
    sessionId: string;
    turnId: number;
    timestamp: string | undefined;
    summary: string;
    facts: string[];
    notes: string[];
    score: number;
  },
  terms: string[],
  options: SearchOptions = {},
): SearchMatch {
  // Refined summaries already condense user intent, tool usage, and agent lead.
  // Use them as the primary content when the original wire is unavailable.
  const snippetSource = [refined.summary, ...refined.facts, ...refined.notes].join('\n');
  const agentMaxLen = options.agentMaxLen ?? SEARCH_AGENT_MAX_LEN;
  const snippetMaxLen = options.snippetMaxLen ?? SEARCH_SNIPPET_MAX_LEN;
  return {
    sessionId: refined.sessionId,
    turnId: refined.turnId,
    timestamp: refined.timestamp ?? null,
    score: refined.score,
    user: '',
    agent: truncate(refined.summary, agentMaxLen),
    snippet: extractSnippet(snippetSource, terms, snippetMaxLen),
    actions: [],
    source: 'refined-only',
  };
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

export interface ParseWireFileOptions {
  startOffset?: number;
  endOffset?: number;
  initialTurnId?: number;
}

/**
 * Parse a wire.jsonl file and return conversation turns + session-level
 * compaction summaries. Offsets are byte offsets at complete-line boundaries.
 */
export function parseWireFile(
  wirePath: string,
  options: ParseWireFileOptions = {},
): Promise<{ turns: WireTurn[]; compactionSummaries: CompactionSummary[] }> {
  return new Promise((resolve, reject) => {
    if (!wirePath || !fs.existsSync(wirePath) || options.endOffset === 0) {
      return resolve({ turns: [], compactionSummaries: [] });
    }

    const turns = new Map<string, WireTurn>();
    const pendingActions = new Map<string, WireAction>();
    const compactionSummaries: CompactionSummary[] = [];
    let nextUserTurnId = options.initialTurnId ?? 0;

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

    const stream = fs.createReadStream(wirePath, {
      encoding: 'utf8',
      ...(options.startOffset && options.startOffset > 0 ? { start: options.startOffset } : {}),
      ...(options.endOffset !== undefined && options.endOffset > 0
        ? { end: options.endOffset - 1 }
        : {}),
    });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      metrics.increment('wire_parse_lines');
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        metrics.increment('wire_parse_corrupt_lines');
        return;
      }
      if (!event || typeof event !== 'object' || Array.isArray(event)) {
        metrics.increment('wire_parse_corrupt_lines');
        return;
      }

      try {
        if (event.type === 'turn.prompt') {
          const turnId = String(nextUserTurnId);
          nextUserTurnId += 1;
          const turn = ensureTurn(turnId);
          const input = Array.isArray(event.input) ? event.input : [];
          const text = (input as Array<{ type?: string; text?: unknown }>)
            .filter((p) => p && p.type === 'text')
            .map((p) => String(p.text ?? ''))
            .join('\n');
          turn.user = text;
          if (event.time && !turn.timestamp) {
            turn.timestamp = toIsoTimestamp(event.time);
          }
          return;
        }

        if (event.type === 'context.apply_compaction' && event.summary) {
          compactionSummaries.push({
            time: toIsoTimestamp(event.time),
            summary: String(event.summary),
          });
          return;
        }

        if (event.type !== 'context.append_loop_event') return;
        const ev = event.event;
        if (!ev || typeof ev !== 'object' || !ev.type) return;

        const turnId = ev.turnId;

        if (ev.type === 'step.begin' && turnId !== null && turnId !== undefined) {
          const turn = ensureTurn(turnId);
          if (event.time && !turn.timestamp) {
            turn.timestamp = toIsoTimestamp(event.time);
          }
          return;
        }

        if (ev.type === 'content.part' && turnId !== null && turnId !== undefined) {
          const turn = ensureTurn(turnId);
          const part = ev.part && typeof ev.part === 'object' ? ev.part : {};
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
        }
      } catch {
        metrics.increment('wire_parse_corrupt_lines');
      }
    });

    rl.on('error', reject);
    rl.on('close', () => {
      metrics.increment('wire_parse_sessions');
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

/**
 * Build the searchable haystack of a raw turn.
 *
 * The same field set is used for matching and for scoring so both stay
 * consistent with the refined path.
 */
function rawHaystack(turn: WireTurn): string {
  return `${turn.user}\n${turn.agentText}\n${turn.actions.map((a) => a.name).join(' ')}`;
}

/**
 * Date filter shared by the raw and the refined path.
 *
 * A turn without a timestamp cannot satisfy a date filter: it is dropped
 * instead of being silently accepted or silently rejected.
 */
function inDateRange(
  timestamp: string | null | undefined,
  dateFrom: string | null,
  dateTo: string | null,
): boolean {
  if (!dateFrom && !dateTo) return true;
  if (!timestamp) return false;
  const day = timestamp.slice(0, 10);
  if (dateFrom && day < dateFrom) return false;
  if (dateTo && day > dateTo) return false;
  return true;
}

/**
 * Stable ordering: score desc, timestamp desc, session id, turn id.
 */
function compareMatches(a: SearchMatch, b: SearchMatch): number {
  if (b.score !== a.score) return b.score - a.score;
  const at = a.timestamp ? Date.parse(a.timestamp) : 0;
  const bt = b.timestamp ? Date.parse(b.timestamp) : 0;
  if (bt !== at) return bt - at;
  if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
  return a.turnId - b.turnId;
}

/**
 * Clamp the requested limit into the supported range.
 */
export function resolveSearchLimit(limit: unknown): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_SEARCH_LIMIT);
}

/**
 * Resolve the per-request wire scan budget (option > env > default).
 */
export function resolveMaxScanBytes(maxScanBytes?: number): number {
  if (typeof maxScanBytes === 'number' && Number.isFinite(maxScanBytes) && maxScanBytes > 0) {
    return Math.floor(maxScanBytes);
  }
  const fromEnv = Number(process.env[MAX_SCAN_BYTES_ENV]);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return Math.floor(fromEnv);
  return DEFAULT_MAX_SCAN_BYTES;
}

function safeFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * Search across all workspace session wires for rounds matching the query.
 *
 * Retrieval contract:
 *   - the session list is discovered exactly once per request;
 *   - refined candidates and raw wire turns are merged, never short-circuited:
 *     a refined hit never suppresses an unrefined raw match;
 *   - when the original wire exists it is authoritative: the turn is matched
 *     and scored again from the original text;
 *   - only turns that are missing from the wire fall back to `refined-only`;
 *   - all terms must match (AND); scoring only affects the ordering;
 *   - `limit` is applied after the merge (default 10, max 100);
 *   - an exhausted scan budget yields a partial result with an explicit
 *     reason, the unfinished session ids and a resume cursor — the total is
 *     not reported in that case;
 *   - a cursor resumes at the first unfinished session and never reports a
 *     global total or repeats refined-only rows from the first page.
 */
export async function searchWireContext(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult> {
  const limit = resolveSearchLimit(options.limit);
  const dateFrom = options.dateFrom || null;
  const dateTo = options.dateTo || null;
  const refinedManager = options.refinedManager;
  const userMaxLen = options.userMaxLen ?? SEARCH_USER_MAX_LEN;
  const agentMaxLen = options.agentMaxLen ?? SEARCH_AGENT_MAX_LEN;
  const snippetMaxLen = options.snippetMaxLen ?? SEARCH_SNIPPET_MAX_LEN;
  const terms = normalizeTerms(query);

  if (terms.length === 0) {
    return {
      query,
      totalMatches: 0,
      matchCount: 0,
      isComplete: true,
      skippedSessionIds: [],
      matches: [],
      hits: [],
    };
  }

  // One discovery per request; the result is shared by every scan step.
  const sessions = findAllWorkspaceSessions();
  const sessionById = new Map(sessions.map((s) => [s.sessionId, s]));
  const ordered = [...sessions].sort((a, b) => {
    const am = a.mtime ?? 0;
    const bm = b.mtime ?? 0;
    if (bm !== am) return bm - am;
    if (a.sessionId === b.sessionId) return 0;
    return a.sessionId < b.sessionId ? -1 : 1;
  });
  const cursor = options.cursor?.trim() || undefined;
  const cursorIndex = cursor ? ordered.findIndex((session) => session.sessionId === cursor) : -1;
  if (cursor && cursorIndex < 0) {
    return {
      query,
      matchCount: 0,
      isComplete: false,
      truncationReason: 'invalid-cursor',
      skippedSessionIds: [],
      nextCursor: cursor,
      matches: [],
      hits: [],
    };
  }
  const pageSessions = cursor ? ordered.slice(cursorIndex) : ordered;

  const maxScanBytes = resolveMaxScanBytes(options.maxScanBytes);
  let bytesScanned = 0;
  let isComplete = true;
  let truncationReason: string | undefined;
  const skippedSessionIds: string[] = [];
  let nextCursor: string | undefined;

  /** Turn ids that exist in the wire of a scanned session. */
  const scannedTurnIds = new Map<string, Set<number>>();
  /** Raw matches keyed by sessionId + turnId. */
  const rawMatches = new Map<string, { match: SearchMatch; turn: WireTurn }>();

  for (const session of pageSessions) {
    if (options.signal?.aborted) {
      // The caller cancelled the request: report what was scanned so far as
      // a partial result instead of pretending the scan finished.
      isComplete = false;
      truncationReason = 'request-cancelled';
      if (!nextCursor) nextCursor = session.sessionId;
      break;
    }
    const size = safeFileSize(session.wire);
    if (bytesScanned + size > maxScanBytes) {
      isComplete = false;
      truncationReason = 'scan-budget-exceeded';
      if (size > maxScanBytes) {
        // This session alone can never fit into the budget on any page:
        // skip it permanently and let the cursor advance past it, so the
        // pagination makes progress instead of returning the same
        // nextCursor forever.
        skippedSessionIds.push(session.sessionId);
        continue;
      }
      // Normal budget exhaustion: stop the page here and resume with this
      // session on the next one. Scanning past the boundary in the same
      // page would duplicate these sessions on the resume page.
      skippedSessionIds.push(session.sessionId);
      if (!nextCursor) nextCursor = session.sessionId;
      break;
    }
    bytesScanned += size;

    const { turns } = await parseWireFile(session.wire);
    const turnIds = new Set<number>();
    for (const turn of turns) {
      const turnId = parseInt(turn.turnId, 10);
      turnIds.add(turnId);
      if (!inDateRange(turn.timestamp, dateFrom, dateTo)) continue;

      const haystack = rawHaystack(turn);
      if (!hasAllTerms(haystack, terms)) continue;
      const score = scoreText(haystack, terms);

      const match: SearchMatch = {
        sessionId: session.sessionId,
        turnId,
        timestamp: turn.timestamp || null,
        score,
        user: truncate(turn.user, userMaxLen),
        agent: truncate(turn.agentText, agentMaxLen),
        snippet: extractSnippet(`${turn.user}\n${turn.agentText}`, terms, snippetMaxLen),
        actions: turn.actions.map((a) => a.name).filter(Boolean),
        source: 'wire',
      };
      rawMatches.set(`${session.sessionId}:${turnId}`, { match, turn });
    }
    scannedTurnIds.set(session.sessionId, turnIds);
  }

  // Refined candidates that are not covered by the raw scan.
  const refinedOnlyMatches: SearchMatch[] = [];
  let corruptRefinedRows = 0;

  if (refinedManager) {
    const outcome = refinedManager.searchRefinedTurnsDetailed({
      query,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    });
    corruptRefinedRows = outcome.corruptRows.length;
    if (outcome.rowLimitReached) {
      isComplete = false;
      truncationReason = truncationReason ?? 'refined-row-limit-reached';
    }
    if (outcome.corruptRows.length > 0) {
      // A row that cannot be decoded might have been a match, so the scan
      // cannot be certified as complete.
      isComplete = false;
      truncationReason = truncationReason ?? 'corrupt-refined-rows';
    }

    for (const refined of outcome.matches) {
      const key = `${refined.sessionId}:${refined.turnId}`;
      if (rawMatches.has(key)) continue;

      const scannedIds = scannedTurnIds.get(refined.sessionId);
      if (scannedIds) {
        // The wire was scanned: the original turn is authoritative. When the
        // turn is still there the raw match (or the absence of one) decides.
        if (scannedIds.has(refined.turnId)) continue;
        // The turn disappeared from the wire: fall back to the refined record.
      } else if (sessionById.has(refined.sessionId)) {
        // The session exists but was not scanned (budget exhausted or outside
        // this cursor page). The original wire remains authoritative.
        continue;
      } else if (cursor) {
        // Refined-only rows have no wire ordering and were already eligible on
        // the first page, so do not duplicate them on cursor pages.
        continue;
      }

      if (!inDateRange(refined.timestamp ?? null, dateFrom, dateTo)) continue;
      refinedOnlyMatches.push(buildMatchFromRefined(refined, terms, options));
    }
  }

  const merged: Array<{ match: SearchMatch; turn?: WireTurn }> = [
    ...Array.from(rawMatches.values()),
    ...refinedOnlyMatches.map((match) => ({ match })),
  ];
  merged.sort((a, b) => compareMatches(a.match, b.match));

  const matchCount = merged.length;
  const selected = merged.slice(0, limit);
  const matches = selected.map((entry) => entry.match);
  // Only the returned matches contribute hits, so downstream cluster and
  // refinement work stays proportional to the response, not to the corpus.
  const hits = selected
    .filter((entry) => entry.turn)
    .map((entry) => ({
      sessionId: entry.match.sessionId,
      turn: entry.turn!,
      wire: sessionById.get(entry.match.sessionId)!.wire,
    }));

  return {
    query,
    totalMatches: isComplete && !cursor ? matchCount : undefined,
    matchCount,
    isComplete,
    truncationReason,
    skippedSessionIds,
    nextCursor,
    corruptRefinedRows: corruptRefinedRows > 0 ? corruptRefinedRows : undefined,
    matches,
    hits,
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
