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
import { atomicWriteFile, safeResolve } from '../utils/paths.js';
import { sanitizeFolder, sanitizeKey, toTitle } from '../utils/validation.js';
import { safeParseFile } from '../utils/file-helpers.js';
import type { ThemeAssociation } from '../theme-manager.js';
import type { RefinedTurn } from '../refine/types.js';
import type { IndexEntry } from '../dao/index.js';

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

function validateFolderPath(folder: unknown, allowRoot = true): string | null {
  const sanitized = sanitizeFolder(folder);
  if (!sanitized) return null;
  if (
    sanitized !== 'memory' &&
    !sanitized.startsWith('memory/') &&
    sanitized !== 'notes' &&
    !sanitized.startsWith('notes/')
  ) {
    return null;
  }
  if (!allowRoot && (sanitized === 'memory' || sanitized === 'notes')) return null;
  return sanitized;
}

export function listMemoryFolders(ctx: Ctx): string[] {
  const folders: string[] = [];
  for (const root of ['memory', 'notes']) {
    const rootPath = path.join(ctx.storeRoot, root);
    if (!fs.existsSync(rootPath)) continue;
    folders.push(root);
    const walk = (dir: string, prefix: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        folders.push(rel);
        walk(path.join(dir, entry.name), rel);
      }
    };
    walk(rootPath, root);
  }
  return folders.sort();
}

function buildRootNode(rootName: string, index: Record<string, IndexEntry>, storeRoot: string): MemoryNode {
  const root: MemoryNode = {
    name: rootName,
    comment: index[`${rootName}/`]?.comment || '',
    files: [],
    children: [],
  };

  for (const key of Object.keys(index).sort()) {
    if (!key.startsWith(`${rootName}/`)) continue;

    if (key.endsWith('/')) {
      if (key === `${rootName}/`) continue;
      const relativeFolder = key.slice(rootName.length + 1, -1);
      const parts = relativeFolder.split('/');
      let current = root;
      let currentPath = rootName;
      for (const part of parts) {
        currentPath = `${currentPath}/${part}`;
        let child = current.children.find((c) => c.name === part);
        if (!child) {
          child = {
            name: part,
            comment: index[`${currentPath}/`]?.comment || '',
            files: [],
            children: [],
          };
          current.children.push(child);
        }
        current = child;
      }
      current.comment = index[key]?.comment || '';
    } else if (key.endsWith('.md')) {
      const relativePath = key.slice(rootName.length + 1);
      const dirPart = path.dirname(relativePath);
      const parts = dirPart === '.' ? [] : dirPart.split('/');
      const fileName = path.basename(key, '.md');
      const value = index[key];
      let current = root;
      for (const part of parts) {
        let child = current.children.find((c) => c.name === part);
        if (!child) {
          child = { name: part, comment: '', files: [], children: [] };
          current.children.push(child);
        }
        current = child;
      }
      const filePath = path.join(storeRoot, key);
      const parsed = safeParseFile(filePath);
      current.files.push({
        key: fileName,
        title: value?.title || toTitle(fileName),
        tags: Array.isArray(value?.tags) ? value.tags : [],
        createdAt: String(parsed?.frontmatter?.createdAt || ''),
        updatedAt: String(parsed?.frontmatter?.updatedAt || ''),
      });
    }
  }

  return root;
}

export function getMemories(ctx: Ctx): MemoryNode {
  const index = ctx.indexDao.getIndex().index;
  return {
    name: '',
    comment: '',
    files: [],
    children: [buildRootNode('memory', index, ctx.storeRoot), buildRootNode('notes', index, ctx.storeRoot)],
  };
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

export async function writeMemory(
  ctx: Ctx,
  folder: string,
  key: string,
  options: { content?: string; title?: string; tags?: string[] },
): Promise<{ ok: boolean; filePath?: string; error?: string }> {
  const normalizedFolder = validateFolderPath(folder);
  if (!normalizedFolder) {
    return { ok: false, error: 'Invalid folder path' };
  }
  const normalizedKey = sanitizeKey(key);
  const content = typeof options.content === 'string' ? options.content : '';
  const title = typeof options.title === 'string' ? options.title : undefined;
  const tags = Array.isArray(options.tags) ? options.tags.filter((t) => typeof t === 'string') : [];

  const filePath = ctx.memoryStore.write(normalizedFolder, normalizedKey, content, tags, { title });
  await ctx.indexDao.upsertEntry(filePath);
  return { ok: true, filePath: path.relative(ctx.storeRoot, filePath).replace(/\\/g, '/') };
}

export async function deleteMemory(
  ctx: Ctx,
  folder: string,
  key: string,
): Promise<{ ok: boolean; error?: string }> {
  const normalizedFolder = validateFolderPath(folder);
  if (!normalizedFolder) {
    return { ok: false, error: 'Invalid folder path' };
  }
  const normalizedKey = sanitizeKey(key);
  const filePath = ctx.memoryStore.resolveFilePath(normalizedFolder, normalizedKey);
  const relativePath = path.relative(ctx.storeRoot, filePath).replace(/\\/g, '/');
  const deleted = ctx.memoryStore.delete(normalizedFolder, normalizedKey);
  if (!deleted) {
    return { ok: false, error: 'Memory not found' };
  }
  await ctx.indexDao.deleteEntryByPath(relativePath);
  return { ok: true };
}

export async function createFolder(
  ctx: Ctx,
  folderPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const normalized = validateFolderPath(folderPath, false);
  if (!normalized) {
    return { ok: false, error: 'Invalid folder path' };
  }
  const absPath = safeResolve(ctx.storeRoot, normalized);
  if (fs.existsSync(absPath)) {
    return { ok: false, error: 'Folder already exists' };
  }
  fs.mkdirSync(absPath, { recursive: true });
  await ctx.indexDao.setFolderComment(normalized, '');
  return { ok: true };
}

export async function renameFolder(
  ctx: Ctx,
  oldFolderPath: string,
  newFolderPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const oldNormalized = validateFolderPath(oldFolderPath, false);
  if (!oldNormalized) {
    return { ok: false, error: 'Invalid source folder path' };
  }
  const newNormalized = validateFolderPath(newFolderPath, false);
  if (!newNormalized) {
    return { ok: false, error: 'Invalid destination folder path' };
  }
  if (oldNormalized === newNormalized) {
    return { ok: false, error: 'Source and destination are the same' };
  }
  const oldAbs = safeResolve(ctx.storeRoot, oldNormalized);
  const newAbs = safeResolve(ctx.storeRoot, newNormalized);
  if (!fs.existsSync(oldAbs)) {
    return { ok: false, error: 'Source folder not found' };
  }
  if (fs.existsSync(newAbs)) {
    return { ok: false, error: 'Destination folder already exists' };
  }
  fs.mkdirSync(path.dirname(newAbs), { recursive: true });
  fs.renameSync(oldAbs, newAbs);
  await ctx.indexDao.reconcileIndex();
  return { ok: true };
}

export async function deleteFolder(
  ctx: Ctx,
  folderPath: string,
  recursive = false,
): Promise<{ ok: boolean; error?: string }> {
  const normalized = validateFolderPath(folderPath, false);
  if (!normalized) {
    return { ok: false, error: 'Invalid folder path' };
  }
  const absPath = safeResolve(ctx.storeRoot, normalized);
  if (!fs.existsSync(absPath)) {
    return { ok: false, error: 'Folder not found' };
  }
  if (recursive) {
    fs.rmSync(absPath, { recursive: true, force: true });
  } else {
    const entries = fs.readdirSync(absPath);
    if (entries.length > 0) {
      return { ok: false, error: 'Folder is not empty' };
    }
    fs.rmdirSync(absPath);
  }
  await ctx.indexDao.reconcileIndex();
  return { ok: true };
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

export function deleteTheme(ctx: Ctx, themeName: string): { ok: boolean; error?: string } {
  const deleted = ctx.themeManager.deleteTheme(themeName);
  if (!deleted) {
    return { ok: false, error: 'Theme not found' };
  }
  return { ok: true };
}

export async function deleteSearchView(
  ctx: Ctx,
  key: string,
  deleteRefinedTurns = false,
): Promise<{ ok: boolean; error?: string; deletedRefinedTurns?: number }> {
  const filePath = path.join(ctx.storeRoot, 'searches', `${key}.json`);
  if (!fs.existsSync(filePath)) {
    return { ok: false, error: 'Search view not found' };
  }

  const refinedTurnsToDelete: Array<{ sessionId: string; turnId: number }> = [];
  if (deleteRefinedTurns) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const clusters = Array.isArray(data.clusters) ? data.clusters : [];
      const seen = new Set<string>();
      for (const cluster of clusters) {
        const members = Array.isArray(cluster.members) ? cluster.members : [];
        for (const m of members) {
          if (m && typeof m.sessionId === 'string' && typeof m.turnId === 'number') {
            const id = `${m.sessionId}:${m.turnId}`;
            if (!seen.has(id)) {
              seen.add(id);
              refinedTurnsToDelete.push({ sessionId: m.sessionId, turnId: m.turnId });
            }
          }
        }
      }
    } catch {
      // Fall through to deleting the file even if parsing fails.
    }
  }

  fs.unlinkSync(filePath);

  let deletedRefinedTurns = 0;
  if (deleteRefinedTurns && refinedTurnsToDelete.length > 0) {
    deletedRefinedTurns = await ctx.refinedManager.deleteRefinedTurns(refinedTurnsToDelete);
  }

  return { ok: true, deletedRefinedTurns };
}
