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
      /^<(?:h[1-6]|ul|ol|li|pre|blockquote|hr)/.test(trimmed) ||
      /^<\/(?:h[1-6]|ul|ol|li|pre|blockquote)>$/.test(trimmed);
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
