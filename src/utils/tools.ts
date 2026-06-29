/**
 * Shared tool helpers.
 */

import type { ToolResult } from '../tools/types.js';

export function toolResult(data: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError,
  };
}
