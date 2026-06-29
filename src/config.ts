/**
 * Global configuration.
 *
 * The store root can be overridden via the MEMORY_STORE_ROOT environment
 * variable. When unset, it defaults to ~/.kimi-code-memory/ so that the
 * server behaves like a user-level tool even when installed as a package.
 */

import os from 'os';
import path from 'path';

export const homedir = os.homedir();

export function getStoreRoot(): string {
  const envRoot = process.env.MEMORY_STORE_ROOT;
  if (envRoot) {
    if (envRoot.includes('\0')) {
      throw new Error('MEMORY_STORE_ROOT contains invalid null byte');
    }
    const resolved = path.resolve(envRoot);
    if (!path.isAbsolute(resolved)) {
      throw new Error(`MEMORY_STORE_ROOT must resolve to an absolute path: ${envRoot}`);
    }
    return resolved;
  }
  return path.join(homedir, '.kimi-code-memory');
}

/**
 * Resolve the directory where Kimi Code CLI session wires are stored.
 *
 * Priority:
 * 1. MEMORY_SESSIONS_ROOT environment variable (absolute path)
 * 2. KIMI_CODE_HOME environment variable (<KIMI_CODE_HOME>/sessions)
 * 3. Default ~/.kimi-code/sessions
 */
export function getSessionsRoot(): string {
  if (process.env.MEMORY_SESSIONS_ROOT) {
    const resolved = path.resolve(process.env.MEMORY_SESSIONS_ROOT);
    if (!path.isAbsolute(resolved)) {
      throw new Error(`MEMORY_SESSIONS_ROOT must resolve to an absolute path: ${process.env.MEMORY_SESSIONS_ROOT}`);
    }
    return resolved;
  }
  if (process.env.KIMI_CODE_HOME) {
    return path.join(path.resolve(process.env.KIMI_CODE_HOME), 'sessions');
  }
  return path.join(homedir, '.kimi-code', 'sessions');
}

export interface ContextWindow {
  detailedRounds: number;
  defaultSummaryRounds: number;
  loadMoreChunkSize: number;
}

export const DEFAULT_CONTEXT_WINDOW: ContextWindow = {
  detailedRounds: 3,
  defaultSummaryRounds: 2,
  loadMoreChunkSize: 5,
};

export const DEFAULT_RECENT_CHANGE_LIMIT = 5;

export const ESSENCE_SIZE_LIMIT = 15 * 1024; // 15 KB

/**
 * search_context 用于把相邻 turn 聚成「簇」的默认时间间隔（秒）。
 *
 * 「簇」是指一小段连续的来回对话，通常围绕同一个决策或讨论展开。
 * 如果两个相邻 turn 的时间间隔超过这个值，就认为它们属于不同的簇。
 *
 * 90 秒适合典型的 agent-user 对话：既能区分开不同话题，又足以保留
 * 一段流畅讨论的完整性。每次搜索可以通过 cluster_gap_seconds 参数覆盖。
 */
export const DEFAULT_CLUSTER_GAP_SECONDS = 90;

/**
 * search_context 默认输出预算（字符数）。
 *
 * 默认的 normal 模式会尽量把输出控制在这个范围内，避免一次搜索就占满
 * 上下文窗口。可通过 max_output_chars 参数覆盖，detail: 'full' 时禁用。
 */
export const DEFAULT_SEARCH_OUTPUT_BUDGET = 6000;

/** search_context 匹配项摘要最大长度。 */
export const SEARCH_SNIPPET_MAX_LEN = 240;

/** search_context normal 模式匹配项 user 文本最大长度。 */
export const SEARCH_USER_MAX_LEN = 200;

/** search_context normal 模式匹配项 agent 文本最大长度。 */
export const SEARCH_AGENT_MAX_LEN = 400;
