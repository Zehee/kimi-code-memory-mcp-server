/**
 * Memory CRUD tools: remember, recall, search, list, list_tags, delete, move.
 *
 * All write flows run inside the workspace lock and cover the complete
 * read-modify-write cycle: the Markdown file, the index and the theme
 * associations are updated together so a concurrent process cannot observe a
 * half applied change.
 */

import fs from 'fs';
import path from 'path';
import { WorkspaceJournal, runJournaled } from '../utils/workspace-journal.js';
import { faultPoint } from '../utils/fault-injection.js';
import type {
  Ctx,
  RememberArgs,
  RecallArgs,
  ListArgs,
  SearchArgs,
  DeleteArgs,
  MoveArgs,
  RestoreArgs,
} from '../types.js';
import type { ToolDefinition } from './types.js';
import { adaptHandler } from './types.js';
import { InvalidKeyError, sanitizeFolder, sanitizeKey, toTitle } from '../utils/validation.js';
import { MAX_MEMORY_BODY_BYTES } from '../config.js';
import { toolResult } from '../utils/tools.js';
import { safeParseFile, fileStats } from '../utils/file-helpers.js';
import { WorkspaceLock, WORKSPACE_LOCK_KEY, workspaceLockRoot } from '../utils/workspace-lock.js';
import { RevisionConflictError } from '../dao/memory-store.js';

export function createMemoryTools(ctx: Ctx): ToolDefinition[] {
  const { storeRoot, indexDao, themeManager, memoryStore } = ctx;
  const workspaceLock = new WorkspaceLock(workspaceLockRoot(storeRoot));

  async function handleRemember(args: RememberArgs) {
    const rawKey = args.key;
    if (!rawKey || typeof rawKey !== 'string') {
      return toolResult({ success: false, error: 'Missing or invalid "key"' }, true);
    }

    const folderRaw = typeof args.folder === 'string' ? args.folder : 'memory';
    const folder = sanitizeFolder(folderRaw);
    if (!folder) {
      return toolResult({ success: false, error: 'Invalid folder path' }, true);
    }

    // The key is normalized exactly once, at the boundary of this tool.
    let key: string;
    try {
      key = sanitizeKey(rawKey);
    } catch (err) {
      if (err instanceof InvalidKeyError) {
        return toolResult({ success: false, error: err.message, key: String(rawKey) }, true);
      }
      throw err;
    }
    const content = typeof args.content === 'string' ? args.content : '';
    if (Buffer.byteLength(content, 'utf8') > MAX_MEMORY_BODY_BYTES) {
      return toolResult(
        {
          success: false,
          error: `Memory body exceeds ${MAX_MEMORY_BODY_BYTES} bytes; split it into multiple entries`,
          key,
          folder,
        },
        true,
      );
    }
    // Tri-state tags: undefined keeps the current tags, [] clears them and a
    // non-empty array replaces them.
    const tags = Array.isArray(args.tags)
      ? args.tags.filter((t) => typeof t === 'string')
      : undefined;
    const themes = Array.isArray(args.themes)
      ? args.themes.filter((t) => typeof t === 'string')
      : [];
    const expectedRevision =
      typeof args.expectedRevision === 'number' && Number.isFinite(args.expectedRevision)
        ? args.expectedRevision
        : undefined;
    // Governance metadata: tri-state like tags.
    const sourceRefs = Array.isArray(args.sourceRefs)
      ? args.sourceRefs.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : undefined;
    const supersedes = Array.isArray(args.supersedes)
      ? args.supersedes.filter((s): s is string => typeof s === 'string' && s.length > 0)
      : undefined;
    const sensitivity = typeof args.sensitivity === 'string' ? args.sensitivity : undefined;

    try {
      const outcome = await workspaceLock.withLock(WORKSPACE_LOCK_KEY, () =>
        runJournaled(
          new WorkspaceJournal(storeRoot),
          'remember',
          {
            targetPath: path
              .relative(storeRoot, memoryStore.resolveFilePath(folder, key))
              .replace(/\\/g, '/'),
          },
          async () => {
            const write = memoryStore.writeWithResult(folder, key, content, tags, {
              expectedRevision,
              sourceRefs,
              supersedes,
              sensitivity,
            });

            // Checkpoint: the Markdown authority is written, derived stores are
            // not yet updated. Tests crash here to exercise recovery.
            faultPoint('remember.after-file-write');

            let indexUpdated = true;
            let indexError: string | undefined;
            let themeError: string | undefined;
            try {
              await indexDao.upsertEntry(write.filePath);
            } catch (err) {
              indexUpdated = false;
              indexError = err instanceof Error ? err.message : String(err);
            }

            faultPoint('remember.after-index-update');

            for (const theme of themes) {
              try {
                await themeManager.addThemeAssociation(theme, {
                  memoryKey: write.key,
                  folder,
                  title: write.title,
                  memoryId: write.id,
                  revision: write.revision,
                  contentHash: write.contentHash,
                });
              } catch (err) {
                // The memory is stored; the theme association is reported as
                // incomplete instead of failing the whole write.
                themeError = err instanceof Error ? err.message : String(err);
              }
            }

            return { write, indexUpdated, indexError, themeError };
          },
          { benign: (err) => err instanceof RevisionConflictError },
        ),
      );

      const payload = {
        success: true,
        key: outcome.write.key,
        folder,
        filePath: outcome.write.filePath,
        id: outcome.write.id,
        revision: outcome.write.revision,
        contentHash: outcome.write.contentHash,
        themes,
        sourceRefs,
        supersedes,
        sensitivity,
      };

      if (!outcome.indexUpdated || outcome.themeError) {
        // The memory is stored, but a derived structure is stale. Report the
        // degradation instead of a plain success.
        return toolResult(
          {
            ...payload,
            degraded: outcome.indexUpdated ? 'theme_update_failed' : 'index_stale',
            indexUpdated: outcome.indexUpdated,
            error: outcome.indexError ?? outcome.themeError,
          },
          false,
        );
      }

      return toolResult(payload);
    } catch (err) {
      if (err instanceof RevisionConflictError) {
        return toolResult(
          {
            success: false,
            error: 'RevisionConflict',
            message: err.message,
            key,
            folder,
            expectedRevision: err.expectedRevision,
            currentRevision: err.currentRevision,
            currentContentHash: err.currentContentHash,
          },
          true,
        );
      }
      return toolResult(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          key,
          folder,
        },
        true,
      );
    }
  }

  async function handleRecall(args: RecallArgs) {
    const rawKey = args.key;
    if (!rawKey || typeof rawKey !== 'string') {
      return toolResult({ found: false, error: 'Missing or invalid "key"' }, true);
    }

    const folderRaw = typeof args.folder === 'string' ? args.folder : 'memory';
    const folder = sanitizeFolder(folderRaw);
    if (!folder) {
      return toolResult({ found: false, error: 'Invalid folder path', key: rawKey }, true);
    }

    const detail = memoryStore.readDetailed(folder, rawKey);
    if (detail.status === 'not_found') {
      return toolResult({ found: false, key: sanitizeKey(rawKey), folder });
    }
    if (detail.status === 'corrupt' || !detail.memory) {
      return toolResult(
        {
          found: false,
          error: 'CorruptMemoryFile',
          message: detail.error ?? 'Memory file could not be parsed',
          key: sanitizeKey(rawKey),
          folder,
          filePath: detail.filePath ?? null,
        },
        true,
      );
    }

    const readResult = detail.memory;

    try {
      await indexDao.upsertEntry(readResult.filePath);
    } catch {
      /* the index is a rebuildable cache */
    }

    return toolResult({
      found: true,
      key: sanitizeKey(rawKey),
      folder,
      filePath: readResult.filePath,
      content: readResult.content,
      tags: Array.isArray(readResult.tags) ? readResult.tags : [],
      createdAt: readResult.createdAt || null,
      updatedAt: readResult.updatedAt || null,
      id: readResult.id ?? null,
      revision: readResult.revision ?? null,
      contentHash: readResult.contentHash ?? null,
    });
  }

  function handleSearch(args: SearchArgs) {
    const query = args.query;
    if (!query || typeof query !== 'string') {
      return toolResult({ items: [], error: 'Missing or invalid "query"' }, true);
    }
    const needle = query.toLowerCase();
    const folderFilterRaw = typeof args.folder === 'string' ? args.folder : null;
    const folderFilter = folderFilterRaw ? sanitizeFolder(folderFilterRaw) : null;
    if (folderFilterRaw && !folderFilter) {
      return toolResult({ items: [], error: 'Invalid folder path' }, true);
    }

    const index = indexDao.getIndex();
    const items = [];
    for (const key of Object.keys(index.index)) {
      if (!key.endsWith('.md')) continue;
      const value = index.index[key];
      const folder = path.dirname(key);
      const entryKey = path.basename(key, '.md');

      if (folderFilter && folder !== folderFilter) continue;

      const title = value.title || toTitle(entryKey);
      const haystack = `${title}\n${entryKey}`.toLowerCase();

      if (!haystack.includes(needle)) {
        const filePath = path.join(storeRoot, key);
        const parsed = safeParseFile(filePath);
        const body = parsed?.body || '';
        if (!body.toLowerCase().includes(needle)) continue;

        const matches = [];
        const lines = body.split(/\r?\n/);
        for (const line of lines) {
          if (line.toLowerCase().includes(needle)) {
            matches.push(line.trim().slice(0, 200));
            if (matches.length >= 3) break;
          }
        }
        items.push({ key: entryKey, folder, title, matches });
        continue;
      }

      items.push({ key: entryKey, folder, title, matches: [`title: ${title}`] });
    }

    return toolResult({ items });
  }

  function handleListTags() {
    const index = indexDao.getIndex();
    const tagSet = new Set();
    for (const key of Object.keys(index.index)) {
      if (!key.endsWith('.md')) continue;
      const value = index.index[key];
      if (Array.isArray(value.tags)) {
        for (const tag of value.tags) tagSet.add(tag);
      }
    }
    return toolResult({ tags: Array.from(tagSet).sort() });
  }

  async function handleList(args: ListArgs) {
    const folderFilterRaw = typeof args.folder === 'string' ? args.folder : null;
    const folderFilter = folderFilterRaw ? sanitizeFolder(folderFilterRaw) : null;
    if (folderFilterRaw && !folderFilter) {
      return toolResult({ items: [], error: 'Invalid folder path' }, true);
    }
    const tagFilter = typeof args.tag === 'string' ? args.tag : null;
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.floor(args.limit)) : null;
    const index = indexDao.getIndex();

    const items: {
      key: string;
      folder: string;
      title: string;
      tags: string[];
      updatedAt: string;
      size: number;
      id?: string;
      revision?: number;
      contentHash?: string;
    }[] = [];
    for (const key of Object.keys(index.index)) {
      if (!key.endsWith('.md')) continue;
      const value = index.index[key];
      const folder = path.dirname(key);
      if (folderFilter && folder !== folderFilter) continue;
      if (tagFilter && (!Array.isArray(value.tags) || !value.tags.includes(tagFilter))) continue;

      const filePath = path.join(storeRoot, key);
      const stats = fileStats(filePath);
      items.push({
        key: path.basename(key, '.md'),
        folder,
        title: value.title || toTitle(path.basename(key, '.md')),
        tags: Array.isArray(value.tags) ? value.tags : [],
        updatedAt: stats ? stats.modifiedAt : new Date().toISOString(),
        size: stats ? stats.size : 0,
      });
    }

    items.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const visible = limit !== null ? items.slice(0, limit) : items;

    // Cheap freshness check: an external edit bumps the revision and the
    // index is refreshed for the entries that are actually returned.
    for (const item of visible) {
      try {
        const sync = memoryStore.syncIdentity(item.folder, item.key);
        if (sync.identity) {
          item.id = sync.identity.id;
          item.revision = sync.identity.revision;
          item.contentHash = sync.identity.contentHash;
          if (sync.changed && sync.filePath) {
            await indexDao.upsertEntry(sync.filePath);
          }
        }
      } catch {
        /* listing must not fail because of one broken file */
      }
    }

    if (limit !== null) {
      return toolResult({
        items: visible.map((item) => {
          const filePath = memoryStore.findExistingFile(item.folder, item.key);
          const parsed = filePath ? safeParseFile(filePath) : null;
          return {
            ...item,
            preview: (parsed?.body || '').slice(0, 400),
          };
        }),
      });
    }

    return toolResult({ items: visible });
  }

  async function handleDelete(args: DeleteArgs) {
    const rawKey = args.key;
    if (!rawKey || typeof rawKey !== 'string') {
      return toolResult({ success: false, error: 'Missing or invalid "key"' }, true);
    }

    const folderRaw = typeof args.folder === 'string' ? args.folder : 'memory';
    const folder = sanitizeFolder(folderRaw);
    if (!folder) {
      return toolResult({ success: false, error: 'Invalid folder path', key: rawKey }, true);
    }

    try {
      const outcome = await workspaceLock.withLock(WORKSPACE_LOCK_KEY, () =>
        runJournaled(
          new WorkspaceJournal(storeRoot),
          'delete',
          {
            targetPath: path
              .relative(storeRoot, memoryStore.resolveFilePath(folder, sanitizeKey(rawKey)))
              .replace(/\\/g, '/'),
          },
          async () => {
            const removed = memoryStore.deleteWithResult(folder, rawKey);
            if (!removed) return null;

            faultPoint('delete.after-file-delete');

            const relativePath = path.relative(storeRoot, removed.filePath).replace(/\\/g, '/');
            await indexDao.deleteEntryByPath(relativePath);

            // References must not keep pointing at a path that no longer exists.
            let themeError: string | undefined;
            try {
              if (removed.id) {
                await themeManager.markMemoryDeleted(removed.id, {
                  folder: removed.folder,
                  key: removed.key,
                });
              } else {
                await themeManager.updateMemoryReferences({
                  previousFolder: removed.folder,
                  previousKey: removed.key,
                  status: 'deleted',
                });
              }
            } catch (err) {
              themeError = err instanceof Error ? err.message : String(err);
            }

            return { removed, themeError };
          },
          {
            benign: (err) => err instanceof RevisionConflictError,
            dropResult: (result) => result === null,
          },
        ),
      );

      if (!outcome) {
        return toolResult({ success: false, key: sanitizeKey(rawKey), folder, error: 'Memory not found' }, true);
      }

      return toolResult({
        success: true,
        key: outcome.removed.key,
        folder: outcome.removed.folder,
        id: outcome.removed.id || null,
        revision: outcome.removed.revision || null,
        // The entry is recoverable: report where the trash copy lives.
        trashPath: outcome.removed.trashPath
          ? path.relative(storeRoot, outcome.removed.trashPath).replace(/\\/g, '/')
          : undefined,
        recoverable: Boolean(outcome.removed.trashPath),
        ...(outcome.themeError
          ? { degraded: 'theme_update_failed', error: outcome.themeError }
          : {}),
      });
    } catch (err) {
      return toolResult(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          key: sanitizeKey(rawKey),
          folder,
        },
        true,
      );
    }
  }

  async function handleMove(args: MoveArgs) {
    const rawKey = args.key;
    if (!rawKey || typeof rawKey !== 'string') {
      return toolResult({ success: false, error: 'Missing or invalid "key"' }, true);
    }

    const folderRaw = typeof args.folder === 'string' ? args.folder : 'memory';
    const folder = sanitizeFolder(folderRaw);
    if (!folder) {
      return toolResult({ success: false, error: 'Invalid folder path', key: rawKey }, true);
    }

    const toFolderRaw = typeof args.toFolder === 'string' ? args.toFolder : null;
    if (!toFolderRaw) {
      return toolResult({ success: false, error: 'Missing "toFolder"' }, true);
    }
    const toFolder = sanitizeFolder(toFolderRaw);
    if (!toFolder) {
      return toolResult({ success: false, error: 'Invalid toFolder path', key: rawKey }, true);
    }

    const newKeyRaw = typeof args.newKey === 'string' ? args.newKey : rawKey;
    let newKey: string;
    try {
      newKey = sanitizeKey(newKeyRaw);
    } catch (err) {
      if (err instanceof InvalidKeyError) {
        return toolResult(
          { success: false, error: err.message, key: String(newKeyRaw), folder },
          true,
        );
      }
      throw err;
    }

    const sourcePath = memoryStore.findExistingFile(folder, rawKey);
    if (!sourcePath) {
      return toolResult({ success: false, key: newKey, folder, error: 'Memory not found' }, true);
    }

    const destPath = memoryStore.resolveFilePath(toFolder, newKey);
    if (fs.existsSync(destPath)) {
      return toolResult(
        {
          success: false,
          key: newKey,
          folder,
          toFolder,
          newKey,
          error: 'Destination already exists',
        },
        true,
      );
    }

    try {
      const moved = await workspaceLock.withLock(WORKSPACE_LOCK_KEY, () =>
        runJournaled(
          new WorkspaceJournal(storeRoot),
          'move',
          {
            targetPath: path
              .relative(storeRoot, memoryStore.resolveFilePath(toFolder, newKey))
              .replace(/\\/g, '/'),
            sourcePath: path.relative(storeRoot, sourcePath).replace(/\\/g, '/'),
          },
          async () => {
            const result = memoryStore.moveWithResult(folder, rawKey, toFolder, newKeyRaw);

            faultPoint('move.after-file-move');

            const oldRelativePath = path
              .relative(storeRoot, result.previousPath)
              .replace(/\\/g, '/');
            const newRelativePath = path.relative(storeRoot, result.filePath).replace(/\\/g, '/');
            await indexDao.moveEntry(oldRelativePath, newRelativePath);

            // The stable id does not change; only the cached location does.
            let themeError: string | undefined;
            try {
              await themeManager.updateMemoryReferences({
                memoryId: result.id,
                previousFolder: folder,
                previousKey: sanitizeKey(rawKey),
                key: result.key,
                folder: toFolder,
                title: result.title,
                revision: result.revision,
                contentHash: result.contentHash,
              });
            } catch (err) {
              themeError = err instanceof Error ? err.message : String(err);
            }

            return { result, themeError };
          },
        ),
      );

      return toolResult({
        success: true,
        key: moved.result.key,
        newKey: moved.result.key,
        fromFolder: folder,
        toFolder: moved.result.folder,
        filePath: moved.result.filePath,
        id: moved.result.id,
        revision: moved.result.revision,
        contentHash: moved.result.contentHash,
        ...(moved.themeError ? { degraded: 'theme_update_failed', error: moved.themeError } : {}),
      });
    } catch (err) {
      return toolResult(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          key: newKey,
          folder,
          toFolder,
        },
        true,
      );
    }
  }

  async function handleRestore(args: RestoreArgs) {
    const rawKey = args.key;
    if (!rawKey || typeof rawKey !== 'string') {
      return toolResult({ success: false, error: 'Missing or invalid "key"' }, true);
    }

    const folderRaw = typeof args.folder === 'string' ? args.folder : 'memory';
    const folder = sanitizeFolder(folderRaw);
    if (!folder) {
      return toolResult({ success: false, error: 'Invalid folder path', key: rawKey }, true);
    }

    try {
      const restored = await workspaceLock.withLock(WORKSPACE_LOCK_KEY, () =>
        runJournaled(
          new WorkspaceJournal(storeRoot),
          'restore',
          {
            targetPath: path
              .relative(storeRoot, memoryStore.resolveFilePath(folder, sanitizeKey(rawKey)))
              .replace(/\\/g, '/'),
          },
          async () => {
            const result = memoryStore.restoreWithResult(folder, rawKey);
            if (!result) return null;

            const relativePath = path.relative(storeRoot, result.filePath).replace(/\\/g, '/');
            await indexDao.upsertEntry(result.filePath);

            // The memory exists again: reactivate its theme references.
            let themeError: string | undefined;
            try {
              await themeManager.updateMemoryReferences({
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

            return { result, relativePath, themeError };
          },
          { dropResult: (result) => result === null },
        ),
      );

      if (!restored) {
        return toolResult(
          {
            success: false,
            key: sanitizeKey(rawKey),
            folder,
            error: 'No trash copy found for this key/folder',
          },
          true,
        );
      }

      return toolResult({
        success: true,
        key: restored.result.key,
        folder: restored.result.folder,
        filePath: restored.relativePath,
        id: restored.result.id,
        revision: restored.result.revision,
        contentHash: restored.result.contentHash,
        title: restored.result.title,
        ...(restored.themeError
          ? { degraded: 'theme_update_failed', error: restored.themeError }
          : {}),
      });
    } catch (err) {
      return toolResult(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
          key: sanitizeKey(rawKey),
          folder,
        },
        true,
      );
    }
  }

  const tools: ToolDefinition[] = [
    {
      name: 'remember',
      description: 'Write or overwrite a memory entry as a Markdown file with YAML frontmatter.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Unique identifier used as filename base' },
          content: {
            type: 'string',
            description:
              'Markdown body content. For decisions include rationale, impact, and related files. ' +
              'For rules include scope and consequence. For knowledge include scenario and related files/interfaces. ' +
              'For references include URL and relevance. Example decision: "# Use SQLite\\n\\n## Rationale\\n- Single-file deployment\\n- No extra service\\n\\n## Impact\\nAll cache reads/writes go through src/cache.js.\\n\\n## Related files\\nsrc/cache.js, docs/cache.md"',
          },
          folder: {
            type: 'string',
            description: 'Subfolder under the workspace (default: memory)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Tags stored in YAML frontmatter. Omit to keep the current tags, pass an empty array to clear them.',
          },
          themes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional theme names to associate with this memory',
          },
          expectedRevision: {
            type: 'number',
            description:
              'Optional optimistic concurrency check. The write is rejected when the stored revision differs.',
          },
          sourceRefs: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Provenance references recorded in frontmatter, e.g. "session-turn:<sessionId>:<turnId>" or a memory path. Omit to keep, empty array to clear.',
          },
          supersedes: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Memory keys/ids this entry replaces. Omit to keep, empty array to clear.',
          },
          sensitivity: {
            type: 'string',
            enum: ['public', 'workspace', 'private'],
            description: 'Visibility hint stored in frontmatter.',
          },
        },
        required: ['key'],
      },
      handler: adaptHandler(handleRemember),
    },
    {
      name: 'recall',
      description: 'Read a memory entry by key and folder.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key' },
          folder: { type: 'string', description: 'Subfolder (default: memory)' },
        },
        required: ['key'],
      },
      handler: adaptHandler(handleRecall),
    },
    {
      name: 'search',
      description: 'Case-insensitive keyword search across memory titles and contents.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword to search' },
          folder: { type: 'string', description: 'Limit search to a subfolder' },
        },
        required: ['query'],
      },
      handler: adaptHandler(handleSearch),
    },
    {
      name: 'list_tags',
      description: 'List all tags used in the current workspace.',
      inputSchema: { type: 'object', properties: {} },
      handler: adaptHandler(handleListTags),
    },
    {
      name: 'list',
      description: 'List memory entries in the workspace, sorted by most recently updated.',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: 'Filter to a specific subfolder' },
          limit: { type: 'number', description: 'Maximum number of entries to return (default: all)' },
          tag: { type: 'string', description: 'Filter to entries containing this tag' },
        },
      },
      handler: adaptHandler(handleList),
    },
    {
      name: 'delete',
      description: 'Delete a memory entry by key and folder.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key' },
          folder: { type: 'string', description: 'Subfolder (default: memory)' },
        },
        required: ['key'],
      },
      handler: adaptHandler(handleDelete),
    },
    {
      name: 'move',
      description: 'Move a memory entry to another folder, optionally renaming it.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key' },
          folder: { type: 'string', description: 'Source subfolder (default: memory)' },
          toFolder: { type: 'string', description: 'Destination subfolder' },
          newKey: { type: 'string', description: 'Optional new key to rename the memory' },
        },
        required: ['key', 'toFolder'],
      },
      handler: adaptHandler(handleMove),
    },
    {
      name: 'restore_memory',
      description:
        'Restore a previously deleted memory from the trash back to its original folder and key. The stable id and revision are preserved and theme references are reactivated.',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Memory key to restore' },
          folder: { type: 'string', description: 'Subfolder it was deleted from (default: memory)' },
        },
        required: ['key'],
      },
      handler: adaptHandler(handleRestore),
    },
  ];

  return tools;
}
