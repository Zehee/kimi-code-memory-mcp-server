/**
 * Input sanitization helpers.
 */

/**
 * Thrown when a key carries characters that cannot be stored safely.
 *
 * Unlike the silent replacement below, this is a hard rejection: the caller
 * must surface it to the user (HTTP 400 / MCP tool error) instead of writing
 * a different file than the caller asked for.
 */
export class InvalidKeyError extends Error {
  readonly key: string;

  constructor(key: string, reason: string) {
    super(`Invalid memory key ${JSON.stringify(key)}: ${reason}`);
    this.name = 'InvalidKeyError';
    this.key = key;
  }
}

/** Control characters (C0, DEL, C1) corrupt file names and JSON round-trips. */
// eslint-disable-next-line no-control-regex -- rejecting control characters is exactly the point
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

/**
 * Windows reserves these device names regardless of extension; a key that
 * normalizes to one of them would create an unusable or hostile file.
 */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/**
 * Normalize a memory/theme key to a safe file id.
 *
 * - Unicode NFC normalization, so visually identical keys map to one file.
 * - Control characters are rejected (`InvalidKeyError`) — silently replacing
 *   them could make a hostile key resolve to an unintended file.
 * - Windows reserved device names are rejected (`InvalidKeyError`).
 * - Filesystem-hostile characters (`\ / : * ? " < > |`) and whitespace runs
 *   are replaced with `_`. This keeps legacy behavior: keys stored by older
 *   versions remain addressable, and the same normalization runs on every
 *   entry point (MCP tools, HTTP API), so no path can disagree.
 */
export function sanitizeKey(key: unknown): string {
  const raw = String(key).normalize('NFC').trim();
  if (CONTROL_CHARS.test(raw)) {
    throw new InvalidKeyError(raw, 'control characters are not allowed');
  }
  return (
    raw
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 120) || 'untitled'
  );
}

/**
 * Validate the normalized key against rules replacement cannot express
 * (Windows reserved device names). Called after `sanitizeKey` by write paths.
 */
export function assertValidKey(sanitized: string): void {
  const base = sanitized.split('.')[0].toUpperCase();
  if (WINDOWS_RESERVED.has(base)) {
    throw new InvalidKeyError(sanitized, `${base} is a reserved Windows device name`);
  }
}

/**
 * Sanitize and validate a folder path.
 *
 * Rules:
 * - Backslashes are normalized to forward slashes.
 * - Absolute paths, parent traversal, or characters outside [a-zA-Z0-9_\-/] are rejected.
 * - Leading/trailing slashes are trimmed.
 * - An empty or missing value defaults to 'memory'.
 * - Bare paths are mapped under 'memory/' so every entry remains indexed and backed up.
 */
export function sanitizeFolder(folder: unknown): string | null {
  let normalized = String(folder).replace(/\\/g, '/');
  if (normalized.startsWith('/')) return null;
  if (normalized.includes('..')) return null;
  if (/[^a-zA-Z0-9_\-/]/.test(normalized)) return null;
  normalized = normalized.replace(/^\/+|\/+$/g, '') || 'memory';
  if (
    normalized === 'memory' ||
    normalized.startsWith('memory/') ||
    normalized === 'notes' ||
    normalized.startsWith('notes/')
  ) {
    return normalized;
  }
  return `memory/${normalized}`;
}

export function toTitle(key: unknown): string {
  return String(key)
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}
