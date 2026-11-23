/**
 * Strict YAML-subset frontmatter parser/stringifier for Markdown memory files.
 *
 * The supported subset is deliberately small so that parsing and stringifying
 * are exactly reversible:
 *
 * - `key: "value"` — strings are always written double quoted with JSON
 *   escaping, so quotes, colons, `#`, backslashes, newlines and Unicode all
 *   round-trip unchanged.
 * - `key: 42` — plain integers/floats are read back as numbers.
 * - `key: ["a", "b"]` — inline arrays; `key: []` is an empty array.
 * - `key:` followed by `  - item` lines — block sequences (legacy format).
 *
 * Anything outside the subset (duplicate keys, malformed lines, unterminated
 * blocks, ambiguous plain scalars) raises `FrontmatterParseError` instead of
 * being silently ignored.
 */

export type FrontmatterValue = string | number | string[];
export type Frontmatter = Record<string, FrontmatterValue>;

export class FrontmatterParseError extends Error {
  readonly line?: number;

  constructor(message: string, line?: number) {
    super(line === undefined ? message : `${message} (line ${line})`);
    this.name = 'FrontmatterParseError';
    this.line = line;
  }
}

export interface ParsedFrontmatter {
  frontmatter: Frontmatter;
  body: string;
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * Parse a Markdown file with an optional frontmatter block.
 *
 * Returns `null` when the file has no frontmatter at all. Throws
 * `FrontmatterParseError` when a frontmatter block exists but is invalid.
 */
export function parseFrontmatter(fileContent: string): ParsedFrontmatter | null {
  const normalized = String(fileContent).replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;

  const lines = normalized.split('\n');
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      endIndex = i;
      break;
    }
  }
  if (endIndex === -1) {
    throw new FrontmatterParseError('Unterminated frontmatter block');
  }

  const frontmatter = parseFrontmatterLines(lines.slice(1, endIndex));
  const body = lines
    .slice(endIndex + 1)
    .join('\n')
    .replace(/^\n+/, '');

  return { frontmatter, body };
}

/**
 * Parse a Markdown file that is required to carry a frontmatter block.
 */
export function parseFrontmatterStrict(fileContent: string): ParsedFrontmatter {
  const parsed = parseFrontmatter(fileContent);
  if (!parsed) {
    throw new FrontmatterParseError('Missing frontmatter block');
  }
  return parsed;
}

function parseFrontmatterLines(fmLines: string[]): Frontmatter {
  const frontmatter: Frontmatter = {};
  let listKey: string | null = null;
  let listValue: string[] | null = null;

  for (let i = 0; i < fmLines.length; i++) {
    const raw = fmLines[i];
    const lineNumber = i + 2; // 1-based file line (line 1 is the opening `---`).
    if (!raw.trim()) continue;

    const listMatch = raw.match(/^(\s+)-\s*(.*)$/);
    if (listMatch) {
      if (!listKey || !listValue) {
        throw new FrontmatterParseError('List item without a preceding key', lineNumber);
      }
      listValue.push(String(parseScalar(listMatch[2].trim(), lineNumber)));
      continue;
    }

    const kvMatch = raw.match(/^([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*:(.*)$/);
    if (!kvMatch) {
      throw new FrontmatterParseError(`Invalid frontmatter line: ${raw.trim()}`, lineNumber);
    }

    const key = kvMatch[1];
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      throw new FrontmatterParseError(`Duplicate frontmatter key: ${key}`, lineNumber);
    }

    const rawValue = kvMatch[2].trim();
    if (rawValue === '') {
      // Either an empty block sequence or an empty value.
      const empty: string[] = [];
      frontmatter[key] = empty;
      listKey = key;
      listValue = empty;
      continue;
    }

    if (rawValue.startsWith('[')) {
      frontmatter[key] = parseInlineArray(rawValue, lineNumber);
      listKey = null;
      listValue = null;
      continue;
    }

    frontmatter[key] = parseScalar(rawValue, lineNumber);
    listKey = null;
    listValue = null;
  }

  return frontmatter;
}

function parseScalar(raw: string, lineNumber: number): string | number {
  if (raw === '') {
    throw new FrontmatterParseError('Empty frontmatter value', lineNumber);
  }

  if (raw.startsWith("'")) {
    if (raw.length < 2 || !raw.endsWith("'")) {
      throw new FrontmatterParseError('Unterminated single-quoted value', lineNumber);
    }
    return raw.slice(1, -1).replace(/''/g, "'");
  }

  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) {
      throw new FrontmatterParseError('Unterminated double-quoted value', lineNumber);
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      throw new FrontmatterParseError('Invalid double-quoted value', lineNumber);
    }
    if (typeof decoded !== 'string') {
      throw new FrontmatterParseError('Invalid double-quoted value', lineNumber);
    }
    return decoded;
  }

  if (raw.includes('#') || raw.includes(': ')) {
    throw new FrontmatterParseError(`Ambiguous plain value: ${raw}`, lineNumber);
  }
  if (raw.endsWith(':')) {
    throw new FrontmatterParseError(`Ambiguous plain value: ${raw}`, lineNumber);
  }
  if (NUMBER_PATTERN.test(raw)) {
    return Number(raw);
  }
  return raw;
}

function parseInlineArray(raw: string, lineNumber: number): string[] {
  if (!raw.endsWith(']')) {
    throw new FrontmatterParseError('Unterminated inline array', lineNumber);
  }
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];

  const items: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) {
      if (quote === "'" && ch === "'") {
        if (inner[i + 1] === "'") {
          current += "'";
          i++;
          continue;
        }
        quote = null;
        current += ch;
        continue;
      }
      if (quote === '"' && ch === '\\') {
        current += ch + (inner[i + 1] ?? '');
        i++;
        continue;
      }
      if (quote === '"' && ch === '"') {
        quote = null;
        current += ch;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      items.push(current);
      current = '';
      continue;
    }
    current += ch;
  }

  if (quote) {
    throw new FrontmatterParseError('Unterminated quoted value in inline array', lineNumber);
  }
  items.push(current);

  return items.map((item) => {
    const trimmed = item.trim();
    const parsed = parseScalar(trimmed, lineNumber);
    return typeof parsed === 'string' ? parsed : String(parsed);
  });
}

/**
 * Serialize a frontmatter object into the strict subset format.
 *
 * The returned text always ends with the closing `---` delimiter followed by a
 * blank line, so `stringifyFrontmatter(fm) + body` is a complete file.
 */
export function stringifyFrontmatter(frontmatter: Frontmatter): string {
  let out = '---\n';
  for (const [key, value] of Object.entries(frontmatter)) {
    if (!KEY_PATTERN.test(key)) {
      throw new FrontmatterParseError(`Invalid frontmatter key: ${key}`);
    }
    if (Array.isArray(value)) {
      out += `${key}: ${JSON.stringify(value.map((item) => String(item)))}\n`;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new FrontmatterParseError(`Invalid numeric frontmatter value for ${key}`);
      }
      out += `${key}: ${value}\n`;
    } else {
      out += `${key}: ${JSON.stringify(String(value))}\n`;
    }
  }
  out += '---\n\n';
  return out;
}

/** Read a string field from a frontmatter object. */
export function frontmatterString(
  frontmatter: Frontmatter | undefined,
  key: string,
): string | undefined {
  if (!frontmatter) return undefined;
  const value = frontmatter[key];
  return typeof value === 'string' ? value : undefined;
}

/** Read a string array field from a frontmatter object. */
export function frontmatterStringArray(
  frontmatter: Frontmatter | undefined,
  key: string,
): string[] | undefined {
  if (!frontmatter) return undefined;
  const value = frontmatter[key];
  if (!Array.isArray(value)) return undefined;
  return value.map((item) => String(item));
}

/** Read a numeric field from a frontmatter object. */
export function frontmatterNumber(
  frontmatter: Frontmatter | undefined,
  key: string,
): number | undefined {
  if (!frontmatter) return undefined;
  const value = frontmatter[key];
  return typeof value === 'number' ? value : undefined;
}
