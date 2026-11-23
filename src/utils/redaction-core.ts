/**
 * Core string redaction. Kept separate from the env-driven helper so tests
 * can exercise the replacement logic without touching the environment.
 */

export function redactText(text: string, patterns: RegExp[]): string {
  let out = text;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}
