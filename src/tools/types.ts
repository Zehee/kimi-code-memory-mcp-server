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
  handler: (args: unknown) => ToolResult | Promise<ToolResult>;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function adaptHandler<TArgs>(
  handler: (args: TArgs) => ToolResult | Promise<ToolResult>,
): (args: unknown) => ToolResult | Promise<ToolResult> {
  return handler as unknown as (args: unknown) => ToolResult | Promise<ToolResult>;
}
