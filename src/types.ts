/**
 * Shared context and argument types used across tools.
 */

import type { IndexDao } from './dao/index.js';
import type { MemoryStore } from './dao/memory-store.js';
import type { ThemeManager } from './theme-manager.js';
import type { RefinedManager } from './refined-manager.js';

export interface Ctx {
  cwd: string;
  workspaceId: string;
  storeRoot: string;
  indexDao: IndexDao;
  memoryStore: MemoryStore;
  themeManager: ThemeManager;
  refinedManager: RefinedManager;
}

export interface RememberArgs {
  key: string;
  content?: string;
  folder?: string;
  tags?: unknown[];
  themes?: unknown[];
}

export interface RecallArgs {
  key: string;
  folder?: string;
}

export interface ListArgs {
  folder?: string;
  limit?: number;
  tag?: string;
}

export interface SearchArgs {
  query: string;
  folder?: string;
}

export interface DeleteArgs {
  key: string;
  folder?: string;
}

export interface MoveArgs {
  key: string;
  folder?: string;
  toFolder: string;
  newKey?: string;
}

export interface LoadWorkspaceContextArgs {
  detailed_rounds?: number;
  summary_rounds?: number;
}

export interface LoadMoreContextArgs {
  before_turn_id?: number;
  limit?: number;
}

export interface SearchContextArgs {
  query: string;
  date_from?: string;
  date_to?: string;
  limit?: number;
  cluster_gap_seconds?: number;
  max_cluster_size?: number;
  detail?: 'compact' | 'normal' | 'full';
  max_output_chars?: number;
}

export interface ListSearchViewsArgs {
  limit?: number;
}

export interface LoadTurnContextArgs {
  references: unknown[];
}

export interface TagThemeArgs {
  theme: string;
  sessionId?: string;
  turnId?: number;
  memoryKey?: string;
  memoryFolder?: string;
  memoryTitle?: string;
}

export interface TraceThemeArgs {
  theme: string;
  includeTurnContent?: boolean;
}

export interface RefineSessionTurnsArgs {
  sessionId?: string;
  session_id?: string;
  turnIds?: unknown[];
  limit?: number;
}

export interface OrganizeArgs {
  content?: string;
  sources?: unknown[];
}

export interface SyncWorkspaceIndexArgs {
  folderComments?: Record<string, string>;
}
