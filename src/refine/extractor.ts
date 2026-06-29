/**
 * Pure turn extraction logic.
 *
 * Converts a RawTurn into a RefinedTurn using deterministic, local rules:
 * action keywords, category headings, list items, and lightweight entity
 * extraction. No LLM is involved.
 */

import type { RawTurn, RefinedTurn } from './types.js';
import { ACTION_KEYWORDS, LIMITS } from './constants.js';
import { extractEntitiesFromAction } from '../utils/action-entities.js';
import { matchCategory } from '../utils/headings.js';

function buildActionRegex(): RegExp {
  // Sort longer phrases first so "Next step" wins over "Next".
  const sorted = [...ACTION_KEYWORDS].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Support both English colon and Chinese full-width colon, optional whitespace.
  return new RegExp(`^(?:${escaped.join('|')})(：|:)?\\s*`, 'i');
}

const ACTION_REGEX = buildActionRegex();
const HEADING_REGEX = /^(#{1,6})\s+(.+?)(?:\s+[:：])?\s*$/;

function isSentenceLike(text: string): boolean {
  if (text.length < 10 || text.length > LIMITS.userText) return false;
  // End with sentence terminator or colon.
  return /[.。!！?？:：]$/.test(text);
}

function pickAgentLead(agentText: string): string | null {
  const first = agentText.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!first) return null;
  const trimmed = first.trim();
  return trimmed.length > 0 && trimmed.length <= LIMITS.agentLead && !trimmed.startsWith('#')
    ? trimmed
    : null;
}

/**
 * Extract a RefinedTurn from a RawTurn.
 */
export function extract(turn: RawTurn, sessionId: string): RefinedTurn {
  const files = new Set<string>();
  const tools = new Set<string>();
  const errors = new Set<string>();

  for (const action of turn.actions || []) {
    const { files: actionFiles, tools: actionTools, errors: actionErrors } =
      extractEntitiesFromAction(action);
    for (const file of actionFiles) files.add(file);
    for (const tool of actionTools) tools.add(tool);
    for (const error of actionErrors) errors.add(error);
  }

  const userText = (turn.user || '').slice(0, LIMITS.userText).trim();
  const toolNames = Array.from(tools);
  const agentText = turn.agentText || turn.agent || '';
  const agentLead = pickAgentLead(agentText);

  let summary = userText;
  if (toolNames.length > 0) {
    summary = `${userText ? `${userText} · ` : ''}${toolNames.join(', ')}`;
  }
  if (agentLead && agentLead !== userText) {
    summary = summary ? `${summary} · ${agentLead}` : agentLead;
  }

  const facts: string[] = [];
  const notes: string[] = [];
  const categories: Record<string, string[]> = {};
  let currentCategory: string | null = null;

  const lines = String(agentText).split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      currentCategory = null;
      continue;
    }

    // Markdown / Chinese heading detection.
    const headingMatch = line.match(HEADING_REGEX);
    if (headingMatch) {
      currentCategory = matchCategory(headingMatch[2]);
      continue;
    }

    let extracted: string | null = null;

    // List item.
    if (line.startsWith('- ') || line.startsWith('* ')) {
      extracted = line.slice(2).trim();
    }
    // Numbered list item like "1. xxx" or "1) xxx".
    else if (/^(\d+)[.)]\s+/.test(line)) {
      extracted = line.replace(/^\d+[.)]\s+/, '').trim();
    }
    // Action / conclusion sentence.
    else {
      const actionMatch = line.match(ACTION_REGEX);
      if (actionMatch) {
        extracted = line.slice(actionMatch[0].length).trim();
      }
    }

    if (extracted) {
      const item = extracted;
      if (currentCategory) {
        (categories[currentCategory] ||= []).push(item);
      }
      facts.push(item);
    } else if (isSentenceLike(line)) {
      // Fallback: keep short declarative sentences that did not match keywords.
      notes.push(line);
    }
  }

  return {
    sessionId,
    turnId: parseInt(String(turn.turnId), 10),
    timestamp: turn.timestamp,
    summary,
    facts: facts.slice(0, LIMITS.facts),
    notes: notes.slice(0, LIMITS.notes),
    entities: {
      files: Array.from(files).slice(0, LIMITS.files),
      tools: toolNames.slice(0, LIMITS.tools),
      errors: Array.from(errors).slice(0, LIMITS.errors),
    },
    categories,
  };
}
