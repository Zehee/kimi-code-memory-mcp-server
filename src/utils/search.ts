/**
 * Shared text scoring, snippet extraction, and SQL LIKE helpers.
 *
 * The keyword semantics defined here are the single source of truth for both
 * the raw wire scan and the refined SQLite scan:
 *
 * - terms are lower-cased, whitespace-split and de-duplicated;
 * - a document matches only when *every* term is present (AND);
 * - scoring only influences ordering, never the AND decision.
 */

function truncate(text: unknown, maxLen: number): string {
  if (text === null || text === undefined) return '';
  const s = String(text);
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
}

/**
 * Normalize a raw query into the canonical term list used by every scan path.
 */
export function normalizeTerms(query: unknown): string[] {
  if (query === null || query === undefined) return [];
  const seen = new Set<string>();
  for (const part of String(query).toLowerCase().split(/\s+/)) {
    const term = part.trim();
    if (term) seen.add(term);
  }
  return Array.from(seen);
}

/**
 * True when every term occurs in the text (case-insensitive substring match).
 * An empty term list never matches.
 */
export function hasAllTerms(text: string, terms: string[]): boolean {
  if (!terms.length) return false;
  const haystack = String(text ?? '').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Escape a term for use inside a SQL LIKE pattern.
 */
export function escapeLikeTerm(term: string): string {
  return String(term)
    .split('\\')
    .join('\\\\')
    .split('%')
    .join('\\%')
    .split('_')
    .join('\\_');
}

/**
 * Build the SQL LIKE pattern for a term (unescaped wildcards around it).
 */
export function likePattern(term: string): string {
  return `%${escapeLikeTerm(term)}%`;
}

/**
 * Score how many times all search terms appear in text (case-insensitive).
 */
export function scoreText(text: string, terms: string[]): number {
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const pattern = term.replace(/[.*+?^${}()|[\]\\]/g, (ch) => `\\${ch}`);
    const re = new RegExp(pattern, 'gi');
    const matches = haystack.match(re);
    if (matches) score += matches.length;
  }
  return score;
}

/**
 * Extract a short snippet around the longest matching term.
 */
export function extractSnippet(text: string, terms: string[], maxLen: number): string {
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
 * Build SQL LIKE conditions for a list of search terms.
 * Returns one condition per term that checks summary, facts, and notes.
 * Callers must bind each escaped term three times (summary, facts, notes).
 */
export function buildLikeConditions(terms: string[]): string[] {
  return terms.map(
    () => "(summary LIKE ? ESCAPE '\\' OR facts LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')",
  );
}
