/**
 * Host workspace resolution (Kimi Code 2.6.3 `main`).
 *
 * Facts this module is built on (see
 * `memory/knowledge/kimi-host-workspace-mcp-lifecycle.md`):
 *
 *   - An *implicit* workspace is `wd_<slug>_<sha256(cwd)[0..12]>`; the cwd is
 *     normalized by replacing backslashes and trimming trailing slashes —
 *     **no realpath**. The hash therefore has to stay byte-compatible with the
 *     value the host wrote.
 *   - A *managed* workspace is `wm_<uuid>` and is registered in
 *     `$KIMI_CODE_HOME/projects.json` (`id` / `root` / `kind`). Its id stays
 *     stable when the primary directory changes.
 *   - `$KIMI_CODE_HOME/session_index.jsonl` records `sessionId`, `sessionDir`
 *     and `workDir` for every session.
 *   - Session directories live in `sessions/<workspaceId>/<sessionId>/`, and
 *     the wire is `<sessionDir>/agents/main/wire.jsonl`.
 *
 * Consequences for this project:
 *   - The *legacy* cwd hash and the legacy `mcp-config.json` mapping stay the
 *     bucketing basis. `realpath` is only ever used as a secondary alias
 *     comparison, never to derive a directory name or a hash.
 *   - Discovery has to cover `wd_*` **and** `wm_*` directories and has to
 *     consult `projects.json` / `session_index.jsonl` to know which managed
 *     workspace belongs to the current work directory.
 *   - When the host metadata is missing or corrupted, discovery falls back to
 *     the legacy hash based lookup.
 *
 * This module never reads conversation content: it only inspects directory
 * names and the host's own metadata files.
 */

import fs from 'fs';
import path from 'path';
import { computeWorkspaceHash } from '../utils/paths.js';
import { safeRealpath } from './canonical-path.js';

/** Prefix of an implicit (cwd derived) host workspace id. */
export const IMPLICIT_WORKSPACE_PREFIX = 'wd_';

/** Prefix of a managed host workspace id. */
export const MANAGED_WORKSPACE_PREFIX = 'wm_';

/** A project registered in the host's `projects.json`. */
export interface HostProject {
  id: string;
  root: string;
  kind: string;
  name?: string;
}

/** One row of the host's `session_index.jsonl`. */
export interface HostSessionEntry {
  sessionId: string;
  sessionDir: string;
  workDir: string;
}

/** How a workspace directory was discovered. */
export type HostWorkspaceSource = 'hash' | 'projects' | 'session-index';

export interface HostWorkspaceDescriptor {
  /** Directory name below `sessions/`, e.g. `wd_app_1a2b3c4d5e6f` or `wm_<uuid>`. */
  id: string;
  kind: 'implicit' | 'managed' | 'unknown';
  source: HostWorkspaceSource;
  /** Project root, when known. */
  root?: string;
}

/**
 * Normalize a work directory the way the host does: forward slashes and no
 * trailing slash. No realpath — the host hashes the literal path.
 */
export function normalizeWorkDir(input: unknown): string {
  let value = String(input ?? '').replace(/\\/g, '/');
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

/**
 * Hash candidates for a work directory.
 *
 * The first entry is the legacy project hash (slashes only), the second one is
 * the host hash (slashes + trimmed trailing slash). For ordinary paths both
 * are identical; the legacy entry keeps existing workspaces discoverable.
 */
export function workDirHashCandidates(workDir: unknown): string[] {
  const slashOnly = String(workDir ?? '').replace(/\\/g, '/');
  const trimmed = normalizeWorkDir(workDir);
  const candidates: string[] = [];
  for (const value of [slashOnly, trimmed]) {
    if (!value) continue;
    const hash = computeWorkspaceHash(value);
    if (!candidates.includes(hash)) candidates.push(hash);
  }
  return candidates;
}

/**
 * Compare two work directories.
 *
 * The literal (normalized) form decides. Only when it differs, the real paths
 * are compared as an alias fallback — a symlinked alias of the same directory
 * still counts as the same workspace. Real paths are never used to derive a
 * directory name or a hash.
 */
export function sameWorkDir(a: unknown, b: unknown): boolean {
  const left = normalizeWorkDir(a);
  const right = normalizeWorkDir(b);
  if (!left || !right) return false;
  if (left === right) return true;
  if (process.platform === 'win32' && left.toLowerCase() === right.toLowerCase()) return true;

  const realLeft = safeRealpath(left);
  const realRight = safeRealpath(right);
  if (!realLeft || !realRight) return false;
  const keyLeft = realLeft.replace(/\\/g, '/');
  const keyRight = realRight.replace(/\\/g, '/');
  if (keyLeft === keyRight) return true;
  return process.platform === 'win32' && keyLeft.toLowerCase() === keyRight.toLowerCase();
}

function hasHostMetadata(dir: string): boolean {
  try {
    return (
      fs.existsSync(path.join(dir, 'projects.json')) ||
      fs.existsSync(path.join(dir, 'session_index.jsonl'))
    );
  } catch {
    return false;
  }
}

/**
 * Locate the host metadata directory (`projects.json` / `session_index.jsonl`).
 *
 * Returns `null` when the host metadata is not available — the caller then
 * falls back to the legacy hash based discovery.
 */
export function resolveHostHome(sessionsRoot: string): string | null {
  const resolved = path.resolve(sessionsRoot);
  const candidates: string[] = [];

  const envHome = process.env.KIMI_CODE_HOME;
  if (envHome && !process.env.MEMORY_SESSIONS_ROOT) {
    candidates.push(path.resolve(envHome));
  }
  if (path.basename(resolved) === 'sessions') {
    candidates.push(path.dirname(resolved));
  }
  candidates.push(resolved);

  for (const candidate of candidates) {
    if (hasHostMetadata(candidate)) return candidate;
  }
  return null;
}

/**
 * Read `projects.json`.
 *
 * Supports the current schema (`{ projects: { <id>: { root, kind } } }`) and
 * degrades to an empty map when the file is missing or corrupted.
 */
export function readHostProjects(hostHome: string | null): Map<string, HostProject> {
  const projects = new Map<string, HostProject>();
  if (!hostHome) return projects;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(hostHome, 'projects.json'), 'utf8');
  } catch {
    return projects;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupted metadata: fall back to the legacy discovery.
    return projects;
  }
  if (!parsed || typeof parsed !== 'object') return projects;

  const container = (parsed as Record<string, unknown>).projects;
  const entries: Array<[string, unknown]> = [];
  if (container && typeof container === 'object' && !Array.isArray(container)) {
    for (const [id, value] of Object.entries(container as Record<string, unknown>)) {
      entries.push([id, value]);
    }
  } else if (Array.isArray(container)) {
    for (const value of container) {
      if (!value || typeof value !== 'object') continue;
      const record = value as Record<string, unknown>;
      if (typeof record.id === 'string') entries.push([record.id, value]);
    }
  } else {
    // A bare map of id -> project (older layout).
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      entries.push([id, value]);
    }
  }

  for (const [id, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const record = value as Record<string, unknown>;
    const root = typeof record.root === 'string' ? record.root : '';
    if (!root) continue;
    projects.set(id, {
      id,
      root,
      kind: typeof record.kind === 'string' ? record.kind : '',
      name: typeof record.name === 'string' ? record.name : undefined,
    });
  }
  return projects;
}

/**
 * Read `session_index.jsonl`.
 *
 * Malformed rows are skipped; a missing or corrupted file yields an empty
 * list so that discovery can fall back to the legacy lookup.
 */
export function readHostSessionIndex(hostHome: string | null): HostSessionEntry[] {
  const entries: HostSessionEntry[] = [];
  if (!hostHome) return entries;
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(hostHome, 'session_index.jsonl'), 'utf8');
  } catch {
    return entries;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const record = parsed as Record<string, unknown>;
    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : '';
    const sessionDir = typeof record.sessionDir === 'string' ? record.sessionDir : '';
    const workDir = typeof record.workDir === 'string' ? record.workDir : '';
    if (!sessionId || !sessionDir || !workDir) continue;
    entries.push({ sessionId, sessionDir, workDir });
  }
  return entries;
}

/**
 * Session index rows that belong to the given work directory.
 */
export function resolveHostSessionEntries(
  workDir: string,
  sessionsRoot: string,
): HostSessionEntry[] {
  const hostHome = resolveHostHome(sessionsRoot);
  if (!hostHome) return [];
  return readHostSessionIndex(hostHome).filter((entry) => sameWorkDir(entry.workDir, workDir));
}

/**
 * Workspace directory name of a session directory (`sessions/<id>/<session>`).
 */
export function workspaceIdFromSessionDir(
  sessionDir: string,
  sessionsRoot: string,
): string | null {
  const root = path.resolve(sessionsRoot);
  const resolved = path.resolve(sessionDir);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  const segments = relative.split(/[\\/]/).filter(Boolean);
  if (segments.length < 2) return null;
  return segments[0];
}

function workspaceKind(id: string, projects: Map<string, HostProject>): 'implicit' | 'managed' | 'unknown' {
  const project = projects.get(id);
  if (project?.kind === 'managed') return 'managed';
  if (project?.kind === 'implicit') return 'implicit';
  if (id.startsWith(MANAGED_WORKSPACE_PREFIX)) return 'managed';
  if (id.startsWith(IMPLICIT_WORKSPACE_PREFIX)) return 'implicit';
  return 'unknown';
}

/**
 * Resolve every host workspace directory that can contain sessions of the
 * current work directory.
 *
 * Sources, in order:
 *   1. the legacy cwd hash (implicit workspaces) — the compatibility baseline;
 *   2. `projects.json` (managed workspaces and primary changes);
 *   3. `session_index.jsonl` (sessions recorded for this work directory).
 */
export function resolveWorkspaceDescriptors(
  workDir: string,
  sessionsRoot: string,
): HostWorkspaceDescriptor[] {
  const descriptors = new Map<string, HostWorkspaceDescriptor>();
  const projects = readHostProjects(resolveHostHome(sessionsRoot));

  const add = (descriptor: HostWorkspaceDescriptor): void => {
    if (!descriptors.has(descriptor.id)) descriptors.set(descriptor.id, descriptor);
  };

  // 1. Legacy / implicit discovery by cwd hash.
  const hashes = new Set(workDirHashCandidates(workDir));
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(sessionsRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const name = entry.name;
    const separator = name.lastIndexOf('_');
    if (separator <= 0) continue;
    if (!hashes.has(name.slice(separator + 1))) continue;
    add({ id: name, kind: workspaceKind(name, projects), source: 'hash' });
  }

  // 2. Managed workspaces registered by the host.
  for (const [id, project] of projects) {
    if (!sameWorkDir(project.root, workDir)) continue;
    add({ id, kind: workspaceKind(id, projects), source: 'projects', root: project.root });
  }

  // 3. Sessions the host recorded for this work directory.
  for (const entry of resolveHostSessionEntries(workDir, sessionsRoot)) {
    const id = workspaceIdFromSessionDir(entry.sessionDir, sessionsRoot);
    if (!id) continue;
    add({ id, kind: workspaceKind(id, projects), source: 'session-index' });
  }

  return Array.from(descriptors.values());
}
