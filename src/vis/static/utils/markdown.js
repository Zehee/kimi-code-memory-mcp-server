import { escapeHtml } from './helpers.js';

export function renderMarkdown(md) {
  if (!md) return '';
  let text = escapeHtml(md);

  // fenced code blocks
  text = text.replace(/```([\s\S]*?)```/g, (_, code) => {
    return `<pre><code>${code.replace(/^\n|\n$/g, '')}</code></pre>`;
  });

  // inline code
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  // headings
  text = text.replace(/^#{1,6}\s+(.+)$/gm, (match, content) => {
    const level = match.match(/^#+/)[0].length;
    return `<h${level}>${content}</h${level}>`;
  });

  // horizontal rules
  text = text.replace(/^\s*[-*]{3,}\s*$/gm, '<hr>');

  // blockquote lines (single-line simple support)
  text = text.replace(/^>\s+(.+)$/gm, '<blockquote>$1</blockquote>');

  // GFM pipe tables: header row, separator row (--- with optional : alignment), body rows.
  // Cells keep inline formatting because the inline rules below run afterwards.
  text = text.replace(/(?:^\|.*\|[ \t]*\n?)+/gm, (block) => {
    const rows = block
      .trim()
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean);
    if (rows.length < 2) return block;
    const splitCells = (row) =>
      row
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
    const sepCells = splitCells(rows[1]);
    if (!sepCells.length || !sepCells.every((c) => /^:?-{3,}:?$/.test(c))) return block;
    const headerCells = splitCells(rows[0]);
    if (headerCells.length !== sepCells.length) return block;
    const aligns = sepCells.map((c) =>
      c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : '',
    );
    const alignAttr = (i) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : '');
    const thead = `<thead><tr>${headerCells.map((c, i) => `<th${alignAttr(i)}>${c}</th>`).join('')}</tr></thead>`;
    const tbody = rows
      .slice(2)
      .map((row) => `<tr>${splitCells(row).map((c, i) => `<td${alignAttr(i)}>${c}</td>`).join('')}</tr>`)
      .join('');
    return `<table>${thead}<tbody>${tbody}</tbody></table>`;
  });

  // unordered lists (single level)
  text = text.replace(/(?:^[-*+]\s+.+\n?)+/gm, (block) => {
    const items = block
      .trim()
      .split('\n')
      .map((line) => `<li>${line.replace(/^[-*+]\s+/, '')}</li>`)
      .join('');
    return `<ul>${items}</ul>`;
  });

  // ordered lists (single level)
  text = text.replace(/(?:^\d+\.\s+.+\n?)+/gm, (block) => {
    const items = block
      .trim()
      .split('\n')
      .map((line) => `<li>${line.replace(/^\d+\.\s+/, '')}</li>`)
      .join('');
    return `<ol>${items}</ol>`;
  });

  // links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // bold / italic (handle combined)
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/_([^_]+)_/g, '<em>$1</em>');

  // paragraphs: group consecutive non-empty, non-block lines
  const blocks = [];
  const lines = text.split('\n');
  let buf = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const isBlock =
      trimmed === '' ||
      /^<(?:h[1-6]|ul|ol|li|pre|blockquote|hr|table)/.test(trimmed) ||
      /^<\/(?:h[1-6]|ul|ol|li|pre|blockquote|table)>$/.test(trimmed);
    if (isBlock) {
      if (buf.length) {
        blocks.push(`<p>${buf.join(' ')}</p>`);
        buf = [];
      }
      if (trimmed !== '') blocks.push(line);
    } else {
      buf.push(line);
    }
  }
  if (buf.length) blocks.push(`<p>${buf.join(' ')}</p>`);

  return blocks.join('\n');
}
