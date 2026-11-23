/**
 * Best-effort redaction for derived data.
 *
 * `KIMI_MEMORY_REDACT_PATTERNS` holds newline-separated JavaScript regular
 * expression sources. Every string written into the refined store (summaries,
 * facts, notes, …) has all matches replaced with `[REDACTED]` before it is
 * persisted.
 *
 * This is a filter for OUR derived copies, not a security boundary:
 * - regular expressions cannot reliably recognize every secret format;
 * - the raw `wire.jsonl` is owned by the host and never modified here, so the
 *   original text always stays on disk in the session files.
 * Never claim that redaction removes secrets completely.
 */

import { redactText } from './redaction-core.js';

export const REDACT_PATTERNS_ENV = 'KIMI_MEMORY_REDACT_PATTERNS';
export const REDACTED_PLACEHOLDER = '[REDACTED]';

interface CompiledPatterns {
  patterns: RegExp[];
  invalid: string[];
}

let cache: { raw: string; compiled: CompiledPatterns } | null = null;

/** Compile (and memoize) the configured redaction patterns. */
export function getRedactionPatterns(): CompiledPatterns {
  const raw = process.env[REDACT_PATTERNS_ENV] ?? '';
  if (cache && cache.raw === raw) return cache.compiled;

  const compiled: CompiledPatterns = { patterns: [], invalid: [] };
  for (const line of raw.split(/\r?\n/)) {
    const source = line.trim();
    if (!source) continue;
    try {
      compiled.patterns.push(new RegExp(source, 'gi'));
    } catch {
      compiled.invalid.push(source);
    }
  }
  cache = { raw, compiled };
  return compiled;
}

/**
 * Recursively redact every string field of a JSON-like value.
 * Returns the same reference when there is nothing to replace.
 */
export function redactValue<T>(value: T, patterns: RegExp[]): T {
  if (patterns.length === 0) return value;
  return redactValueDeep(value, patterns) as T;
}

function redactValueDeep(value: unknown, patterns: RegExp[]): unknown {
  if (typeof value === 'string') {
    return redactText(value, patterns);
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const mapped = redactValueDeep(item, patterns);
      if (mapped !== item) changed = true;
      return mapped;
    });
    return changed ? next : value;
  }
  if (value && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const mapped = redactValueDeep(item, patterns);
      if (mapped !== item) changed = true;
      next[key] = mapped;
    }
    return changed ? next : value;
  }
  return value;
}
