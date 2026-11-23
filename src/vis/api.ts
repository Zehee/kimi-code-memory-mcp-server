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
import type { MemoryStore } from '../dao/memory-store.js';
import { RevisionConflictError } from '../dao/memory-store.js';
import { findAllWorkspaceSessions } from '../context/wire-context.js';
import { safeResolve } from '../utils/paths.js';
import { InvalidKeyError, sanitizeFolder, sanitizeKey, toTitle } from '../utils/validation.js';
import { errorToHttpStatus } from '../utils/errors.js';
import { WorkspaceJournal, runJournaled } from '../utils/workspace-journal.js';
import { safeParseFile } from '../utils/file-helpers.js';
import type { ThemeAssociation } from '../theme-manager.js';
import type { RefinedTurn } from '../refine/types.js';
import type { IndexEntry } from '../dao/index.js';
import {
  InvalidSearchViewKeyError,
  SearchViewAccessError,
  SearchViewCorruptError,
  SearchViewNotFoundError,
} from '../search/search-view-repository.js';
import { deleteSearchView as deleteSearchViewRecord } from '../search/delete-search-view.js';
import { storeEssenceContent } from '../tools/system-tools.js';

export interface WorkspaceInfo {
  id: string;
  cwd: string;
  storePath: string;
  essence: string;
  essenceRevision: number;
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
  corrupt?: boolean;
  error?: string;
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

function readEssence(storeRoot: string): { content: string; revision: number } {
  const essencePath = path.join(storeRoot, 'essence', 'essence.md');
  const parsed = safeParseFile(essencePath);
  return {
    content: parsed?.body ?? '',
    revision:
      typeof parsed?.frontmatter.revision === 'number' && Number.isFinite(parsed.frontmatter.revision)
        ? parsed.frontmatter.revision
        : 0,
  };
}

export function getWorkspace(ctx: Ctx): WorkspaceInfo {
  const index = ctx.indexDao.getIndex().index;
  const memories = Object.keys(index).filter((k) => k.endsWith('.md')).length;
  const essence = readEssence(ctx.storeRoot);

  return {
    id: ctx.workspaceId,
    cwd: ctx.cwd,
    storePath: ctx.storeRoot,
    essence: essence.content,
    essenceRevision: essence.revision,
    stats: {
      memories,
      themes: ctx.themeManager.listThemes().length,
      refinedTurns: ctx.refinedManager.countAll(),
      sessions: findAllWorkspaceSessions().length,
    },
  };
}

export function getThemes(ctx: Ctx): ThemeInfo[] {
  return ctx.themeManager.listThemes().map((name) => {
    try {
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
        memoryCount: association.memories.filter((m) => m.status !== 'deleted').length,
      };
    } catch (err) {
      return {
        name,
        displayName: name,
        createdAt: '',
        updatedAt: '',
        turnCount: 0,
        memoryCount: 0,
        corrupt: true,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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

function memoryToTimelineItem(
  memory: ThemeAssociation['memories'][number],
  memoryStore: MemoryStore,
): TimelineItem | null {
  // Deleted / orphaned references must not render whatever file currently
  // sits at the cached path (the review repro: a new, unrelated memory B
  // after the referenced memory A was deleted). Only active references are
  // eligible for content rendering.
  if (memory.status && memory.status !== 'active') {
    return {
      type: 'memory',
      timestamp: memory.timestamp,
      data: {
        key: memory.key,
        folder: memory.folder,
        title: memory.title,
        content: '',
        missing: true,
        status: memory.status,
      },
    };
  }

  const detail = memoryStore.readDetailed(memory.folder, memory.key);
  if (detail.status !== 'ok') {
    // The cached path no longer resolves to a readable memory.
    return {
      type: 'memory',
      timestamp: memory.timestamp,
      data: {
        key: memory.key,
        folder: memory.folder,
        title: memory.title,
        content: '',
        missing: true,
        status: memory.status ?? 'missing',
      },
    };
  }

  const file = detail.memory!;
  // A reference carrying a stable id must match the file's id: a reused path
  // with a different memory must not be rendered under the old reference.
  if (memory.memoryId && file.id && memory.memoryId !== file.id) {
    return {
      type: 'memory',
      timestamp: memory.timestamp,
      data: {
        key: memory.key,
        folder: memory.folder,
        title: memory.title,
        content: '',
        missing: true,
        status: 'id_mismatch',
      },
    };
  }

  return {
    type: 'memory',
    timestamp: memory.timestamp,
    data: {
      key: file.key ?? memory.key,
      folder: file.folder ?? memory.folder,
      title: file.title || memory.title,
      content: file.content,
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
    const item = memoryToTimelineItem(memory, ctx.memoryStore);
    if (item) items.push(item);
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

function buildRootNode(
  rootName: string,
  index: Record<string, IndexEntry>,
  storeRoot: string,
): MemoryNode {
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
    children: [
      buildRootNode('memory', index, ctx.storeRoot),
      buildRootNode('notes', index, ctx.storeRoot),
    ],
  };
}

export function getMemoryContent(
  ctx: Ctx,
  folder: string,
  key: string,
): {
  content: string;
  title: string;
  tags: string[];
  id?: string;
  revision?: number;
  contentHash?: string;
} | null {
  const result = ctx.memoryStore.read(folder, key);
  if (!result) return null;
  return {
    content: result.content,
    title: String(result.title || key),
    tags: Array.isArray(result.tags) ? result.tags : [],
    id: result.id,
    revision: result.revision,
    contentHash: result.contentHash,
  };
}

export async function writeMemory(
  ctx: Ctx,
  folder: string,
  key: string,
  options: {
    content?: string;
    title?: string;
    tags?: string[];
    expectedRevision?: number;
    expectedContentHash?: string;
  },
): Promise<{
  ok: boolean;
  filePath?: string;
  id?: string;
  revision?: number;
  contentHash?: string;
  currentRevision?: number;
  currentContentHash?: string;
  degraded?: string;
  statusCode?: 400 | 409 | 500;
  error?: string;
}> {
  const normalizedFolder = validateFolderPath(folder);
  if (!normalizedFolder) {
    return { ok: false, statusCode: 400, error: 'Invalid folder path' };
  }
  let normalizedKey: string;
  try {
    normalizedKey = sanitizeKey(key);
  } catch (error) {
    if (error instanceof InvalidKeyError) {
      return { ok: false, statusCode: 400, error: error.message };
    }
    throw error;
  }
  const content = typeof options.content === 'string' ? options.content : '';
  const title = typeof options.title === 'string' ? options.title : undefined;
  const tags = Array.isArray(options.tags)
    ? options.tags.filter((tag): tag is string => typeof tag === 'string')
    : undefined;

  try {
    return await ctx.memoryStore.withWorkspaceLock(() =>
      runJournaled(
        new WorkspaceJournal(ctx.storeRoot),
        'remember',
        {
          targetPath: path
            .relative(ctx.storeRoot, ctx.memoryStore.resolveFilePath(normalizedFolder, normalizedKey))
            .replace(/\\/g, '/'),
        },
        async () => {
          const write = ctx.memoryStore.writeWithResult(
            normalizedFolder,
            normalizedKey,
            content,
            tags,
            {
              title,
              expectedRevision: options.expectedRevision,
              expectedContentHash: options.expectedContentHash,
            },
          );
          let degraded: string | undefined;
          try {
            await ctx.indexDao.upsertEntry(write.filePath);
          } catch {
            degraded = 'index_stale';
          }
          return {
            ok: true as const,
            filePath: path.relative(ctx.storeRoot, write.filePath).replace(/\\/g, '/'),
            id: write.id,
            revision: write.revision,
            contentHash: write.contentHash,
            degraded,
          };
        },
        { benign: (err) => err instanceof RevisionConflictError },
      ),
    );
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      return {
        ok: false,
        statusCode: 409,
        error: 'RevisionConflict',
        currentRevision: error.currentRevision,
        currentContentHash: error.currentContentHash,
      };
    }
    // Stable error taxonomy instead of raw errno strings.
    const mapped = errorToHttpStatus(error);
    return { ok: false, statusCode: mapped.statusCode as 400 | 409 | 500, error: `${mapped.code}: ${mapped.message}` };
  }
}

export async function restoreMemory(
  ctx: Ctx,
  folder: string,
  key: string,
): Promise<{
  ok: boolean;
  error?: string;
  filePath?: string;
  id?: string;
  revision?: number;
}> {
  const normalizedFolder = validateFolderPath(folder);
  if (!normalizedFolder) {
    return { ok: false, error: 'Invalid folder path' };
  }
  let normalizedKey: string;
  try {
    normalizedKey = sanitizeKey(key);
  } catch (error) {
    if (error instanceof InvalidKeyError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  return ctx.memoryStore.withWorkspaceLock(() =>
    runJournaled(
      new WorkspaceJournal(ctx.storeRoot),
      'restore',
      {
        targetPath: path
          .relative(ctx.storeRoot, ctx.memoryStore.resolveFilePath(normalizedFolder, normalizedKey))
          .replace(/\\/g, '/'),
      },
      async () => {
        const result = ctx.memoryStore.restoreWithResult(normalizedFolder, normalizedKey);
        if (!result) {
          return { ok: false as const, error: 'No trash copy found for this key/folder', notFound: true };
        }
        const relativePath = path.relative(ctx.storeRoot, result.filePath).replace(/\\/g, '/');
        let degraded: string | undefined;
        try {
          await ctx.indexDao.upsertEntry(result.filePath);
        } catch {
          degraded = 'index_stale';
        }
        let themeError: string | undefined;
        try {
          await ctx.themeManager.updateMemoryReferences({
            memoryId: result.id,
            folder: result.folder,
            key: result.key,
            title: result.title,
            revision: result.revision,
            contentHash: result.contentHash,
            status: 'active',
          });
        } catch (err) {
          themeError = err instanceof Error ? err.message : String(err);
        }
        return {
          ok: true as const,
          filePath: relativePath,
          id: result.id,
          revision: result.revision,
          ...(degraded ? { degraded } : {}),
          ...(themeError ? { themeError } : {}),
        };
      },
      { dropResult: (result) => result.ok === false, strip: ['notFound'] },
    ),
  );
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
  let normalizedKey: string;
  try {
    normalizedKey = sanitizeKey(key);
  } catch (error) {
    if (error instanceof InvalidKeyError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
  return ctx.memoryStore.withWorkspaceLock(() =>
    runJournaled(
      new WorkspaceJournal(ctx.storeRoot),
      'delete',
      {
        targetPath: path
          .relative(ctx.storeRoot, ctx.memoryStore.resolveFilePath(normalizedFolder, normalizedKey))
          .replace(/\\/g, '/'),
      },
      async () => {
        const removed = ctx.memoryStore.deleteWithResult(normalizedFolder, normalizedKey);
        if (!removed) {
          return { ok: false as const, error: 'Memory not found', notFound: true };
        }
        const relativePath = path.relative(ctx.storeRoot, removed.filePath).replace(/\\/g, '/');
        await ctx.indexDao.deleteEntryByPath(relativePath);
        if (removed.id) {
          await ctx.themeManager.markMemoryDeleted(removed.id, {
            folder: removed.folder,
            key: removed.key,
          });
        } else {
          await ctx.themeManager.updateMemoryReferences({
            previousFolder: removed.folder,
            previousKey: removed.key,
            status: 'deleted',
          });
        }
        return { ok: true as const };
      },
      {
        // "Not found" means nothing was mutated: drop instead of failing.
        dropResult: (result) => result.ok === false,
        strip: ['notFound'],
      },
    ),
  );
}

export async function createFolder(
  ctx: Ctx,
  folderPath: string,
): Promise<{ ok: boolean; error?: string }> {
  const normalized = validateFolderPath(folderPath, false);
  if (!normalized) {
    return { ok: false, error: 'Invalid folder path' };
  }
  return ctx.memoryStore.withWorkspaceLock(async () => {
    const absPath = safeResolve(ctx.storeRoot, normalized);
    if (fs.existsSync(absPath)) {
      return { ok: false, error: 'Folder already exists' };
    }
    fs.mkdirSync(absPath, { recursive: true });
    await ctx.indexDao.setFolderComment(normalized, '');
    return { ok: true };
  });
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
  return ctx.memoryStore.withWorkspaceLock(async () => {
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
    await ctx.themeManager.updateMemoryFolderReferences(oldNormalized, newNormalized);
    await ctx.indexDao.reconcileIndex();
    return { ok: true };
  });
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
  return ctx.memoryStore.withWorkspaceLock(() =>
    runJournaled(
      new WorkspaceJournal(ctx.storeRoot),
      'delete',
      { targetPath: `${normalized}/ (recursive)` },
      async () => {
        const absPath = safeResolve(ctx.storeRoot, normalized);
        if (!fs.existsSync(absPath)) {
          return { ok: false as const, error: 'Folder not found', notFound: true, deleted: 0 };
        }

        let deleted = 0;
        if (recursive) {
          // Every memory inside the folder goes through the same soft delete
          // as the single-memory path: trash copy, index removal and theme
          // reference bookkeeping. A recursive hard delete would permanently
          // destroy the entries (review R-04).
          const stack = [absPath];
          while (stack.length > 0) {
            const dir = stack.pop()!;
            let entries: fs.Dirent[] = [];
            try {
              entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
              continue;
            }
            for (const entry of entries) {
              const full = path.join(dir, entry.name);
              if (entry.isDirectory()) {
                stack.push(full);
                continue;
              }
              if (!entry.isFile() || !entry.name.endsWith('.md')) continue;

              const relativeFolder = path
                .relative(ctx.storeRoot, path.dirname(full))
                .replace(/\\/g, '/');
              const key = path.basename(entry.name, '.md');
              const removed = ctx.memoryStore.deleteWithResult(relativeFolder, key);
              if (!removed) continue;
              await ctx.indexDao.deleteEntryByPath(
                path.relative(ctx.storeRoot, removed.filePath).replace(/\\/g, '/'),
              );
              if (removed.id) {
                await ctx.themeManager.markMemoryDeleted(removed.id, {
                  folder: removed.folder,
                  key: removed.key,
                });
              } else {
                await ctx.themeManager.updateMemoryReferences({
                  previousFolder: removed.folder,
                  previousKey: removed.key,
                  status: 'deleted',
                });
              }
              deleted++;
            }
          }
          // Remove only the now-empty directory tree. Any non-memory files
          // the user kept in the folder must survive: rmSync recursive would
          // permanently destroy them (the same class of loss as review
          // R-04). Leftover files keep their folder in place.
          removeEmptyTree(absPath);
        } else {
          const entries = fs.readdirSync(absPath);
          if (entries.length > 0) {
            return { ok: false as const, error: 'Folder is not empty', notFound: true, deleted: 0 };
          }
          fs.rmdirSync(absPath);
        }
        await ctx.themeManager.updateMemoryFolderReferences(normalized, normalized, {
          status: 'deleted',
        });
        await ctx.indexDao.reconcileIndex();
        return { ok: true as const, deleted };
      },
      { dropResult: (result) => result.ok === false, strip: ['notFound'] },
    ),
  );
}

export async function saveEssence(
  ctx: Ctx,
  content: string,
  expectedRevision?: number,
): Promise<{
  ok: boolean;
  degraded?: string;
  revision?: number;
  statusCode?: 409;
  error?: string;
  currentRevision?: number;
  currentContentHash?: string;
}> {
  try {
    const result = await storeEssenceContent(ctx, content, { expectedRevision });
    return { ok: result.ok, degraded: result.degraded, revision: result.revision };
  } catch (error) {
    if (error instanceof RevisionConflictError) {
      return {
        ok: false,
        statusCode: 409,
        error: 'RevisionConflict',
        currentRevision: error.currentRevision,
        currentContentHash: error.currentContentHash,
      };
    }
    throw error;
  }
}

/**
 * Remove a directory tree bottom-up, deleting only directories that became
 * empty after the soft delete. Directories still holding files (anything
 * that is not a .md memory — e.g. user attachments) are kept, and so are
 * their ancestors.
 */
function removeEmptyTree(root: string): void {
  const removeIfEmpty = (dir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!removeIfEmpty(full)) return false;
      } else {
        return false;
      }
    }
    try {
      fs.rmdirSync(dir);
      return true;
    } catch {
      return false;
    }
  };
  removeIfEmpty(root);
}

export async function updateTheme(
  ctx: Ctx,
  themeName: string,
  patch: { displayName?: string; removeTurns?: Array<{ sessionId: string; turnId: number }> },
): Promise<{ ok: boolean }> {
  return ctx.memoryStore.withWorkspaceLock(() => {
    const association = ctx.themeManager.loadTheme(themeName);
    if (!association) return { ok: false };

    if (typeof patch.displayName === 'string' && patch.displayName.trim()) {
      association.displayName = patch.displayName.trim();
    }

    if (Array.isArray(patch.removeTurns)) {
      const removeSet = new Set(patch.removeTurns.map((t) => `${t.sessionId}:${t.turnId}`));
      association.turns = association.turns.filter(
        (t) => !removeSet.has(`${t.sessionId}:${t.turnId}`),
      );
    }

    association.updatedAt = new Date().toISOString();
    ctx.themeManager.saveTheme(themeName, association);
    return { ok: true };
  });
}

export async function deleteTheme(
  ctx: Ctx,
  themeName: string,
): Promise<{ ok: boolean; error?: string }> {
  return ctx.memoryStore.withWorkspaceLock(() => {
    const deleted = ctx.themeManager.deleteTheme(themeName);
    if (!deleted) {
      return { ok: false, error: 'Theme not found' };
    }
    return { ok: true };
  });
}

export async function deleteSearchView(
  ctx: Ctx,
  key: string,
  deleteRefinedTurns = false,
): Promise<{
  ok: boolean;
  error?: string;
  statusCode?: 400 | 404 | 500;
  deletedRefinedTurns?: number;
  skippedSharedRefinedTurns?: number;
  skippedSharedRefinedTurnRefs?: string[];
}> {
  try {
    const result = await deleteSearchViewRecord(ctx, key, deleteRefinedTurns);
    return { ok: true, ...result };
  } catch (error) {
    const statusCode =
      error instanceof InvalidSearchViewKeyError || error instanceof SearchViewAccessError
        ? 400
        : error instanceof SearchViewNotFoundError
          ? 404
          : error instanceof SearchViewCorruptError
            ? 500
            : // Unknown failures go through the stable taxonomy.
              (errorToHttpStatus(error).statusCode as 400 | 404 | 500);
    const code =
      error instanceof Error && 'code' in error
        ? String((error as { code?: unknown }).code)
        : errorToHttpStatus(error).code;
    return {
      ok: false,
      statusCode,
      error: `${code}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
