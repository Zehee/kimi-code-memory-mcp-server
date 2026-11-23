/**
 * Theme association storage (theme -> turns / memories).
 *
 * Memory references keep the stable memory id so that a moved or renamed
 * memory can still be resolved. The path (`folder` + `key`) is only a
 * rebuildable location cache. References to memories that no longer exist
 * are marked `deleted` or `orphaned` instead of silently pointing at a stale
 * path.
 */

import fs from 'fs';
import path from 'path';
import { assertValidKey, sanitizeKey, toTitle } from './utils/validation.js';
import { Mutex } from './utils/mutex.js';
import { atomicWriteFile } from './utils/paths.js';
import { WorkspaceLock, WORKSPACE_LOCK_KEY } from './utils/workspace-lock.js';
import { metrics } from './utils/metrics.js';
import { CorruptDataError, UnsupportedVersionError } from './utils/errors.js';

/** Schema version stamped into every newly written theme file. */
export const THEME_SCHEMA_VERSION = 1;

export interface ThemeTurnRef {
  sessionId: string;
  turnId: number;
  timestamp: string;
}

export type ThemeMemoryStatus = 'active' | 'deleted' | 'orphaned';

export interface ThemeMemoryRef {
  key: string;
  folder: string;
  title: string;
  timestamp: string;
  /** Stable id of the referenced memory (absent for legacy references). */
  memoryId?: string;
  /** Lifecycle state of the reference. */
  status?: ThemeMemoryStatus;
  /** Revision of the referenced memory when the reference was written. */
  revision?: number;
  /** Content hash of the referenced memory when the reference was written. */
  contentHash?: string;
}

export interface ThemeAssociation {
  theme: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  turns: ThemeTurnRef[];
  memories: ThemeMemoryRef[];
  /** Stamped by this version on save; legacy files are migrated on next save. */
  schemaVersion?: number;
}

export interface ThemeRefInput {
  sessionId?: string;
  turnId?: number;
  timestamp?: string;
  memoryKey?: string;
  folder?: string;
  title?: string;
  memoryId?: string;
  status?: ThemeMemoryStatus;
  revision?: number;
  contentHash?: string;
}

export interface ThemeMemoryPatch {
  memoryId?: string;
  key?: string;
  folder?: string;
  title?: string;
  revision?: number;
  contentHash?: string;
  status?: ThemeMemoryStatus;
  /** Previous location, used to update legacy references without an id. */
  previousFolder?: string;
  previousKey?: string;
}

export class ThemeManager {
  themesRoot: string;
  lockRoot: string;
  private mutex: Mutex;
  private lock: WorkspaceLock;
  /** Theme files whose schema is newer than this binary: never overwritten. */
  private unsupportedThemes = new Set<string>();

  constructor(themesRoot: string, options: { lockRoot?: string } = {}) {
    this.themesRoot = themesRoot;
    this.lockRoot = options.lockRoot ?? path.resolve(themesRoot, '..', '.locks');
    this.mutex = new Mutex();
    this.lock = new WorkspaceLock(this.lockRoot);
  }

  themeFilePath(theme: string): string {
    return path.join(this.themesRoot, `${sanitizeKey(theme)}.json`);
  }

  loadTheme(theme: string): ThemeAssociation | null {
    const filePath = this.themeFilePath(theme);
    if (!fs.existsSync(filePath)) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (err) {
      throw new CorruptDataError(
        `theme file ${path.basename(filePath)}`,
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new CorruptDataError(`theme file ${path.basename(filePath)}`, 'root must be an object');
    }
    const association = parsed as Partial<ThemeAssociation>;
    if (
      typeof association.schemaVersion === 'number' &&
      association.schemaVersion > THEME_SCHEMA_VERSION
    ) {
      this.unsupportedThemes.add(filePath);
      metrics.increment('unsupported_version_theme');
      return null;
    }
    if (
      typeof association.theme !== 'string' ||
      !Array.isArray(association.turns) ||
      !Array.isArray(association.memories) ||
      association.turns.some(
        (ref) =>
          !ref ||
          typeof ref !== 'object' ||
          typeof ref.sessionId !== 'string' ||
          typeof ref.turnId !== 'number',
      ) ||
      association.memories.some(
        (ref) =>
          !ref ||
          typeof ref !== 'object' ||
          typeof ref.folder !== 'string' ||
          typeof ref.key !== 'string',
      )
    ) {
      throw new CorruptDataError(
        `theme file ${path.basename(filePath)}`,
        'invalid theme, turns or memories structure',
      );
    }
    return association as ThemeAssociation;
  }

  saveTheme(theme: string, association: ThemeAssociation): void {
    const filePath = this.themeFilePath(theme);
    assertValidKey(path.basename(filePath, '.json'));
    if (this.unsupportedThemes.has(filePath)) {
      throw new UnsupportedVersionError(
        `theme file ${path.basename(filePath)}`,
        'newer schema',
        `schemaVersion <= ${THEME_SCHEMA_VERSION}`,
      );
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteFile(
      filePath,
      JSON.stringify({ ...association, schemaVersion: THEME_SCHEMA_VERSION }, null, 2),
      'utf8',
    );
  }

  deleteTheme(theme: string): boolean {
    const filePath = this.themeFilePath(theme);
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  }

  listThemes(): string[] {
    if (!fs.existsSync(this.themesRoot)) return [];
    return fs
      .readdirSync(this.themesRoot)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.basename(name, '.json'))
      .sort();
  }

  /**
   * Attach a turn or a memory to a theme.
   *
   * The read-modify-write cycle is protected by the workspace lock so that
   * concurrent processes cannot lose associations.
   */
  async addThemeAssociation(theme: string, ref: ThemeRefInput): Promise<void> {
    return this.mutex.runExclusive(() =>
      this.lock.withLock(WORKSPACE_LOCK_KEY, () => {
        const safeTheme = sanitizeKey(theme);
        let association = this.loadTheme(safeTheme);
        const now = new Date().toISOString();
        if (!association) {
          association = {
            theme: safeTheme,
            displayName: theme,
            createdAt: now,
            updatedAt: now,
            turns: [],
            memories: [],
          };
        }
        if (!Array.isArray(association.turns)) association.turns = [];
        if (!Array.isArray(association.memories)) association.memories = [];

        if (ref.sessionId !== undefined && ref.turnId !== undefined) {
          const exists = association.turns.some(
            (t) => t.sessionId === ref.sessionId && t.turnId === ref.turnId,
          );
          if (!exists) {
            association.turns.push({
              sessionId: ref.sessionId,
              turnId: ref.turnId,
              timestamp: ref.timestamp || now,
            });
            association.updatedAt = now;
          }
        }

        if (ref.memoryKey && ref.folder) {
          const memId = `${ref.folder}/${ref.memoryKey}`;
          const existing =
            association.memories.find(
              (m) =>
                (ref.memoryId && m.memoryId === ref.memoryId) || `${m.folder}/${m.key}` === memId,
            ) ?? null;

          if (existing) {
            // Refresh the location cache and the identity of the reference.
            existing.key = ref.memoryKey;
            existing.folder = ref.folder;
            if (ref.title) existing.title = ref.title;
            if (ref.memoryId) existing.memoryId = ref.memoryId;
            if (ref.revision !== undefined) existing.revision = ref.revision;
            if (ref.contentHash !== undefined) existing.contentHash = ref.contentHash;
            if (ref.status) existing.status = ref.status;
            association.updatedAt = now;
          } else {
            association.memories.push({
              key: ref.memoryKey,
              folder: ref.folder,
              title: ref.title || toTitle(ref.memoryKey),
              timestamp: ref.timestamp || now,
              memoryId: ref.memoryId,
              status: ref.status ?? 'active',
              revision: ref.revision,
              contentHash: ref.contentHash,
            });
            association.updatedAt = now;
          }
        }

        this.saveTheme(safeTheme, association);
      }),
    );
  }

  /**
   * Update the location cache of a memory reference in every theme.
   *
   * Used after a move or rename: the stable id does not change, only the
   * cached path and the metadata.
   */
  async updateMemoryReferences(patch: ThemeMemoryPatch): Promise<number> {
    return this.mutex.runExclusive(() =>
      this.lock.withLock(WORKSPACE_LOCK_KEY, () => {
        let updated = 0;
        for (const theme of this.listThemes()) {
          const association = this.loadTheme(theme);
          if (!association || !Array.isArray(association.memories)) continue;

          let changed = false;
          for (const ref of association.memories) {
            if (!this.matchesMemoryRef(ref, patch)) continue;
            // A stable id that the reference did not carry yet (legacy
            // path-only references) is backfilled here.
            if (patch.memoryId !== undefined) ref.memoryId = patch.memoryId;
            if (patch.key !== undefined) ref.key = patch.key;
            if (patch.folder !== undefined) ref.folder = patch.folder;
            if (patch.title !== undefined) ref.title = patch.title;
            if (patch.revision !== undefined) ref.revision = patch.revision;
            if (patch.contentHash !== undefined) ref.contentHash = patch.contentHash;
            if (patch.status !== undefined) ref.status = patch.status;
            changed = true;
            updated++;
          }

          if (changed) {
            association.updatedAt = new Date().toISOString();
            this.saveTheme(theme, association);
          }
        }
        return updated;
      }),
    );
  }

  async updateMemoryFolderReferences(
    previousFolder: string,
    folder: string,
    options: { status?: ThemeMemoryStatus } = {},
  ): Promise<number> {
    return this.mutex.runExclusive(() =>
      this.lock.withLock(WORKSPACE_LOCK_KEY, () => {
        let updated = 0;
        const previousPrefix = `${previousFolder}/`;
        for (const theme of this.listThemes()) {
          const association = this.loadTheme(theme);
          if (!association || !Array.isArray(association.memories)) continue;

          let changed = false;
          for (const ref of association.memories) {
            if (ref.folder !== previousFolder && !ref.folder.startsWith(previousPrefix)) continue;
            ref.folder = `${folder}${ref.folder.slice(previousFolder.length)}`;
            if (options.status !== undefined) ref.status = options.status;
            changed = true;
            updated++;
          }

          if (changed) {
            association.updatedAt = new Date().toISOString();
            this.saveTheme(theme, association);
          }
        }
        return updated;
      }),
    );
  }

  /** Mark every reference to a memory as deleted (the memory file is gone). */
  async markMemoryDeleted(
    memoryId: string,
    location?: { folder?: string; key?: string },
  ): Promise<number> {
    return this.updateMemoryReferences({
      memoryId,
      previousFolder: location?.folder,
      previousKey: location?.key,
      status: 'deleted',
    });
  }

  /** Mark every reference to a memory as orphaned (the target cannot be found). */
  async markMemoryOrphaned(memoryId: string): Promise<number> {
    return this.updateMemoryReferences({ memoryId, status: 'orphaned' });
  }

  /**
   * Reconcile reference LOCATIONS by stable id.
   *
   * A crash between the move of a memory file and its theme update leaves
   * references pointing at the old path while the memory exists at the new
   * one. This method aligns every reference that carries a known stable id
   * with the actual location (folder/key/title/revision/hash) and clears a
   * stale `orphaned` status when the memory exists again.
   */
  async updateMemoryReferenceLocations(
    locations: Map<
      string,
      { folder: string; key: string; title?: string; revision?: number; contentHash?: string }
    >,
  ): Promise<number> {
    return this.mutex.runExclusive(() =>
      this.lock.withLock(WORKSPACE_LOCK_KEY, () => {
        let updated = 0;
        for (const theme of this.listThemes()) {
          const association = this.loadTheme(theme);
          if (!association || !Array.isArray(association.memories)) continue;

          let changed = false;
          for (const ref of association.memories) {
            if (!ref.memoryId) continue;
            const location = locations.get(ref.memoryId);
            if (!location) continue;
            if (
              ref.folder === location.folder &&
              ref.key === location.key &&
              ref.status === 'active' &&
              ref.title === (location.title ?? ref.title)
            ) {
              continue;
            }
            ref.folder = location.folder;
            ref.key = location.key;
            if (location.title !== undefined) ref.title = location.title;
            if (location.revision !== undefined) ref.revision = location.revision;
            if (location.contentHash !== undefined) ref.contentHash = location.contentHash;
            ref.status = 'active';
            changed = true;
            updated++;
          }

          if (changed) {
            association.updatedAt = new Date().toISOString();
            this.saveTheme(theme, association);
          }
        }
        return updated;
      }),
    );
  }

  /**
   * Reconcile the references with the memories that currently exist.
   *
   * Active references with a stable id whose memory no longer exists are
   * marked `orphaned`; references whose memory exists again become `active`.
   * Explicitly deleted references stay deleted while the memory is absent.
   * Legacy references without an id are left untouched because their target
   * cannot be identified reliably.
   */
  async markOrphanedReferences(existingIds: Iterable<string>): Promise<number> {
    const existing = new Set(existingIds);
    return this.mutex.runExclusive(() =>
      this.lock.withLock(WORKSPACE_LOCK_KEY, () => {
        let updated = 0;
        for (const theme of this.listThemes()) {
          const association = this.loadTheme(theme);
          if (!association || !Array.isArray(association.memories)) continue;

          let changed = false;
          for (const ref of association.memories) {
            if (!ref.memoryId) continue;
            if (existing.has(ref.memoryId)) {
              if (ref.status === 'orphaned' || ref.status === 'deleted') {
                ref.status = 'active';
                changed = true;
              }
              continue;
            }
            if (ref.status === 'deleted') continue;
            if (ref.status !== 'orphaned') {
              ref.status = 'orphaned';
              changed = true;
              updated++;
            }
          }

          if (changed) {
            association.updatedAt = new Date().toISOString();
            this.saveTheme(theme, association);
          }
        }
        return updated;
      }),
    );
  }

  private matchesMemoryRef(ref: ThemeMemoryRef, patch: ThemeMemoryPatch): boolean {
    if (patch.memoryId && ref.memoryId) {
      return ref.memoryId === patch.memoryId;
    }
    if (patch.previousFolder !== undefined && patch.previousKey !== undefined) {
      return ref.folder === patch.previousFolder && ref.key === patch.previousKey;
    }
    if (patch.memoryId) {
      // The reference has no id: fall back to the location cache.
      return (
        patch.folder !== undefined &&
        patch.key !== undefined &&
        ref.folder === patch.folder &&
        ref.key === patch.key
      );
    }
    return false;
  }
}
