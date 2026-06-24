/**
 * Refined turn storage and extraction backed by SQLite.
 *
 * Refined turns are a local derived index / cache of conversation wires.
 * They are not user-facing memory assets; user memory stays in Markdown files.
 *
 * Extraction rules are intentionally local and deterministic: we look for
 * explicit structural cues (list items, action-keywords, headings) rather than
 * calling an LLM. This keeps the operation fast, free, and reproducible across
 * Chinese and English agent outputs.
 */

import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { Mutex } from './utils/mutex.js';

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
  notes: string[];
  entities: {
    files: string[];
    tools: string[];
    errors: string[];
  };
  categories: Record<string, string[]>;
}

/** Action / conclusion keywords in both English and Chinese. */
const ACTION_KEYWORDS = [
  // English - past tense / conclusions
  'Implemented',
  'Refactored',
  'Confirmed',
  'Completed',
  'Decided',
  'Changed',
  'Updated',
  'Removed',
  'Fixed',
  'Added',
  'Done',
  // English - planning / status
  'Next step',
  'Next',
  'Blocker',
  'Blocked by',
  'Blocked',
  'Result',
  'Results',
  'Summary',
  'Status',
  'Objective',
  'Plan',
  'Goal',
  'Action',
  'Actions',
  'Note',
  'Notes',
  // Chinese - past tense / conclusions
  '已完成',
  '完成',
  '修复了',
  '修复',
  '添加了',
  '添加',
  '删除了',
  '删除',
  '更新了',
  '更新',
  '决定了',
  '决定',
  '确认了',
  '确认',
  '实现了',
  '实现',
  '重构了',
  '重构',
  // Chinese - planning / status
  '下一步',
  '阻塞项',
  '阻塞',
  '被阻塞',
  '原因',
  '结果',
  '状态',
  '注意',
  '计划',
  '目标',
  '行动',
  '备注',
];

/** Markdown headings that group the following list items into categories. */
const CATEGORY_HEADINGS: Record<string, string[]> = {
  focus: ['Current Focus', '当前任务', '当前聚焦', 'Focus'],
  completed: ['Completed', 'Done', '已完成', '完成'],
  next: ['Next Steps', 'Next', '下一步', '后续'],
  blockers: ['Blockers', 'Blocked', '阻塞', '阻塞项', 'Blocked by'],
  status: ['Status', '当前状态', '状态'],
  summary: ['Summary', '总结', '摘要'],
  decisions: ['Decisions', '决定', '决策'],
  notes: ['Notes', '备注', 'Note'],
};

function buildActionRegex(): RegExp {
  // Sort longer phrases first so "Next step" wins over "Next".
  const sorted = [...ACTION_KEYWORDS].sort((a, b) => b.length - a.length);
  const escaped = sorted.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // Support both English colon and Chinese full-width colon, optional whitespace.
  return new RegExp(`^(?:${escaped.join('|')})(：|:)?\\s*`, 'i');
}

const ACTION_REGEX = buildActionRegex();
const HEADING_REGEX = /^(#{1,6})\s+(.+?)(?:\s+[:：])?\s*$/;

function normalizeHeading(text: string): string {
  return text.trim().replace(/[:：]\s*$/g, '');
}

function matchCategory(heading: string): string | null {
  const normalized = normalizeHeading(heading).toLowerCase();
  for (const [category, labels] of Object.entries(CATEGORY_HEADINGS)) {
    for (const label of labels) {
      if (normalized === label.toLowerCase()) return category;
      // Also match "## Current Focus" style where label might be embedded.
      if (normalized.includes(label.toLowerCase())) return category;
    }
  }
  return null;
}

function isSentenceLike(text: string): boolean {
  if (text.length < 10 || text.length > 200) return false;
  // End with sentence terminator or colon.
  return /[.。!！?？:：]$/.test(text);
}

function pickAgentLead(agentText: string): string | null {
  const first = agentText.split(/\r?\n/).find((line) => line.trim().length > 0);
  if (!first) return null;
  const trimmed = first.trim();
  return trimmed.length > 0 && trimmed.length <= 120 && !trimmed.startsWith('#')
    ? trimmed
    : null;
}

export class RefinedManager {
  refinedRoot: string;
  private dbPath: string;
  private db: Database.Database;
  private mutex: Mutex;

  constructor(refinedRoot: string) {
    this.refinedRoot = refinedRoot;
    this.dbPath = path.join(refinedRoot, 'refined.sqlite');
    fs.mkdirSync(refinedRoot, { recursive: true });
    this.db = new Database(this.dbPath);
    this.mutex = new Mutex();
    this.initDb();
  }

  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS refined_turns (
        session_id TEXT NOT NULL,
        turn_id INTEGER NOT NULL,
        timestamp TEXT,
        summary TEXT,
        facts TEXT,
        notes TEXT,
        entities TEXT,
        categories TEXT,
        PRIMARY KEY (session_id, turn_id)
      );
      CREATE INDEX IF NOT EXISTS idx_refined_session ON refined_turns(session_id);
      CREATE INDEX IF NOT EXISTS idx_refined_timestamp ON refined_turns(timestamp);
    `);
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

    const userText = (turn.user || '').slice(0, 200).trim();
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
      facts: facts.slice(0, 8),
      notes: notes.slice(0, 8),
      entities: {
        files: Array.from(files).slice(0, 10),
        tools: toolNames.slice(0, 10),
        errors: Array.from(errors).slice(0, 5),
      },
      categories,
    };
  }

  private rowToTurn(row: {
    session_id: string;
    turn_id: number;
    timestamp: string | null;
    summary: string;
    facts: string;
    notes: string;
    entities: string;
    categories: string;
  }): RefinedTurn {
    return {
      sessionId: row.session_id,
      turnId: row.turn_id,
      timestamp: row.timestamp ?? undefined,
      summary: row.summary,
      facts: JSON.parse(row.facts || '[]'),
      notes: JSON.parse(row.notes || '[]'),
      entities: JSON.parse(row.entities || '{"files":[],"tools":[],"errors":[]}'),
      categories: JSON.parse(row.categories || '{}'),
    };
  }

  async saveRefinedTurns(sessionId: string, refinedTurns: RefinedTurn[]): Promise<void> {
    return this.mutex.runExclusive(() => {
      const insert = this.db.prepare(
        `INSERT OR REPLACE INTO refined_turns
         (session_id, turn_id, timestamp, summary, facts, notes, entities, categories)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const existing = this.loadRefinedTurnsSync(sessionId);
      const merged = new Map(existing.map((t) => [t.turnId, t]));
      for (const turn of refinedTurns) {
        merged.set(turn.turnId, turn);
      }

      const transaction = this.db.transaction(() => {
        for (const turn of merged.values()) {
          insert.run(
            turn.sessionId,
            turn.turnId,
            turn.timestamp ?? null,
            turn.summary,
            JSON.stringify(turn.facts),
            JSON.stringify(turn.notes),
            JSON.stringify(turn.entities),
            JSON.stringify(turn.categories),
          );
        }
      });
      transaction();
    });
  }

  loadRefinedTurns(sessionId: string): RefinedTurn[] {
    return this.loadRefinedTurnsSync(sessionId);
  }

  private loadRefinedTurnsSync(sessionId: string): RefinedTurn[] {
    const stmt = this.db.prepare(
      'SELECT * FROM refined_turns WHERE session_id = ? ORDER BY turn_id',
    );
    const rows = stmt.all(sessionId) as Array<{
      session_id: string;
      turn_id: number;
      timestamp: string | null;
      summary: string;
      facts: string;
      notes: string;
      entities: string;
      categories: string;
    }>;
    return rows.map((r) => this.rowToTurn(r));
  }

  getDbPath(): string {
    return this.dbPath;
  }

  loadRefinedTurn(sessionId: string, turnId: number): RefinedTurn | undefined {
    const stmt = this.db.prepare(
      'SELECT * FROM refined_turns WHERE session_id = ? AND turn_id = ?',
    );
    const row = stmt.get(sessionId, turnId) as
      | {
          session_id: string;
          turn_id: number;
          timestamp: string | null;
          summary: string;
          facts: string;
          notes: string;
          entities: string;
          categories: string;
        }
      | undefined;
    return row ? this.rowToTurn(row) : undefined;
  }

  close(): void {
    this.db.close();
  }
}
