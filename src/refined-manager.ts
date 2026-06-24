/**
 * Refined turn storage and extraction.
 */

import fs from 'fs';
import path from 'path';
import { sanitizeKey } from './utils/validation.js';

export interface RawAction {
  name?: string;
  args?: unknown;
  result?: unknown;
}

export interface RawTurn {
  turnId?: string | number;
  timestamp?: string;
  user?: string;
  agentText?: string;
  agent?: string;
  actions?: RawAction[];
}

export interface RefinedTurn {
  sessionId: string;
  turnId: number;
  timestamp: string | undefined;
  summary: string;
  facts: string[];
  entities: {
    files: string[];
    tools: string[];
    errors: string[];
  };
}

export class RefinedManager {
  refinedRoot: string;

  constructor(refinedRoot: string) {
    this.refinedRoot = refinedRoot;
  }

  refinedTurnsPath(sessionId: string): string {
    return path.join(this.refinedRoot, `${sanitizeKey(sessionId)}.jsonl`);
  }

  refineTurn(turn: RawTurn, sessionId: string): RefinedTurn {
    const files = new Set<string>();
    const tools = new Set<string>();
    const errors = new Set<string>();

    for (const action of turn.actions || []) {
      if (action.name) tools.add(action.name);
      const args =
        typeof action.args === 'object' && action.args !== null
          ? (action.args as Record<string, unknown>)
          : {};
      for (const key of ['path', 'file', 'filePath', 'cwd'] as const) {
        const value = args[key];
        if (typeof value === 'string') {
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

    const facts: string[] = [];
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
      turnId: parseInt(String(turn.turnId), 10),
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

  saveRefinedTurns(sessionId: string, refinedTurns: RefinedTurn[]): void {
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

  loadRefinedTurns(sessionId: string): RefinedTurn[] {
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
