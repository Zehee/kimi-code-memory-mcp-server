/**
 * Search view storage.
 *
 * A search view is a snapshot of one `search_context` call. Views are the
 * only place where refined turns are referenced by more than one consumer
 * (besides themes), so the repository owns the strict key format and the
 * path-safety rules.
 *
 * Key format (strict):
 *   - `search-<12 lowercase hex>`   legacy views written by v0.5.x (read/delete only)
 *   - `search-v2-<32 lowercase hex>` views written by this version
 *
 * Nothing else is accepted: no file extension, no upper-case hex, no path
 * separators, no traversal. New views always use the v2 format and carry the
 * full query parameters inside the file instead of encoding them in the file
 * name.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/** Strict key format shared by every read, write and delete path. */
export const SEARCH_VIEW_KEY_PATTERN = /^search-(?:[a-f0-9]{12}|v2-[a-f0-9]{32})$/;

/** Schema version of newly written search views. */
export const SEARCH_VIEW_SCHEMA_VERSION = 1;

/** Key of a view that was written before the v2 format existed. */
export const LEGACY_SEARCH_VIEW_PATTERN = /^search-[a-f0-9]{12}$/;

/** Invalid key — maps to HTTP 400 / tool error. */
export class InvalidSearchViewKeyError extends Error {
  readonly statusCode = 400;
  readonly code = 'invalid_search_view_key';
  readonly key: string;

  constructor(key: string) {
    super(
      `Invalid search view key: ${JSON.stringify(key)}. Expected ${SEARCH_VIEW_KEY_PATTERN.source}.`,
    );
    this.name = 'InvalidSearchViewKeyError';
    this.key = key;
  }
}

/** View does not exist — maps to HTTP 404. */
export class SearchViewNotFoundError extends Error {
  readonly statusCode = 404;
  readonly code = 'search_view_not_found';
  readonly key: string;

  constructor(key: string) {
    super(`Search view not found: ${key}`);
    this.name = 'SearchViewNotFoundError';
    this.key = key;
  }
}

/** The view file escapes the search view directory (symlink / alias). */
export class SearchViewAccessError extends Error {
  readonly statusCode = 400;
  readonly code = 'search_view_access_denied';
  readonly key: string;

  constructor(key: string, reason: string) {
    super(`Refusing to access search view ${key}: ${reason}`);
    this.name = 'SearchViewAccessError';
    this.key = key;
  }
}

/** The view file exists but cannot be decoded. */
export class SearchViewCorruptError extends Error {
  readonly statusCode = 500;
  readonly code = 'search_view_corrupt';
  readonly key: string;

  constructor(key: string, reason: string) {
    super(`Search view ${key} is corrupted: ${reason}`);
    this.name = 'SearchViewCorruptError';
    this.key = key;
  }
}

export interface SearchViewFilters {
  dateFrom: string | null;
  dateTo: string | null;
  limit: number;
  clusterGapSeconds: number;
  maxClusterSize: number;
}

export interface SearchViewCounts {
  /** Complete match total; only trustworthy when the scan was complete. */
  totalMatches: number;
  /** Matches discovered during the scan, before `limit` was applied. */
  matchCount: number;
  /** Whether the underlying scan visited every candidate. */
  isComplete: boolean;
  /** Number of turns that were refined while building this view. */
  totalRefined: number;
  /** Sessions that could not be scanned (budget exhausted). */
  skippedSessionIds: string[];
}

export interface SearchViewMember {
  sessionId: string;
  turnId: number;
}

export interface SearchViewCluster {
  sessionId: string;
  hitTurnId: number;
  memberCount: number;
  refinedCount: number;
  members: SearchViewMember[];
}

export interface SearchViewRecord {
  schemaVersion: number;
  /** v2 key of the view (`search-v2-<32 hex>`), or the legacy key. */
  id: string;
  /** File key (without the `.json` extension). */
  key: string;
  query: string;
  filters: SearchViewFilters;
  createdAt: string;
  counts: SearchViewCounts;
  clusters: SearchViewCluster[];
  /** True when the view was written with the legacy (pre-v2) format. */
  legacy: boolean;
}

export interface SaveSearchViewInput {
  query: string;
  filters?: Partial<SearchViewFilters>;
  counts?: Partial<SearchViewCounts>;
  clusters?: SearchViewCluster[];
  createdAt?: string;
}

export interface SearchViewSummary {
  key: string;
  id: string;
  query: string;
  createdAt: string;
  clusterCount: number;
  matchCount: number;
  isComplete: boolean;
  legacy: boolean;
}

const DEFAULT_FILTERS: SearchViewFilters = {
  dateFrom: null,
  dateTo: null,
  limit: 10,
  clusterGapSeconds: 90,
  maxClusterSize: 15,
};

const DEFAULT_COUNTS: SearchViewCounts = {
  totalMatches: 0,
  matchCount: 0,
  isComplete: true,
  totalRefined: 0,
  skippedSessionIds: [],
};

/**
 * Generate a new random v2 key.
 */
export function generateSearchViewKey(): string {
  return `search-v2-${crypto.randomBytes(16).toString('hex')}`;
}

export function isValidSearchViewKey(key: unknown): boolean {
  return typeof key === 'string' && SEARCH_VIEW_KEY_PATTERN.test(key);
}

function toNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizeMembers(value: unknown): SearchViewMember[] {
  if (!Array.isArray(value)) return [];
  const members: SearchViewMember[] = [];
  for (const member of value) {
    if (!member || typeof member !== 'object') continue;
    const record = member as Record<string, unknown>;
    if (typeof record.sessionId !== 'string') continue;
    const turnId = Number(record.turnId);
    if (!Number.isFinite(turnId)) continue;
    members.push({ sessionId: record.sessionId, turnId: Math.trunc(turnId) });
  }
  return members;
}

function normalizeClusters(value: unknown): SearchViewCluster[] {
  if (!Array.isArray(value)) return [];
  const clusters: SearchViewCluster[] = [];
  for (const cluster of value) {
    if (!cluster || typeof cluster !== 'object') continue;
    const record = cluster as Record<string, unknown>;
    if (typeof record.sessionId !== 'string') continue;
    const members = normalizeMembers(record.members);
    const hitTurnId = Number(record.hitTurnId);
    clusters.push({
      sessionId: record.sessionId,
      hitTurnId: Number.isFinite(hitTurnId) ? Math.trunc(hitTurnId) : (members[0]?.turnId ?? 0),
      memberCount: toNumber(record.memberCount, members.length),
      refinedCount: toNumber(record.refinedCount, 0),
      members,
    });
  }
  return clusters;
}

/**
 * Convert a raw JSON payload into the normalized record shape.
 *
 * Legacy views (v0.5.x) stored `gapSeconds` / `maxClusterSize` / `totalMatches`
 * at the top level; they are mapped onto the v2 shape on read so callers do
 * not need two code paths. Legacy views are never rewritten automatically.
 */
function normalizeRecord(
  key: string,
  data: Record<string, unknown>,
  fallbackCreatedAt: string,
): SearchViewRecord {
  const schemaVersion = toNumber(data.schemaVersion, 0);
  const legacy = schemaVersion < SEARCH_VIEW_SCHEMA_VERSION;

  const rawFilters = (data.filters ?? {}) as Record<string, unknown>;
  const filters: SearchViewFilters = {
    dateFrom: toStringOrNull(rawFilters.dateFrom),
    dateTo: toStringOrNull(rawFilters.dateTo),
    limit: toNumber(rawFilters.limit, DEFAULT_FILTERS.limit),
    clusterGapSeconds: toNumber(
      rawFilters.clusterGapSeconds,
      toNumber(data.gapSeconds, DEFAULT_FILTERS.clusterGapSeconds),
    ),
    maxClusterSize: toNumber(
      rawFilters.maxClusterSize,
      toNumber(data.maxClusterSize, DEFAULT_FILTERS.maxClusterSize),
    ),
  };

  const rawCounts = (data.counts ?? {}) as Record<string, unknown>;
  const counts: SearchViewCounts = {
    totalMatches: toNumber(rawCounts.totalMatches, toNumber(data.totalMatches, 0)),
    matchCount: toNumber(rawCounts.matchCount, toNumber(data.totalMatches, 0)),
    isComplete: typeof rawCounts.isComplete === 'boolean' ? rawCounts.isComplete : true,
    totalRefined: toNumber(rawCounts.totalRefined, toNumber(data.totalRefined, 0)),
    skippedSessionIds: Array.isArray(rawCounts.skippedSessionIds)
      ? (rawCounts.skippedSessionIds as unknown[]).filter(
          (id): id is string => typeof id === 'string',
        )
      : Array.isArray(data.skippedSessions)
        ? (data.skippedSessions as unknown[]).filter(
            (id): id is string => typeof id === 'string',
          )
        : [],
  };

  return {
    schemaVersion: legacy ? 0 : schemaVersion,
    id: typeof data.id === 'string' && data.id ? data.id : key,
    key,
    query: typeof data.query === 'string' ? data.query : '',
    filters,
    createdAt: typeof data.createdAt === 'string' ? data.createdAt : fallbackCreatedAt,
    counts,
    clusters: normalizeClusters(data.clusters),
    legacy,
  };
}

export class SearchViewRepository {
  /** Workspace store root (the directory that contains `searches/`). */
  readonly storeRoot: string;

  constructor(storeRoot: string) {
    this.storeRoot = storeRoot;
  }

  get searchesRoot(): string {
    return path.join(this.storeRoot, 'searches');
  }

  /**
   * Validate a key and resolve it to an absolute file path.
   *
   * Throws `InvalidSearchViewKeyError` for anything that is not a strict
   * legacy or v2 key — including keys with a `.json` extension, upper-case
   * hex, path separators or traversal segments.
   */
  resolveKey(key: string): string {
    const raw = typeof key === 'string' ? key.trim() : '';
    if (!SEARCH_VIEW_KEY_PATTERN.test(raw)) {
      throw new InvalidSearchViewKeyError(String(key));
    }
    const root = path.resolve(this.searchesRoot);
    const resolved = path.resolve(root, `${raw}.json`);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new InvalidSearchViewKeyError(String(key));
    }
    return resolved;
  }

  /**
   * Reject files that leave the search view directory through a symlink or a
   * directory alias. Only meaningful for files that exist.
   */
  private assertWithinRoot(key: string, filePath: string): void {
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(filePath);
    } catch {
      // Missing file: nothing to escape through.
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new SearchViewAccessError(key, 'file is a symbolic link');
    }

    const root = path.resolve(this.searchesRoot);
    let realRoot = root;
    try {
      realRoot = fs.realpathSync.native(root);
    } catch {
      // The directory may not exist yet.
    }
    let realFile: string;
    try {
      realFile = fs.realpathSync.native(filePath);
    } catch {
      return;
    }
    const relative = path.relative(realRoot, realFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new SearchViewAccessError(key, 'real path escapes the search view directory');
    }
  }

  /**
   * Persist a new view. Always writes a fresh v2 key.
   */
  save(input: SaveSearchViewInput): SearchViewRecord {
    const key = generateSearchViewKey();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const record: SearchViewRecord = {
      schemaVersion: SEARCH_VIEW_SCHEMA_VERSION,
      id: key,
      key,
      query: typeof input.query === 'string' ? input.query : '',
      createdAt,
      filters: {
        dateFrom: input.filters?.dateFrom ?? DEFAULT_FILTERS.dateFrom,
        dateTo: input.filters?.dateTo ?? DEFAULT_FILTERS.dateTo,
        limit: toNumber(input.filters?.limit, DEFAULT_FILTERS.limit),
        clusterGapSeconds: toNumber(
          input.filters?.clusterGapSeconds,
          DEFAULT_FILTERS.clusterGapSeconds,
        ),
        maxClusterSize: toNumber(
          input.filters?.maxClusterSize,
          DEFAULT_FILTERS.maxClusterSize,
        ),
      },
      counts: {
        totalMatches: toNumber(input.counts?.totalMatches, DEFAULT_COUNTS.totalMatches),
        matchCount: toNumber(input.counts?.matchCount, DEFAULT_COUNTS.matchCount),
        isComplete:
          typeof input.counts?.isComplete === 'boolean'
            ? input.counts.isComplete
            : DEFAULT_COUNTS.isComplete,
        totalRefined: toNumber(input.counts?.totalRefined, DEFAULT_COUNTS.totalRefined),
        skippedSessionIds: Array.isArray(input.counts?.skippedSessionIds)
          ? input.counts.skippedSessionIds
          : [],
      },
      clusters: normalizeClusters(input.clusters ?? []),
      legacy: false,
    };

    const filePath = this.resolveKey(key);
    fs.mkdirSync(this.searchesRoot, { recursive: true });
    // Reject writing through an existing symlink.
    this.assertWithinRoot(key, filePath);

    const payload = {
      schemaVersion: record.schemaVersion,
      id: record.id,
      query: record.query,
      filters: record.filters,
      createdAt: record.createdAt,
      counts: record.counts,
      clusters: record.clusters,
    };
    this.writeAtomic(filePath, JSON.stringify(payload, null, 2));
    return record;
  }

  private writeAtomic(filePath: string, content: string): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = path.join(
      dir,
      `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      fs.writeFileSync(tmpPath, content, 'utf8');
      fs.renameSync(tmpPath, filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // Best effort cleanup.
      }
      throw err;
    }
  }

  /**
   * Load a view by key. Throws `SearchViewNotFoundError` when it is missing.
   */
  load(key: string): SearchViewRecord {
    const filePath = this.resolveKey(key);
    this.assertWithinRoot(key, filePath);
    if (!fs.existsSync(filePath)) {
      throw new SearchViewNotFoundError(key);
    }
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new SearchViewCorruptError(key, err instanceof Error ? err.message : String(err));
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new SearchViewCorruptError(key, err instanceof Error ? err.message : String(err));
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SearchViewCorruptError(key, 'payload is not a JSON object');
    }
    let mtime = new Date().toISOString();
    try {
      mtime = fs.statSync(filePath).mtime.toISOString();
    } catch {
      // Keep the fallback timestamp.
    }
    return normalizeRecord(key.trim(), parsed as Record<string, unknown>, mtime);
  }

  /**
   * Load a view without throwing when it is missing.
   */
  tryLoad(key: string): SearchViewRecord | null {
    try {
      return this.load(key);
    } catch {
      return null;
    }
  }

  /**
   * List every valid view, newest first.
   */
  listAll(): SearchViewRecord[] {
    const dir = this.searchesRoot;
    if (!fs.existsSync(dir)) return [];
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return [];
    }
    const records: SearchViewRecord[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const key = entry.slice(0, -'.json'.length);
      if (!SEARCH_VIEW_KEY_PATTERN.test(key)) continue;
      const record = this.tryLoad(key);
      if (record) records.push(record);
    }
    records.sort((a, b) => {
      const at = Date.parse(a.createdAt);
      const bt = Date.parse(b.createdAt);
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
      if (a.key < b.key) return -1;
      if (a.key > b.key) return 1;
      return 0;
    });
    return records;
  }

  /**
   * Summaries of the stored views, newest first.
   */
  list(limit?: number): SearchViewSummary[] {
    const records = this.listAll();
    const sliced = typeof limit === 'number' && limit > 0 ? records.slice(0, limit) : records;
    return sliced.map((record) => ({
      key: record.key,
      id: record.id,
      query: record.query,
      createdAt: record.createdAt,
      clusterCount: record.clusters.length,
      matchCount: record.counts.matchCount,
      isComplete: record.counts.isComplete,
      legacy: record.legacy,
    }));
  }

  /**
   * Delete a view. Throws `SearchViewNotFoundError` when it is missing.
   */
  delete(key: string): void {
    const filePath = this.resolveKey(key);
    this.assertWithinRoot(key, filePath);
    if (!fs.existsSync(filePath)) {
      throw new SearchViewNotFoundError(key);
    }
    fs.unlinkSync(filePath);
  }

  /**
   * Collect every refined turn reference used by the stored views.
   * `excludeKey` allows callers to ignore the view they are about to delete.
   */
  collectReferencedTurns(excludeKey?: string): Map<string, { sessionId: string; turnId: number }> {
    const refs = new Map<string, { sessionId: string; turnId: number }>();
    for (const record of this.listAll()) {
      if (excludeKey && record.key === excludeKey) continue;
      for (const cluster of record.clusters) {
        for (const member of cluster.members) {
          refs.set(`${member.sessionId}:${member.turnId}`, {
            sessionId: member.sessionId,
            turnId: member.turnId,
          });
        }
      }
    }
    return refs;
  }
}
