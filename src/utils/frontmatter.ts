/**
 * Minimal YAML frontmatter parser/stringifier for Markdown memory files.
 */

export type Frontmatter = Record<string, string | string[]>;

export interface ParsedFrontmatter {
  frontmatter: Frontmatter;
  body: string;
}

function stripQuotes(value: string): string {
  return value.replace(/^['"]|['"]$/g, '');
}

export function parseFrontmatter(fileContent: string): ParsedFrontmatter | null {
  const normalized = fileContent.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) return null;
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) return null;

  const fmText = normalized.slice(4, end);
  const body = normalized.slice(end + 4).replace(/^\n+/, '');

  const frontmatter: Frontmatter = {};
  let currentKey: string | null = null;
  for (const rawLine of fmText.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const listMatch = line.match(/^(\s+)-\s*(.*)$/);
    if (listMatch && currentKey) {
      const current = frontmatter[currentKey];
      if (Array.isArray(current)) {
        current.push(stripQuotes(listMatch[2].trim()));
      }
      continue;
    }

    const kvMatch = line.match(/^([^:]+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1].trim();
      const value = kvMatch[2].trim();
      if (value === '') {
        frontmatter[currentKey] = [];
      } else {
        frontmatter[currentKey] = stripQuotes(value);
      }
    }
  }

  return { frontmatter, body };
}

export function stringifyFrontmatter(frontmatter: Frontmatter): string {
  let out = '---\n';
  for (const [k, v] of Object.entries(frontmatter)) {
    if (Array.isArray(v)) {
      out += `${k}:\n`;
      for (const item of v) {
        out += `  - ${item}\n`;
      }
    } else {
      const safe = String(v).replace(/'/g, "''");
      out += `${k}: '${safe}'\n`;
    }
  }
  out += '---\n\n';
  return out;
}
