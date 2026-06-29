/**
 * Shared entity extraction from action/tool records.
 *
 * Used by the turn refiner and the wire-context summarizer to collect files,
 * tool names, and error snippets without duplicating the logic.
 */

import { LIMITS } from '../refine/constants.js';
import type { RawAction } from '../refine/types.js';

export interface ExtractedEntities {
  files: string[];
  tools: string[];
  errors: string[];
}

/**
 * Read files/tools/errors from a RawAction.
 */
export function extractEntitiesFromAction(action: RawAction): ExtractedEntities {
  const files: string[] = [];
  const tools: string[] = [];
  const errors: string[] = [];

  if (action.name) tools.push(action.name);

  const args =
    typeof action.args === 'object' && action.args !== null
      ? (action.args as Record<string, unknown>)
      : {};
  for (const key of ['path', 'file', 'filePath', 'cwd'] as const) {
    const value = args[key];
    if (typeof value === 'string') {
      if (key === 'cwd' && value.includes('node_modules')) continue;
      files.push(value);
    }
  }

  const result = action.result || '';
  if (
    typeof result === 'string' &&
    (result.toLowerCase().includes('error') || result.toLowerCase().includes('failed'))
  ) {
    errors.push(result.split('\n')[0].slice(0, LIMITS.errorSnippet));
  }

  return { files, tools, errors };
}
