/**
 * Shared tool types.
 */

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * `signal` is the MCP request's abort signal (undefined when the host does
   * not provide one). Long-running handlers should check it at loop
   * boundaries and return a partial result instead of ignoring cancellation.
   */
  handler: (args: unknown, signal?: AbortSignal) => ToolResult | Promise<ToolResult>;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function adaptHandler<TArgs>(
  handler: (args: TArgs, signal?: AbortSignal) => ToolResult | Promise<ToolResult>,
): (args: unknown, signal?: AbortSignal) => ToolResult | Promise<ToolResult> {
  return handler as unknown as (args: unknown, signal?: AbortSignal) => ToolResult | Promise<ToolResult>;
}
