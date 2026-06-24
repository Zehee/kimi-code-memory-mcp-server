/**
 * Input sanitization helpers.
 */

export function sanitizeKey(key: unknown): string {
  return (
    String(key)
      .trim()
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, '_')
      .slice(0, 120) || 'untitled'
  );
}

/**
 * Sanitize and validate a folder path.
 *
 * Rules:
 * - Backslashes are normalized to forward slashes.
 * - Absolute paths, parent traversal, or characters outside [a-zA-Z0-9_\-/] are rejected.
 * - Leading/trailing slashes are trimmed.
 * - An empty or missing value defaults to 'memory'.
 */
export function sanitizeFolder(folder: unknown): string | null {
  let normalized = String(folder).replace(/\\/g, '/');
  if (normalized.startsWith('/')) return null;
  if (normalized.includes('..')) return null;
  if (/[^a-zA-Z0-9_\-/]/.test(normalized)) return null;
  normalized = normalized.replace(/^\/+|\/+$/g, '');
  return normalized || 'memory';
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
