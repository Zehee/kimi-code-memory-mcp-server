/**
 * Theme association storage (theme -> turns / memories).
 */

import fs from 'fs';
import path from 'path';
import { sanitizeKey, toTitle } from './utils/validation.js';

export interface ThemeTurnRef {
  sessionId: string;
  turnId: number;
  timestamp: string;
}

export interface ThemeMemoryRef {
  key: string;
  folder: string;
  title: string;
  timestamp: string;
}

export interface ThemeAssociation {
  theme: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  turns: ThemeTurnRef[];
  memories: ThemeMemoryRef[];
}

export interface ThemeRefInput {
  sessionId?: string;
  turnId?: number;
  timestamp?: string;
  memoryKey?: string;
  folder?: string;
  title?: string;
}

export class ThemeManager {
  themesRoot: string;

  constructor(themesRoot: string) {
    this.themesRoot = themesRoot;
  }

  themeFilePath(theme: string): string {
    return path.join(this.themesRoot, `${sanitizeKey(theme)}.json`);
  }

  loadTheme(theme: string): ThemeAssociation | null {
    const filePath = this.themeFilePath(theme);
    if (!fs.existsSync(filePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8')) as ThemeAssociation;
    } catch {
      return null;
    }
  }

  saveTheme(theme: string, association: ThemeAssociation): void {
    const filePath = this.themeFilePath(theme);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = filePath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(association, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  }

  listThemes(): string[] {
    if (!fs.existsSync(this.themesRoot)) return [];
    return fs
      .readdirSync(this.themesRoot)
      .filter((name) => name.endsWith('.json'))
      .map((name) => path.basename(name, '.json'))
      .sort();
  }

  addThemeAssociation(theme: string, ref: ThemeRefInput): void {
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
      const exists = association.memories.some((m) => `${m.folder}/${m.key}` === memId);
      if (!exists) {
        association.memories.push({
          key: ref.memoryKey,
          folder: ref.folder,
          title: ref.title || toTitle(ref.memoryKey),
          timestamp: ref.timestamp || now,
        });
        association.updatedAt = now;
      }
    }

    this.saveTheme(safeTheme, association);
  }
}
