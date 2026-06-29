/**
 * Data access helpers for the vis dashboard.
 *
 * All functions receive the shared MCP server context and return plain
 * JSON-serializable objects so they can be reused by the Hono routes and by
 * tests without touching HTTP details.
 */

import fs from 'fs';
import path from 'path';
import type { Ctx } from '../types.js';
import { getSessionsRoot } from '../config.js';
import { atomicWriteFile } from '../utils/paths.js';
import type { ThemeAssociation } from '../theme-manager.js';
import type { RefinedTurn } from '../refine/types.js';
import type { TreeNode } from '../dao/index.js';

export interface WorkspaceInfo {
  id: string;
  cwd: string;
  storePath: string;
  essence: string;
  stats: {
    memories: number;
    themes: number;
    refinedTurns: number;
    sessions: number;
  };
}

export interface ThemeInfo {
  name: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  memoryCount: number;
}

export interface TimelineItem {
  type: 'turn' | 'memory';
  timestamp: string;
  data: unknown;
}

export interface ThemeTimeline {
  theme: string;
  displayName: string;
  items: TimelineItem[];
}

export interface DecisionItem {
  sessionId: string;
  turnId: number;
  timestamp: string | undefined;
  summary: string;
  decisions: string[];
  files: string[];
  tags: string[];
}

export interface MemoryNode {
  name: string;
  comment: string;
  files: MemoryFile[];
  children: MemoryNode[];
}

export interface MemoryFile {
  key: string;
  title: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

function readEssence(storeRoot: string): string {
  const essencePath = path.join(storeRoot, 'essence', 'essence.md');
  if (!fs.existsSync(essencePath)) return '';
  return fs.readFileSync(essencePath, 'utf8');
}

function countSessionDirectories(): number {
  const sessionsRoot = getSessionsRoot();
  if (!fs.existsSync(sessionsRoot)) return 0;
  return fs
    .readdirSync(sessionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).length;
}

export function getWorkspace(ctx: Ctx): WorkspaceInfo {
  const index = ctx.indexDao.getIndex().index;
  const memories = Object.keys(index).filter((k) => k.endsWith('.md')).length;

  return {
    id: ctx.workspaceId,
    cwd: ctx.cwd,
    storePath: ctx.storeRoot,
    essence: readEssence(ctx.storeRoot),
    stats: {
      memories,
      themes: ctx.themeManager.listThemes().length,
      refinedTurns: ctx.refinedManager.countAll(),
      sessions: countSessionDirectories(),
    },
  };
}

export function getThemes(ctx: Ctx): ThemeInfo[] {
  return ctx.themeManager.listThemes().map((name) => {
    const association = ctx.themeManager.loadTheme(name);
    if (!association) {
      return {
        name,
        displayName: name,
        createdAt: '',
        updatedAt: '',
        turnCount: 0,
        memoryCount: 0,
      };
    }
    return {
      name: association.theme,
      displayName: association.displayName || association.theme,
      createdAt: association.createdAt,
      updatedAt: association.updatedAt,
      turnCount: association.turns.length,
      memoryCount: association.memories.length,
    };
  });
}

function turnToTimelineItem(turn: RefinedTurn): TimelineItem {
  return {
    type: 'turn',
    timestamp: turn.timestamp || new Date(0).toISOString(),
    data: {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      timestamp: turn.timestamp,
      summary: turn.summary,
      facts: turn.facts,
      notes: turn.notes,
      entities: turn.entities,
      categories: turn.categories,
    },
  };
}

function memoryToTimelineItem(memory: ThemeAssociation['memories'][number], storeRoot: string): TimelineItem {
  const filePath = path.join(storeRoot, memory.folder, `${memory.key}.md`);
  let content = '';
  if (fs.existsSync(filePath)) {
    content = fs.readFileSync(filePath, 'utf8');
  }
  return {
    type: 'memory',
    timestamp: memory.timestamp,
    data: {
      key: memory.key,
      folder: memory.folder,
      title: memory.title,
      content,
    },
  };
}

export function getThemeTimeline(ctx: Ctx, themeName: string): ThemeTimeline {
  const association = ctx.themeManager.loadTheme(themeName);
  const empty: ThemeTimeline = {
    theme: themeName,
    displayName: themeName,
    items: [],
  };
  if (!association) return empty;

  const items: TimelineItem[] = [];

  for (const turnRef of association.turns) {
    const turn = ctx.refinedManager.loadRefinedTurn(turnRef.sessionId, turnRef.turnId);
    if (turn) {
      items.push(turnToTimelineItem(turn));
    } else {
      items.push({
        type: 'turn',
        timestamp: turnRef.timestamp,
        data: {
          sessionId: turnRef.sessionId,
          turnId: turnRef.turnId,
          timestamp: turnRef.timestamp,
          missing: true,
        },
      });
    }
  }

  for (const memory of association.memories) {
    items.push(memoryToTimelineItem(memory, ctx.storeRoot));
  }

  items.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return {
    theme: association.theme,
    displayName: association.displayName || association.theme,
    items,
  };
}

export function getRecentDecisions(ctx: Ctx, limit = 20): DecisionItem[] {
  const turns = ctx.refinedManager.listRecentTurns(limit * 5);
  const decisions: DecisionItem[] = [];

  for (const turn of turns) {
    const turnDecisions = turn.categories?.decisions;
    if (!Array.isArray(turnDecisions) || turnDecisions.length === 0) continue;

    decisions.push({
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      timestamp: turn.timestamp,
      summary: turn.summary,
      decisions: turnDecisions,
      files: turn.entities?.files || [],
      tags: Object.values(turn.categories || {}).flat(),
    });

    if (decisions.length >= limit) break;
  }

  return decisions;
}

function treeNodeToMemoryNode(node: TreeNode): MemoryNode {
  const children: MemoryNode[] = [];
  node.children.forEach((child) => {
    children.push(treeNodeToMemoryNode(child));
  });

  return {
    name: node.name,
    comment: node.comment || '',
    files: node.files.map((file) => ({
      key: file.key,
      title: file.title,
      tags: file.tags,
      createdAt: file.createdAt || '',
      updatedAt: file.updatedAt || '',
    })),
    children,
  };
}

export function getMemories(ctx: Ctx): MemoryNode {
  const tree = ctx.indexDao.buildMemoryTreeData();
  return treeNodeToMemoryNode(tree);
}

export function getMemoryContent(
  ctx: Ctx,
  folder: string,
  key: string,
): { content: string; title: string; tags: string[] } | null {
  const result = ctx.memoryStore.read(folder, key);
  if (!result) return null;
  return {
    content: result.content,
    title: String(result.title || key),
    tags: Array.isArray(result.tags) ? result.tags : [],
  };
}

export function saveEssence(ctx: Ctx, content: string): { ok: boolean } {
  const essenceDir = path.join(ctx.storeRoot, 'essence');
  fs.mkdirSync(essenceDir, { recursive: true });
  const essencePath = path.join(essenceDir, 'essence.md');
  atomicWriteFile(essencePath, content, 'utf8');
  ctx.indexDao.upsertEntry(essencePath);
  return { ok: true };
}

export function updateTheme(
  ctx: Ctx,
  themeName: string,
  patch: { displayName?: string; removeTurns?: Array<{ sessionId: string; turnId: number }> },
): { ok: boolean } {
  const association = ctx.themeManager.loadTheme(themeName);
  if (!association) return { ok: false };

  if (typeof patch.displayName === 'string' && patch.displayName.trim()) {
    association.displayName = patch.displayName.trim();
  }

  if (Array.isArray(patch.removeTurns)) {
    const removeSet = new Set(
      patch.removeTurns.map((t) => `${t.sessionId}:${t.turnId}`),
    );
    association.turns = association.turns.filter(
      (t) => !removeSet.has(`${t.sessionId}:${t.turnId}`),
    );
  }

  association.updatedAt = new Date().toISOString();
  ctx.themeManager.saveTheme(themeName, association);
  return { ok: true };
}
