/**
 * Security primitives for the kimi-memory-vis dashboard.
 *
 * Every protection of the dashboard HTTP surface lives here so the HTTP
 * server, the auto-start helper and the tests share a single implementation:
 *
 * - bearer tokens (random, compared in constant time),
 * - Host / Origin validation (DNS-rebinding and CSRF hardening),
 * - request body limits and JSON content-type enforcement,
 * - the per-workspace runtime file that lets sibling MCP processes discover
 *   an already running dashboard and authenticate against it.
 *
 * The runtime file is the only place the token is persisted on disk. It lives
 * in a private per-workspace directory and is written with restrictive
 * permissions (0600 on POSIX, inherited user ACL on Windows).
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createTempFilePath } from '../utils/paths.js';

export const VIS_RUNTIME_SCHEMA_VERSION = 1;

/** Maximum accepted request body for write endpoints (1 MiB). */
export const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** Minimum entropy of the dashboard token, in bytes. */
export const TOKEN_BYTES = 32;

/** How long an owner lease stays valid without a heartbeat. */
export const RUNTIME_LEASE_TTL_MS = 30_000;

/** How often the owner refreshes its heartbeat. */
export const RUNTIME_HEARTBEAT_INTERVAL_MS = 10_000;

export function generateVisToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function extractBearerToken(header: string | undefined | null): string | null {
  if (!header) return null;
  const match = /^Bearer[ \t]+(.+)$/i.exec(header.trim());
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

export function isValidBearer(header: string | undefined | null, expected: string): boolean {
  const token = extractBearerToken(header);
  if (!token) return false;
  return timingSafeEqual(token, expected);
}

/** Address/port the dashboard actually listens on. `port` is null while unknown. */
export interface ListenerInfo {
  hostname: string;
  port: number | null;
}

export function normalizeHostname(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  if (normalized === 'localhost') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/**
 * Non-loopback hostnames are refused: the dashboard is a local tool and must
 * never be reachable from the local network.
 */
export function isSupportedListenerHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

export interface ParsedHost {
  hostname: string;
  port: number | null;
}

export function parseHostHeader(header: string | undefined | null): ParsedHost | null {
  const raw = (header ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('[')) {
    const end = raw.indexOf(']');
    if (end === -1) return null;
    const hostname = raw.slice(0, end + 1);
    const rest = raw.slice(end + 1);
    if (!rest) return { hostname, port: null };
    if (!rest.startsWith(':')) return null;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) ? { hostname, port } : null;
  }
  const index = raw.indexOf(':');
  if (index === -1) return { hostname: raw, port: null };
  const hostname = raw.slice(0, index);
  const portPart = raw.slice(index + 1);
  if (!/^\d{1,5}$/.test(portPart)) return null;
  return { hostname, port: Number(portPart) };
}

function allowedHostnames(listener: ListenerInfo): Set<string> {
  const allowed = new Set<string>();
  allowed.add(normalizeHostname(listener.hostname));
  allowed.add('127.0.0.1');
  allowed.add('::1');
  return allowed;
}

/**
 * A request is only served when the Host header points at the loopback
 * address the dashboard is actually bound to. This blocks DNS rebinding,
 * where a hostile page resolves to 127.0.0.1 and sends its own Host.
 */
export function isAllowedHost(header: string | undefined | null, listener: ListenerInfo): boolean {
  const parsed = parseHostHeader(header);
  if (!parsed) return false;
  const hostname = normalizeHostname(parsed.hostname);
  if (!allowedHostnames(listener).has(hostname)) return false;
  if (listener.port !== null) {
    if (parsed.port !== listener.port) return false;
  }
  return true;
}

/**
 * Only same-origin browser requests are accepted. Requests without an Origin
 * header (curl, server-to-server) are not browser cross-origin requests and
 * are still protected by the bearer token.
 */
export function isAllowedOrigin(
  origin: string | undefined | null,
  listener: ListenerInfo,
): boolean {
  if (!origin) return true;
  const raw = origin.trim();
  if (!raw || raw === 'null') return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  const hostname = normalizeHostname(url.hostname);
  if (!allowedHostnames(listener).has(hostname)) return false;
  if (listener.port !== null) {
    const port = url.port ? Number(url.port) : 80;
    if (port !== listener.port) return false;
  }
  return true;
}

/** Content types accepted for write requests. */
export function isJsonContentType(header: string | undefined | null): boolean {
  if (!header) return false;
  const mediaType = header.split(';')[0].trim().toLowerCase();
  return mediaType === 'application/json';
}

export interface VisRuntimeFile {
  schemaVersion: number;
  workspaceId: string;
  url: string;
  hostname: string;
  port: number;
  pid: number;
  token: string;
  createdAt: string;
  updatedAt: string;
  heartbeatAt: string;
  lease: {
    ownerPid: number;
    expiresAt: string;
  };
}

export function getVisRuntimeDir(storeRoot: string): string {
  return path.join(storeRoot, 'runtime');
}

export function getVisRuntimeFilePath(storeRoot: string, workspaceId: string): string {
  const safeWorkspaceId = workspaceId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(getVisRuntimeDir(storeRoot), `vis-${safeWorkspaceId}.json`);
}

function ensureRuntimeDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Windows does not support POSIX modes; the inherited user ACL applies.
  }
}

/**
 * Persist the runtime file. The write is atomic (temp file + rename) so a
 * concurrent reader never observes a half written file.
 */
export function writeVisRuntimeFile(filePath: string, data: VisRuntimeFile): void {
  ensureRuntimeDir(path.dirname(filePath));
  // The shared temp-file helper produces a pid + random suffix that matches
  // TEMP_FILE_PATTERN, so a crashed writer's leftovers are cleaned up too.
  const tmpPath = createTempFilePath(filePath);
  fs.writeFileSync(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(tmpPath, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
  fs.renameSync(tmpPath, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on platforms without POSIX modes.
  }
}

export function readVisRuntimeFile(filePath: string): VisRuntimeFile | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<VisRuntimeFile>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.schemaVersion !== VIS_RUNTIME_SCHEMA_VERSION) return null;
    if (typeof parsed.workspaceId !== 'string' || !parsed.workspaceId) return null;
    if (typeof parsed.url !== 'string' || !parsed.url) return null;
    if (typeof parsed.token !== 'string' || !parsed.token) return null;
    if (typeof parsed.pid !== 'number') return null;
    if (typeof parsed.port !== 'number') return null;
    if (typeof parsed.hostname !== 'string') return null;
    if (!parsed.lease || typeof parsed.lease.expiresAt !== 'string') return null;
    return {
      schemaVersion: parsed.schemaVersion,
      workspaceId: parsed.workspaceId,
      url: parsed.url,
      hostname: parsed.hostname,
      port: parsed.port,
      pid: parsed.pid,
      token: parsed.token,
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
      heartbeatAt: typeof parsed.heartbeatAt === 'string' ? parsed.heartbeatAt : '',
      lease: {
        ownerPid: typeof parsed.lease.ownerPid === 'number' ? parsed.lease.ownerPid : parsed.pid,
        expiresAt: parsed.lease.expiresAt,
      },
    };
  } catch {
    return null;
  }
}

export function removeVisRuntimeFile(filePath: string): void {
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // The file may already be gone.
  }
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EPERM';
  }
}

/**
 * A runtime file is usable when its lease has not expired and the owning
 * process is still alive.
 */
export function isRuntimeLeaseAlive(file: VisRuntimeFile, now = Date.now()): boolean {
  const expiresAt = Date.parse(file.lease.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false;
  return isProcessAlive(file.lease.ownerPid || file.pid);
}

export function createRuntimeLease(now = Date.now()): VisRuntimeFile['lease'] {
  return {
    ownerPid: process.pid,
    expiresAt: new Date(now + RUNTIME_LEASE_TTL_MS).toISOString(),
  };
}

/** Refresh the heartbeat/lease of an owned runtime file. */
export function refreshVisRuntimeFile(filePath: string, now = Date.now()): VisRuntimeFile | null {
  const current = readVisRuntimeFile(filePath);
  if (!current) return null;
  const next: VisRuntimeFile = {
    ...current,
    updatedAt: new Date(now).toISOString(),
    heartbeatAt: new Date(now).toISOString(),
    lease: {
      ownerPid: process.pid,
      expiresAt: new Date(now + RUNTIME_LEASE_TTL_MS).toISOString(),
    },
  };
  writeVisRuntimeFile(filePath, next);
  return next;
}

/**
 * Build the URL handed to the browser. The token only ever travels in the
 * URL fragment: fragments are never sent to the server and never appear in
 * request logs or in the Referer header.
 */
export function buildBrowserUrl(url: string, token: string): string {
  const base = url.replace(/#.*$/, '');
  return `${base}#bootstrap=${encodeURIComponent(token)}`;
}

/**
 * Route parameters that end up in a file path must not be able to escape the
 * store directory.
 */
export function isSafePathParam(value: string): boolean {
  if (!value) return false;
  if (value.includes('\0')) return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/')) return false;
  const segments = value.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false;
  }
  return true;
}

/** Search view keys are used to build file names; keep them strictly simple. */
export function isSafeSearchViewKey(key: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key) && !key.includes('..');
}
