/**
 * Tool registry: schemas and dispatch.
 */

import type { Ctx } from '../types.js';
import type { ToolDefinition, ToolResult } from './types.js';
import { toolResult } from '../utils/tools.js';
import { createMemoryTools } from './memory-tools.js';
import { createContextTools } from './context-tools.js';
import { createThemeTools } from './theme-tools.js';
import { createSystemTools } from './system-tools.js';

export function createTools(ctx: Ctx) {
  const tools: ToolDefinition[] = [
    ...createMemoryTools(ctx),
    ...createContextTools(ctx),
    ...createThemeTools(ctx),
    ...createSystemTools(ctx),
  ];

  const toolSchemas = tools.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));

  const handlers = Object.fromEntries(
    tools.map((tool) => [tool.name, tool.handler]),
  ) as Record<string, (args: unknown) => ToolResult | Promise<ToolResult>>;

  async function dispatch(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const handler = handlers[name];
    if (!handler) {
      return toolResult({ error: `Unknown tool: ${name}` }, true);
    }
    try {
      return await handler(args);
    } catch (err) {
      return toolResult(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
        true,
      );
    }
  }

  return { toolSchemas, dispatch };
}
