/**
 * Shared text scoring, snippet extraction, and SQL LIKE helpers.
 */

function truncate(text: unknown, maxLen: number): string {
  if (text === null || text === undefined) return '';
  const s = String(text);
  return s.length > maxLen ? s.slice(0, maxLen) + '...' : s;
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
