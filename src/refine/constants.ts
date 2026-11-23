/**
 * Constants for the turn refinement layer.
 */

/** Action / conclusion keywords in both English and Chinese. */
export const ACTION_KEYWORDS = [
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
export const CATEGORY_HEADINGS: Record<string, string[]> = {
  focus: ['Current Focus', '当前任务', '当前聚焦', 'Focus'],
  completed: ['Completed', 'Done', '已完成', '完成'],
  next: ['Next Steps', 'Next', '下一步', '后续'],
  blockers: ['Blockers', 'Blocked', '阻塞', '阻塞项', 'Blocked by'],
  status: ['Status', '当前状态', '状态'],
  summary: ['Summary', '总结', '摘要'],
  decisions: ['Decisions', '决定', '决策'],
  notes: ['Notes', '备注', 'Note'],
};

/**
 * SQLite schema version of the refined database.
 *
 * Version history:
 *   1 — initial `refined_turns` table (no freshness metadata);
 *   2 — freshness columns (`extractor_version`, `source_*`, `refined_at`) plus
 *       the `refined_session_progress` table.
 *
 * Migrations are driven by `PRAGMA user_version` and run inside a transaction.
 */
export const REFINED_SCHEMA_VERSION = 2;

/** Version of the deterministic turn extractor that produced a row. */
export const EXTRACTOR_VERSION = '1';

/**
 * Sentinel used for rows whose source identity is unknown (legacy rows, or
 * rows written before incremental indexing existed). Such rows must never be
 * presented as fresh.
 */
export const FRESHNESS_UNKNOWN = 'unknown';

/** Sentinel used for rows whose source is known to be out of date. */
export const FRESHNESS_STALE = 'stale';

/** Busy timeout applied to every SQLite connection (milliseconds). */
export const SQLITE_BUSY_TIMEOUT_MS = 1000;

/** Safety bound on rows pulled from SQLite in a single refined search. */
export const REFINED_MAX_SCAN_ROWS = 50000;

/** Slicing limits used during extraction and search. */
export const LIMITS = {
  /** Max length of the user text snippet included in the summary. */
  userText: 200,
  /** Max length of the agent lead sentence included in the summary. */
  agentLead: 120,
  /** Max number of extracted facts stored per turn. */
  facts: 8,
  /** Max number of fallback notes stored per turn. */
  notes: 8,
  /** Max number of file entities stored per turn. */
  files: 10,
  /** Max number of tool entities stored per turn. */
  tools: 10,
  /** Max number of error entities stored per turn. */
  errors: 5,
  /** Max length of a single error snippet. */
  errorSnippet: 200,
  /** Default max number of search matches returned. */
  searchResultLimit: 100,
  /** Multiplier used to fetch extra candidates before ranking search results. */
  searchCandidateMultiplier: 4,
};

/** Helpers for ISO date boundary formatting used in SQL queries. */
export const DATE_FORMAT = {
  dayStart: (date: string): string => `${date}T00:00:00.000Z`,
  dayEnd: (date: string): string => `${date}T23:59:59.999Z`,
};
