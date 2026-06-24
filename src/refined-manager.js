/**
 * Refined turn storage and extraction.
 */

import fs from 'fs';
import path from 'path';
import { sanitizeKey } from './utils/validation.js';

export class RefinedManager {
  constructor(refinedRoot) {
    this.refinedRoot = refinedRoot;
  }

  refinedTurnsPath(sessionId) {
    return path.join(this.refinedRoot, `${sanitizeKey(sessionId)}.jsonl`);
  }

  refineTurn(turn, sessionId) {
    const files = new Set();
    const tools = new Set();
    const errors = new Set();

    for (const action of turn.actions || []) {
      if (action.name) tools.add(action.name);
      const args = action.args || {};
      for (const key of ['path', 'file', 'filePath', 'cwd']) {
        if (typeof args[key] === 'string') {
          const value = args[key];
          if (key === 'cwd' && value.includes('node_modules')) continue;
          files.add(value);
        }
      }
      const result = action.result || '';
      if (
        typeof result === 'string' &&
        (result.toLowerCase().includes('error') || result.toLowerCase().includes('failed'))
      ) {
        errors.add(result.split('\n')[0].slice(0, 200));
      }
    }

    const userText = (turn.user || '').slice(0, 200);
    const toolNames = Array.from(tools);
    let summary = userText;
    if (toolNames.length > 0) {
      summary = `${userText ? `${userText} · ` : ''}${toolNames.join(', ')}`;
    }

    const facts = [];
    const agentText = turn.agentText || turn.agent || '';
    const lines = String(agentText).split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
        facts.push(trimmed.slice(2).trim());
      } else if (
        /^(Changed|Fixed|Added|Removed|Updated|Decided|Confirmed|Implemented|Refactored)/i.test(
          trimmed,
        )
      ) {
        facts.push(trimmed);
      }
    }

    return {
      sessionId,
      turnId: parseInt(turn.turnId, 10),
      timestamp: turn.timestamp,
      summary,
      facts: facts.slice(0, 5),
      entities: {
        files: Array.from(files).slice(0, 10),
        tools: toolNames.slice(0, 10),
        errors: Array.from(errors).slice(0, 5),
      },
    };
  }

  saveRefinedTurns(sessionId, refinedTurns) {
    const filePath = this.refinedTurnsPath(sessionId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });

    const existing = this.loadRefinedTurns(sessionId);
    const merged = new Map(existing.map((t) => [t.turnId, t]));
    for (const turn of refinedTurns) {
      merged.set(turn.turnId, turn);
    }

    const tmpPath = filePath + '.tmp';
    const lines = Array.from(merged.values())
      .sort((a, b) => a.turnId - b.turnId)
      .map((t) => JSON.stringify(t));
    fs.writeFileSync(tmpPath, lines.join('\n'), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  loadRefinedTurns(sessionId) {
    const filePath = this.refinedTurnsPath(sessionId);
    if (!fs.existsSync(filePath)) return [];
    try {
      return fs
        .readFileSync(filePath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}
