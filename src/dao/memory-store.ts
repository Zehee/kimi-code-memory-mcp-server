/**
 * Markdown memory file operations.
 *
 * Every memory file carries a stable identity in its frontmatter:
 *
 * - `id` — stable identifier, random for new memories and deterministic during
 *   legacy backfill so concurrent readers converge on the same value.
 * - `revision` — monotonically increasing counter, bumped on every write and
 *   whenever an external edit is detected.
 * - `contentHash` — hash of the Markdown body.
 * - `metadataHash` — hash of stable frontmatter fields, so metadata-only
 *   external edits also advance the revision.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Frontmatter, FrontmatterValue } from '../utils/frontmatter.js';
import {
  parseFrontmatter,
  stringifyFrontmatter,
  FrontmatterParseError,
} from '../utils/frontmatter.js';
import {
  safeResolve,
  atomicWriteFile,
  assertSafeExistingFile,
  isSafeExistingFile,
  safeRealpath,
} from '../utils/paths.js';
import { sanitizeFolder, sanitizeKey, toTitle as toTitleUtil, assertValidKey } from '../utils/validation.js';
import { WorkspaceLock, WORKSPACE_LOCK_KEY, workspaceLockRoot } from '../utils/workspace-lock.js';
import { metrics } from '../utils/metrics.js';
import { faultPoint } from '../utils/fault-injection.js';

export interface MemoryIdentity {
  id: string;
  revision: number;
  contentHash: string;
}

export interface MemoryReadResult {
  content: string;
  filePath: string;
  tags: string[];
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  id?: string;
  revision?: number;
  contentHash?: string;
  [key: string]: FrontmatterValue | undefined;
}

export interface WriteOptions {
  title?: string;
  /** Reject the write when the stored revision differs. */
  expectedRevision?: number;
  /** Reject the write when the stored content hash differs. */
  expectedContentHash?: string;
  /**
   * Provenance references, e.g. `session-turn:<sessionId>:<turnId>` or a
   * `memory/...` path. Tri-state like tags: `undefined` keeps, `[]` clears.
   */
  sourceRefs?: string[];
  /** Memory ids/keys this entry supersedes. Tri-state like tags. */
  supersedes?: string[];
  /** Visibility hint: `public` | `workspace` | `private`. */
  sensitivity?: string;
}

export interface MemoryWriteResult {
  filePath: string;
  key: string;
  folder: string;
  id: string;
  revision: number;
  contentHash: string;
  title: string;
  created: boolean;
}

export interface MemoryMoveResult {
  filePath: string;
  previousPath: string;
  key: string;
  folder: string;
  title: string;
  id: string;
  revision: number;
  contentHash: string;
}

export interface MemoryDeleteResult {
  filePath: string;
  key: string;
  folder: string;
  id: string;
  revision: number;
  contentHash: string;
  /** Where the deleted entry was moved to (soft delete). */
  trashPath?: string;
}

export interface MemoryRestoreResult {
  filePath: string;
  /** Trash copy the entry was restored from. */
  trashPath: string;
  key: string;
  folder: string;
  id: string;
  revision: number;
  contentHash: string;
  title: string;
}

export interface TrashEntry {
  /** Original store-relative path of the deleted entry. */
  deletedFrom: string;
  trashPath: string;
  key: string;
  folder: string;
  id: string | null;
  deletedAt: string | null;
}

export type MemoryReadStatus = 'ok' | 'not_found' | 'corrupt';

export interface MemoryReadDetail {
  status: MemoryReadStatus;
  filePath?: string;
  memory?: MemoryReadResult;
  error?: string;
}

/** Raised when an optimistic concurrency check fails. */
export class RevisionConflictError extends Error {
  readonly expectedRevision: number;
  readonly currentRevision: number;
  readonly currentContentHash: string;
  readonly key: string;
  readonly folder: string;

  constructor(params: {
    expectedRevision: number;
    currentRevision: number;
    currentContentHash: string;
    key: string;
    folder: string;
  }) {
    super(
      `Revision conflict for ${params.folder}/${params.key}: expected revision ` +
        `${params.expectedRevision}, current revision is ${params.currentRevision}`,
    );
    this.name = 'RevisionConflict';
    this.expectedRevision = params.expectedRevision;
    this.currentRevision = params.currentRevision;
    this.currentContentHash = params.currentContentHash;
    this.key = params.key;
    this.folder = params.folder;
  }
}

/** Raised when a memory file cannot be parsed. */
export class MemoryCorruptError extends Error {
  readonly filePath: string;

  constructor(filePath: string, cause: unknown) {
    super(
      `Corrupt memory file ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'MemoryCorruptError';
    this.filePath = filePath;
  }
}

interface MemoryFile {
  filePath: string;
  frontmatter: Frontmatter;
  body: string;
}

export type { MemoryFile };

interface CachedIdentity {
  mtimeMs: number;
  size: number;
  identity: MemoryIdentity;
}

/** Hash of the Markdown body of a memory file. */
export function hashContent(body: string): string {
  return `sha256:${crypto.createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

function hashMetadata(frontmatter: Frontmatter): string {
  const entries = Object.entries(frontmatter)
    .filter(([key]) => !['revision', 'updatedAt', 'contentHash', 'metadataHash'].includes(key))
    .sort(([a], [b]) => a.localeCompare(b));
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(entries), 'utf8').digest('hex')}`;
}

export class MemoryStore {
  storeRoot: string;
  lockRoot: string;
  private lock: WorkspaceLock;
  private identityCache = new Map<string, CachedIdentity>();

  constructor(storeRoot: string, options: { lockRoot?: string } = {}) {
    this.storeRoot = storeRoot;
    this.lockRoot = options.lockRoot ?? workspaceLockRoot(storeRoot);
    this.lock = new WorkspaceLock(this.lockRoot);
  }

  /** Run a function while holding the workspace lock. */
  async withWorkspaceLock<T>(fn: () => Promise<T> | T): Promise<T> {
    return this.lock.withLock(WORKSPACE_LOCK_KEY, fn);
  }

  /** Canonical path of a memory file (sanitized key). */
  resolveFilePath(folder: string, key: string): string {
    return safeResolve(this.storeRoot, folder, `${sanitizeKey(key)}.md`);
  }

  /** Legacy path of a memory file (raw key, kept for backwards compatibility). */
  resolveLegacyFilePath(folder: string, key: string): string {
    return safeResolve(this.storeRoot, folder, `${key}.md`);
  }

  /**
   * Locate an existing memory file.
   *
   * The canonical (sanitized) path wins; legacy files written with an
   * unsanitized key are still found so that old data stays readable,
   * movable and safely deletable.
   */
  findExistingFile(folder: string, key: string): string | null {
    const canonical = this.resolveFilePath(folder, key);
    if (fs.existsSync(canonical)) return canonical;

    let legacy: string;
    try {
      legacy = this.resolveLegacyFilePath(folder, key);
    } catch {
      return null;
    }
    if (legacy === canonical) return null;
    if (fs.existsSync(legacy)) return legacy;
    return null;
  }

  exists(folder: string, key: string): boolean {
    return this.findExistingFile(folder, key) !== null;
  }

  /** Read a memory entry, backfilling identity metadata when necessary. */
  read(folder: string, key: string): MemoryReadResult | null {
    const detail = this.readDetailed(folder, key);
    return detail.status === 'ok' ? (detail.memory ?? null) : null;
  }

  /** Read a memory entry and report why it could not be read. */
  readDetailed(folder: string, key: string): MemoryReadDetail {
    const filePath = this.findExistingFile(folder, key);
    if (!filePath) return { status: 'not_found' };

    // Reads must not escape the store through a symlink either: a memory
    // path that turned out to be a link to somewhere else is refused with a
    // clear diagnosis instead of being followed.
    if (!isSafeExistingFile(filePath, this.realStoreRoot() ?? undefined)) {
      return {
        status: 'corrupt',
        filePath,
        error: 'Memory path is a symbolic link escaping the store; read refused',
      };
    }

    let file: MemoryFile;
    try {
      file = this.readFile(filePath);
    } catch (err) {
      if (err instanceof MemoryCorruptError) {
        return { status: 'corrupt', filePath, error: err.message };
      }
      throw err;
    }

    const identity = this.ensureIdentity(file, { deferPersist: true });
    const memory = this.toReadResult(file, identity);
    return { status: 'ok', filePath, memory };
  }

  /**
   * Write a memory entry (legacy signature).
   *
   * An empty `tags` array preserves the existing tags; use
   * `writeWithResult` for the tri-state semantics (`undefined` keeps,
   * `[]` clears, a non-empty array replaces).
   */
  write(
    folder: string,
    key: string,
    content: string,
    tags: string[] = [],
    options: WriteOptions = {},
  ): string {
    const effectiveTags = tags && tags.length > 0 ? tags : undefined;
    return this.writeWithResult(folder, key, content, effectiveTags, options).filePath;
  }

  /**
   * Write a memory entry and return its identity.
   *
   * `tags` follows the tri-state contract: `undefined` keeps the current
   * tags, `[]` clears them and a non-empty array replaces them.
   */
  writeWithResult(
    folder: string,
    key: string,
    content: string,
    tags?: string[],
    options: WriteOptions = {},
  ): MemoryWriteResult {
    const safeFolder = sanitizeFolder(folder);
    if (!safeFolder) throw new Error(`Invalid folder path: ${JSON.stringify(folder)}`);
    folder = safeFolder;
    const normalizedContent = content.replace(/\r\n/g, '\n').replace(/^\n+/, '');
    const safeKey = sanitizeKey(key);
    assertValidKey(safeKey);
    const targetPath = this.findExistingFile(folder, key) ?? this.resolveFilePath(folder, safeKey);

    // Never replace a symbolic link or a path outside the store.
    if (fs.existsSync(targetPath)) {
      assertSafeExistingFile(targetPath, this.realStoreRoot() ?? undefined);
    }

    let existing: MemoryFile | null = null;
    if (fs.existsSync(targetPath)) {
      existing = this.readFile(targetPath);
    }

    const current = existing
      ? this.ensureIdentity(existing)
      : { id: this.generateMemoryId(), revision: 0, contentHash: '' };

    if (options.expectedRevision !== undefined) {
      if (options.expectedRevision !== current.revision) {
        throw new RevisionConflictError({
          expectedRevision: options.expectedRevision,
          currentRevision: current.revision,
          currentContentHash: current.contentHash,
          key: safeKey,
          folder,
        });
      }
      if (
        options.expectedContentHash !== undefined &&
        options.expectedContentHash !== current.contentHash
      ) {
        throw new RevisionConflictError({
          expectedRevision: options.expectedRevision,
          currentRevision: current.revision,
          currentContentHash: current.contentHash,
          key: safeKey,
          folder,
        });
      }
    }

    const now = new Date().toISOString();
    const id = current.id;
    const revision = current.revision + 1;
    const contentHash = hashContent(normalizedContent);
    const title =
      options.title ||
      (typeof existing?.frontmatter.title === 'string' && existing.frontmatter.title
        ? existing.frontmatter.title
        : this.toTitle(safeKey));

    const frontmatter: Frontmatter = {
      ...(existing?.frontmatter ?? {}),
      schemaVersion: 1,
      id,
      key: safeKey,
      title,
      tags: this.resolveTags(tags, existing),
      createdAt:
        typeof existing?.frontmatter.createdAt === 'string' && existing.frontmatter.createdAt
          ? existing.frontmatter.createdAt
          : now,
      updatedAt: now,
      revision,
      contentHash,
    };

    // Governance metadata, all tri-state (undefined keeps the current value).
    if (options.sourceRefs !== undefined) {
      frontmatter.sourceRefs = options.sourceRefs;
    }
    if (options.supersedes !== undefined) {
      frontmatter.supersedes = options.supersedes;
    }
    if (options.sensitivity !== undefined) {
      if (!['public', 'workspace', 'private'].includes(options.sensitivity)) {
        throw new Error(
          `Invalid sensitivity: ${JSON.stringify(options.sensitivity)} (expected public | workspace | private)`,
        );
      }
      frontmatter.sensitivity = options.sensitivity;
    }

    frontmatter.metadataHash = hashMetadata(frontmatter);
    atomicWriteFile(targetPath, stringifyFrontmatter(frontmatter) + normalizedContent, 'utf8');
    this.rememberIdentity(targetPath, { id, revision, contentHash });

    return {
      filePath: targetPath,
      key: safeKey,
      folder,
      id,
      revision,
      contentHash,
      title,
      created: !existing,
    };
  }

  /**
   * Delete a memory entry.
   *
   * The entry is soft deleted: the file moves into `trash/` (mirroring its
   * original relative path) so it can be restored with `restoreWithResult`.
   * Theme references are marked `deleted` by the callers.
   */
  delete(folder: string, key: string): boolean {
    return this.deleteWithResult(folder, key) !== null;
  }

  /** Delete a memory entry and report the identity that was removed. */
  deleteWithResult(folder: string, key: string): MemoryDeleteResult | null {
    const filePath = this.findExistingFile(folder, key);
    if (!filePath) return null;

    assertSafeExistingFile(filePath, this.realStoreRoot() ?? undefined);

    let identity: MemoryIdentity | null = null;
    try {
      const file = this.readFile(filePath);
      identity = this.ensureIdentity(file);
    } catch {
      identity = null;
    }

    const trashPath = this.moveToTrash(filePath);
    this.identityCache.delete(filePath);

    return {
      filePath,
      key: sanitizeKey(key),
      folder,
      id: identity?.id ?? '',
      revision: identity?.revision ?? 0,
      contentHash: identity?.contentHash ?? '',
      trashPath,
    };
  }

  /**
   * Move a memory file into the trash, mirroring its store-relative path.
   *
   * The trash copy gains `deleted` / `deletedAt` / `deletedFrom` frontmatter
   * fields; unparseable files are moved byte-for-byte instead of being lost.
   */
  private moveToTrash(filePath: string): string {
    const relative = path.relative(this.storeRoot, filePath).replace(/\\/g, '/');
    const parsedRelative = path.parse(relative);
    const trashName = `${parsedRelative.name}.deleted-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}${parsedRelative.ext}`;
    const trashPath = path.join(this.storeRoot, 'trash', parsedRelative.dir, trashName);
    fs.mkdirSync(path.dirname(trashPath), { recursive: true });

    let moved = false;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = parseFrontmatter(raw);
      if (parsed) {
        const fm: Frontmatter = {
          ...parsed.frontmatter,
          deletedAt: new Date().toISOString(),
          deletedFrom: relative,
        };
        fm.metadataHash = hashMetadata(fm);
        atomicWriteFile(trashPath, stringifyFrontmatter(fm) + parsed.body, 'utf8');
        moved = true;
      }
    } catch {
      // Fall through to the byte-for-byte move.
    }

    if (moved) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        // The trash copy exists; removing the original failed. Never lose the
        // original silently — surface the error instead.
        try {
          fs.unlinkSync(trashPath);
        } catch {
          /* ignore */
        }
        throw err;
      }
    } else {
      fs.renameSync(filePath, trashPath);
    }
    return trashPath;
  }

  /**
   * Restore the most recent trash copy of a memory entry.
   *
   * The stable id and revision are preserved; the `deleted*` frontmatter
   * fields are removed. Returns `null` when no trash copy exists.
   */
  restoreWithResult(folder: string, key: string): MemoryRestoreResult | null {
    const safeKey = sanitizeKey(key);
    const targetPath = this.resolveFilePath(folder, safeKey);
    const relative = path.relative(this.storeRoot, targetPath).replace(/\\/g, '/');
    let legacyRelative: string | null = null;
    try {
      const legacy = this.resolveLegacyFilePath(folder, safeKey);
      legacyRelative = path.relative(this.storeRoot, legacy).replace(/\\/g, '/');
    } catch {
      legacyRelative = null;
    }
    const candidates = this.listTrash().filter(
      (entry) =>
        entry.deletedFrom === relative ||
        (legacyRelative !== null && entry.deletedFrom === legacyRelative),
    );
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const aDeleted = Date.parse(a.deletedAt ?? '') || 0;
      const bDeleted = Date.parse(b.deletedAt ?? '') || 0;
      if (aDeleted !== bDeleted) return aDeleted - bDeleted;
      try {
        const aMtime = fs.statSync(a.trashPath, { bigint: true }).mtimeNs;
        const bMtime = fs.statSync(b.trashPath, { bigint: true }).mtimeNs;
        if (aMtime !== bMtime) return aMtime < bMtime ? -1 : 1;
      } catch {
        // Fall back to the path for an unreadable copy.
      }
      return a.trashPath < b.trashPath ? -1 : a.trashPath > b.trashPath ? 1 : 0;
    });
    const trashPath = candidates[candidates.length - 1].trashPath;

    if (fs.existsSync(targetPath)) {
      throw new Error(`Cannot restore ${folder}/${safeKey}: destination already exists`);
    }

    const file = this.readFile(trashPath);
    const identity = this.ensureIdentity(file);
    const now = new Date().toISOString();

    const fm: Frontmatter = { ...file.frontmatter };
    delete (fm as Record<string, unknown>).deleted;
    delete (fm as Record<string, unknown>).deletedAt;
    delete (fm as Record<string, unknown>).deletedFrom;

    const restored: Frontmatter = {
      ...fm,
      schemaVersion: typeof fm.schemaVersion === 'number' ? fm.schemaVersion : 1,
      key: safeKey,
      id: identity.id,
      revision: identity.revision,
      contentHash: identity.contentHash,
      updatedAt: now,
    };
    restored.metadataHash = hashMetadata(restored);

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    atomicWriteFile(targetPath, stringifyFrontmatter(restored) + file.body, 'utf8');
    try {
      faultPoint('restore.before-trash-unlink');
      fs.unlinkSync(trashPath);
    } catch (err) {
      // Roll back the restored target: leaving both the restored copy and
      // the trash copy alive means two files share one stable id, and any
      // later restore attempt fails with "destination already exists"
      // (review P2 #2).
      try {
        fs.unlinkSync(targetPath);
        this.identityCache.delete(targetPath);
      } catch (rollbackErr) {
        throw new Error(
          `Restore failed: the trash copy could not be removed (${String(err)}) and the ` +
            `restored target could not be rolled back (${String(rollbackErr)}). Two files now share ` +
            `the same id — remove the trash copy manually before restoring again.`,
        );
      }
      throw new Error(
        `Restore failed, the restored target was rolled back: the trash copy could not be removed (${String(err)})`,
      );
    }
    this.identityCache.delete(trashPath);
    this.rememberIdentity(targetPath, identity);

    return {
      filePath: targetPath,
      trashPath,
      key: safeKey,
      folder,
      id: identity.id,
      revision: identity.revision,
      contentHash: identity.contentHash,
      title:
        typeof file.frontmatter.title === 'string' && file.frontmatter.title
          ? file.frontmatter.title
          : this.toTitle(safeKey),
    };
  }

  /**
   * List every entry currently in the trash, oldest deletion first.
   */
  listTrash(): TrashEntry[] {
    const trashRoot = path.join(this.storeRoot, 'trash');
    if (!fs.existsSync(trashRoot)) return [];
    const entries: TrashEntry[] = [];

    const walk = (dir: string): void => {
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          walk(fullPath);
          continue;
        }
        if (!item.isFile() || !item.name.endsWith('.md')) continue;
        const relative = path.relative(this.storeRoot, fullPath).replace(/\\/g, '/');
        let deletedAt: string | null = null;
        let deletedFrom: string | null = null;
        let id: string | null = null;
        try {
          const parsed = parseFrontmatter(fs.readFileSync(fullPath, 'utf8'));
          const fm = parsed?.frontmatter ?? {};
          if (typeof fm.deletedAt === 'string') deletedAt = fm.deletedAt;
          if (typeof fm.deletedFrom === 'string') deletedFrom = fm.deletedFrom;
          if (typeof fm.id === 'string' && fm.id) id = fm.id;
        } catch {
          // Unparseable trash copy: report it with the path it was found at.
        }
        const originalRelative =
          deletedFrom ??
          relative
            .replace(/^trash\//, '')
            .replace(/\.deleted-[0-9a-z]+-[0-9a-f]{12}\.md$/, '.md');
        entries.push({
          deletedFrom: originalRelative,
          trashPath: fullPath,
          key: path.basename(originalRelative, '.md'),
          folder: path.dirname(originalRelative),
          id,
          deletedAt,
        });
      }
    };
    walk(trashRoot);

    return entries.sort((a, b) => (a.deletedAt ?? '') < (b.deletedAt ?? '') ? -1 : 1);
  }

  /** Move (and optionally rename) a memory entry. */
  move(oldFolder: string, oldKey: string, toFolder: string, newKey?: string): string {
    return this.moveWithResult(oldFolder, oldKey, toFolder, newKey).filePath;
  }

  /**
   * Move (and optionally rename) a memory entry.
   *
   * The stable `id` is preserved; only the path cache (frontmatter key) and
   * the location change.
   */
  moveWithResult(
    oldFolder: string,
    oldKey: string,
    toFolder: string,
    newKey?: string,
  ): MemoryMoveResult {
    const sourcePath = this.findExistingFile(oldFolder, oldKey);
    if (!sourcePath) {
      throw new Error(`Source memory not found: ${oldFolder}/${oldKey}`);
    }

    const finalKey = sanitizeKey(newKey || oldKey);
    assertValidKey(finalKey);
    const destPath = this.resolveFilePath(toFolder, finalKey);
    if (fs.existsSync(destPath)) {
      throw new Error(`Destination already exists: ${toFolder}/${finalKey}`);
    }

    const file = this.readFile(sourcePath);
    const identity = this.ensureIdentity(file);
    const now = new Date().toISOString();

    const frontmatter: Frontmatter = {
      ...file.frontmatter,
      schemaVersion: typeof file.frontmatter.schemaVersion === 'number' ? file.frontmatter.schemaVersion : 1,
      key: finalKey,
      updatedAt: now,
      id: identity.id,
      revision: identity.revision,
      contentHash: identity.contentHash,
    };
    frontmatter.metadataHash = hashMetadata(frontmatter);

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    atomicWriteFile(destPath, stringifyFrontmatter(frontmatter) + file.body, 'utf8');

    // From here on, ANY failure must roll the destination back: two files
    // sharing one stable id would corrupt the identity contract. This
    // includes the fault-injection checkpoint below.
    try {
      faultPoint('move.before-unlink-source');

      // Removing the source is what makes this a move instead of a copy. If
      // it fails (Windows file locks are the usual cause) short retries ride
      // out transient locks.
      let sourceRemoved = false;
      let lastUnlinkError: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          fs.unlinkSync(sourcePath);
          sourceRemoved = true;
          break;
        } catch (err) {
          lastUnlinkError = err;
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            // Already gone: the move is complete.
            sourceRemoved = true;
            break;
          }
          if (attempt < 2) {
            // Synchronous pause between retries (absorbs transient Windows
            // file locks). Atomics.wait throws on worker threads — the retry
            // is best effort and must never mask the rollback below.
            try {
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
            } catch {
              /* no synchronous sleep available on this thread */
            }
          }
        }
      }

      if (!sourceRemoved) {
        throw new Error(`the source could not be removed: ${String(lastUnlinkError)}`);
      }
    } catch (err) {
      try {
        fs.unlinkSync(destPath);
        this.identityCache.delete(destPath);
      } catch (rollbackErr) {
        throw new Error(
          `Move failed: ${err instanceof Error ? err.message : String(err)} — and the ` +
            `destination could not be rolled back (${String(rollbackErr)}). Two files now share the ` +
            `same id — run sync_workspace_index and inspect with scanIdentities before writing again.`,
        );
      }
      throw new Error(
        `Move failed, the destination was rolled back: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    this.identityCache.delete(sourcePath);
    this.rememberIdentity(destPath, identity);

    return {
      filePath: destPath,
      previousPath: sourcePath,
      key: finalKey,
      folder: toFolder,
      title:
        typeof file.frontmatter.title === 'string' && file.frontmatter.title
          ? file.frontmatter.title
          : this.toTitle(finalKey),
      id: identity.id,
      revision: identity.revision,
      contentHash: identity.contentHash,
    };
  }

  /**
   * Make sure the memory file carries an up-to-date identity.
   *
   * Missing identity fields are backfilled once and persisted. When the body
   * changed outside of this service the revision is bumped so that optimistic
   * concurrency checks cannot be bypassed.
   */
  syncIdentity(
    folder: string,
    key: string,
  ): {
    exists: boolean;
    changed: boolean;
    filePath?: string;
    identity: MemoryIdentity | null;
  } {
    const filePath = this.findExistingFile(folder, key);
    if (!filePath) return { exists: false, changed: false, identity: null };

    const stats = fs.statSync(filePath);
    const cached = this.identityCache.get(filePath);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) {
      return { exists: true, changed: false, filePath, identity: cached.identity };
    }

    const file = this.readFile(filePath);
    const identity = this.ensureIdentity(file);
    return {
      exists: true,
      changed: identity.changed,
      filePath,
      identity: {
        id: identity.id,
        revision: identity.revision,
        contentHash: identity.contentHash,
      },
    };
  }

  /**
   * Report identity information for every memory file.
   *
   * Used for diagnostics: duplicate ids are reported but never merged.
   */
  scanIdentities(): {
    filePath: string;
    id: string;
    revision: number;
    contentHash: string;
    duplicateId: boolean;
  }[] {
    const results: {
      filePath: string;
      id: string;
      revision: number;
      contentHash: string;
      duplicateId: boolean;
    }[] = [];

    for (const filePath of this.listMarkdownFiles(path.join(this.storeRoot, 'memory'))) {
      try {
        const file = this.readFile(filePath);
        const identity = this.ensureIdentity(file);
        results.push({
          filePath,
          id: identity.id,
          revision: identity.revision,
          contentHash: identity.contentHash,
          duplicateId: false,
        });
      } catch {
        /* corrupt files are skipped and reported by the reconciler */
      }
    }

    const counts = new Map<string, number>();
    for (const entry of results) {
      counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    }
    for (const entry of results) {
      entry.duplicateId = (counts.get(entry.id) ?? 0) > 1;
    }
    return results;
  }

  /**
   * Parse a memory file and make sure its identity metadata is up to date.
   *
   * Returns `null` when the file is missing or cannot be parsed. When the
   * body changed outside of this service the revision is bumped and the
   * change is persisted. Pass `assignIdentity: false` to inspect a file
   * without giving it a stable id (used for derived files such as the
   * workspace essence).
   */
  inspectFile(
    filePath: string,
    options: { assignIdentity?: boolean } = {},
  ): {
    frontmatter: Frontmatter;
    body: string;
    identity: MemoryIdentity;
    changed: boolean;
    revisionBumped: boolean;
  } | null {
    let file: MemoryFile;
    try {
      file = this.readFile(filePath);
    } catch {
      return null;
    }

    if (options.assignIdentity === false) {
      const computed = this.computeIdentity(file);
      return {
        frontmatter: file.frontmatter,
        body: file.body,
        identity: {
          id: computed.id ?? '',
          revision: computed.revision,
          contentHash: computed.contentHash,
        },
        changed: false,
        revisionBumped: false,
      };
    }

    const identity = this.ensureIdentity(file);
    return {
      frontmatter: file.frontmatter,
      body: file.body,
      identity: {
        id: identity.id,
        revision: identity.revision,
        contentHash: identity.contentHash,
      },
      changed: identity.changed,
      revisionBumped: identity.revisionBumped,
    };
  }

  listMarkdownFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...this.listMarkdownFiles(full));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(full);
      }
    }
    return results;
  }

  toTitle(key: string): string {
    return toTitleUtil(key);
  }

  /** Generate a new random memory id. */
  generateMemoryId(): string {
    return `mem_${crypto.randomBytes(12).toString('hex')}`;
  }

  private generateBackfillId(filePath: string): string {
    const normalized = path.resolve(filePath).replace(/\\/g, '/');
    const idInput = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    return `mem_${crypto.createHash('sha256').update(idInput).digest('hex').slice(0, 24)}`;
  }

  /** Real path of the store root, used for the symlink escape checks. */
  private realStoreRoot(): string | null {
    try {
      return fs.realpathSync(this.storeRoot);
    } catch {
      return null;
    }
  }

  private resolveTags(tags: string[] | undefined, existing: MemoryFile | null): string[] {
    if (tags === undefined) {
      const current = existing?.frontmatter.tags;
      return Array.isArray(current) ? current.map((tag) => String(tag)) : [];
    }
    return tags.map((tag) => String(tag));
  }

  private readFile(filePath: string): MemoryFile {
    // Reject symbolic links and paths that leave the store. This lowers the
    // risk of accidental symlink escapes; it cannot stop a hostile process
    // that swaps files between the check and the read.
    const realRoot = this.realStoreRoot();
    if (realRoot && safeRealpath(filePath, realRoot) === null) {
      throw new MemoryCorruptError(
        filePath,
        new Error('file is a symbolic link or resolves outside the store'),
      );
    }

    let text: string;
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new MemoryCorruptError(filePath, err);
    }

    try {
      const parsed = parseFrontmatter(text);
      if (!parsed) {
        return { filePath, frontmatter: {}, body: text.replace(/\r\n/g, '\n') };
      }
      return { filePath, frontmatter: parsed.frontmatter, body: parsed.body };
    } catch (err) {
      if (err instanceof FrontmatterParseError) {
        throw new MemoryCorruptError(filePath, err);
      }
      throw err;
    }
  }

  /**
   * Compute the identity of a memory file without touching the disk.
   *
   * `id` is `null` when the file does not carry a stable id yet.
   */
  private computeIdentity(file: MemoryFile): {
    id: string | null;
    revision: number;
    contentHash: string;
    changed: boolean;
    revisionBumped: boolean;
  } {
    const frontmatter = file.frontmatter;
    const contentHash = hashContent(file.body);
    const storedHash = typeof frontmatter.contentHash === 'string' ? frontmatter.contentHash : null;
    const metadataHash = hashMetadata(frontmatter);
    const storedMetadataHash =
      typeof frontmatter.metadataHash === 'string' ? frontmatter.metadataHash : null;
    const metadataChanged = storedMetadataHash !== null && storedMetadataHash !== metadataHash;
    const storedRevision =
      typeof frontmatter.revision === 'number' && Number.isFinite(frontmatter.revision)
        ? frontmatter.revision
        : null;
    const storedId =
      typeof frontmatter.id === 'string' && frontmatter.id.trim() ? frontmatter.id : null;

    let revision: number;
    let changed = false;
    let revisionBumped = false;

    if (storedHash === null) {
      revision = storedRevision ?? 1;
      changed = true;
    } else if (storedHash !== contentHash || metadataChanged) {
      revision = (storedRevision ?? 0) + 1;
      changed = true;
      revisionBumped = true;
    } else {
      revision = storedRevision ?? 1;
      if (storedRevision === null) changed = true;
    }
    if (storedMetadataHash === null) changed = true;

    return { id: storedId, revision, contentHash, changed, revisionBumped };
  }

  /**
   * Compute the identity of a memory file and persist it when it is missing
   * or stale (external edit).
   */
  private ensureIdentity(
    file: MemoryFile,
    options: { deferPersist?: boolean } = {},
  ): MemoryIdentity & { changed: boolean; revisionBumped: boolean } {
    const computed = this.computeIdentity(file);
    const id = computed.id ?? this.generateBackfillId(file.filePath);
    const changed = computed.changed || computed.id === null;
    const identity: MemoryIdentity = {
      id,
      revision: computed.revision,
      contentHash: computed.contentHash,
    };

    if (changed) {
      this.rememberIdentity(file.filePath, identity);
      if (options.deferPersist) {
        // Read paths never write on their own behalf: the backfill is
        // scheduled under the workspace lock so it cannot race a concurrent
        // remember (the review finding R-01).
        this.scheduleIdentityPersist(file.filePath);
      } else if (!this.persistIdentity(file, identity)) {
        metrics.increment('identity_persist_failed');
      }
    } else {
      this.rememberIdentity(file.filePath, identity);
    }

    return { ...identity, changed, revisionBumped: computed.revisionBumped };
  }

  /** File paths whose deferred identity backfill is already queued. */
  private persistScheduled = new Set<string>();
  /** Scheduled backfill tasks, awaitable via `flushIdentityPersists`. */
  private persistTasks = new Set<Promise<void>>();

  /**
   * Await every pending deferred identity backfill. Used by tests and by
   * graceful shutdown paths that must not leave backfills unscheduled.
   */
  async flushIdentityPersists(): Promise<void> {
    while (this.persistTasks.size > 0) {
      await Promise.allSettled([...this.persistTasks]);
    }
  }

  /**
   * Persist a pending identity backfill under the workspace lock.
   *
   * The file is re-read inside the lock: a concurrent writer may have
   * rewritten it (or already persisted a fresh identity) while we waited —
   * in that case its state wins and nothing is written.
   */
  private scheduleIdentityPersist(filePath: string): void {
    if (this.persistScheduled.has(filePath)) return;
    this.persistScheduled.add(filePath);
    const task = Promise.resolve()
      .then(() =>
        this.lock.withLock(WORKSPACE_LOCK_KEY, async () => {
          this.persistScheduled.delete(filePath);
          let fresh: MemoryFile;
          try {
            fresh = this.readFile(filePath);
          } catch {
            return;
          }
          const computed = this.computeIdentity(fresh);
          if (!computed.changed) {
            this.rememberIdentity(filePath, {
              id: computed.id ?? this.generateBackfillId(filePath),
              revision: computed.revision,
              contentHash: computed.contentHash,
            });
            return;
          }
          const identity: MemoryIdentity = {
            id: computed.id ?? this.generateBackfillId(filePath),
            revision: computed.revision,
            contentHash: computed.contentHash,
          };
          if (!this.persistIdentity(fresh, identity)) {
            metrics.increment('identity_persist_failed');
          }
        }),
      )
      .catch(() => {
        this.persistScheduled.delete(filePath);
        metrics.increment('identity_persist_failed');
      });
    this.persistTasks.add(task);
    void task.finally(() => this.persistTasks.delete(task));
  }

  /**
   * Persist the identity back to disk.
   *
   * The write is guarded by a compare-and-swap on the body hash so that a
   * concurrent writer is never overwritten silently.
   */
  private persistIdentity(file: MemoryFile, identity: MemoryIdentity): boolean {
    let currentText: string;
    try {
      currentText = fs.readFileSync(file.filePath, 'utf8');
    } catch {
      return false;
    }

    let currentBody: string;
    let currentFrontmatter: Frontmatter;
    try {
      const parsed = parseFrontmatter(currentText);
      currentFrontmatter = parsed?.frontmatter ?? {};
      currentBody = parsed ? parsed.body : currentText.replace(/\r\n/g, '\n');
    } catch {
      return false;
    }

    if (hashContent(currentBody) !== identity.contentHash) {
      // The file changed while we were reading it: let the other writer win.
      return false;
    }

    const current = this.computeIdentity({
      ...file,
      frontmatter: currentFrontmatter,
      body: currentBody,
    });
    identity.id = current.id ?? identity.id;
    identity.revision = Math.max(identity.revision, current.revision);

    const key =
      typeof currentFrontmatter.key === 'string' && currentFrontmatter.key
        ? currentFrontmatter.key
        : path.basename(file.filePath, '.md');
    const now = new Date().toISOString();

    const nextFrontmatter: Frontmatter = {
      ...currentFrontmatter,
      id: identity.id,
      key,
      title:
        typeof currentFrontmatter.title === 'string' && currentFrontmatter.title
          ? currentFrontmatter.title
          : this.toTitle(key),
      tags: Array.isArray(currentFrontmatter.tags)
        ? currentFrontmatter.tags.map((tag) => String(tag))
        : [],
      createdAt:
        typeof currentFrontmatter.createdAt === 'string' && currentFrontmatter.createdAt
          ? currentFrontmatter.createdAt
          : now,
      updatedAt: now,
      revision: identity.revision,
      contentHash: identity.contentHash,
    };
    nextFrontmatter.metadataHash = hashMetadata(nextFrontmatter);

    try {
      atomicWriteFile(file.filePath, stringifyFrontmatter(nextFrontmatter) + currentBody, 'utf8');
    } catch {
      return false;
    }

    this.rememberIdentity(file.filePath, identity);
    return true;
  }

  private rememberIdentity(filePath: string, identity: MemoryIdentity): void {
    try {
      const stats = fs.statSync(filePath);
      this.identityCache.set(filePath, {
        mtimeMs: stats.mtimeMs,
        size: stats.size,
        identity,
      });
    } catch {
      this.identityCache.delete(filePath);
    }
  }

  private toReadResult(file: MemoryFile, identity: MemoryIdentity): MemoryReadResult {
    const frontmatter = file.frontmatter;
    const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags.map((tag) => String(tag)) : [];

    return {
      ...frontmatter,
      content: file.body,
      filePath: file.filePath,
      tags,
      title: typeof frontmatter.title === 'string' ? frontmatter.title : undefined,
      createdAt: typeof frontmatter.createdAt === 'string' ? frontmatter.createdAt : undefined,
      updatedAt: typeof frontmatter.updatedAt === 'string' ? frontmatter.updatedAt : undefined,
      id: identity.id,
      revision: identity.revision,
      contentHash: identity.contentHash,
    };
  }
}
