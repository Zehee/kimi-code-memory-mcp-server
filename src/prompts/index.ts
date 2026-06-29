/**
 * MCP Prompts for the Kimi Code Memory server.
 *
 * Prompts provide reusable instruction templates that clients can fetch
 * before asking the model to perform memory-aware tasks.
 */

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptDefinition {
  name: string;
  description: string;
  arguments?: PromptArgument[];
}

export const prompts: PromptDefinition[] = [
  {
    name: 'memory-decision-check',
    description: 'Before modifying a file, check historical decisions related to it.',
    arguments: [
      {
        name: 'filePath',
        description: 'Path of the file you are about to modify.',
        required: false,
      },
    ],
  },
  {
    name: 'memory-theme-trace',
    description: 'Trace the evolution of a theme across sessions.',
    arguments: [
      {
        name: 'theme',
        description: 'Theme identifier to trace.',
        required: false,
      },
    ],
  },
  {
    name: 'memory-session-summary',
    description: 'Summarize the current session and suggest themes to tag.',
  },
];

export function getPrompt(
  name: string,
  args: Record<string, string> = {},
): { messages: Array<{ role: 'user' | 'assistant'; content: { type: 'text'; text: string } }> } {
  switch (name) {
    case 'memory-decision-check': {
      const filePath = args.filePath || '<file-path>';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `I am about to modify ${filePath}. Before I make any changes, please check our historical decisions and rules related to this file or feature.`,
            },
          },
          {
            role: 'assistant',
            content: {
              type: 'text',
              text: `I'll search the workspace memory for decisions, rules, and knowledge related to ${filePath}. If relevant themes exist, I'll trace their evolution across sessions before you edit.`,
            },
          },
        ],
      };
    }
    case 'memory-theme-trace': {
      const theme = args.theme || '<theme>';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please trace the evolution of the "${theme}" theme across sessions and memories.`,
            },
          },
          {
            role: 'assistant',
            content: {
              type: 'text',
              text: `I'll look up the "${theme}" theme, list its associated memories and refined turns, and summarize how it evolved over time.`,
            },
          },
        ],
      };
    }
    case 'memory-session-summary': {
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: 'Please summarize the current session and suggest any themes worth tagging for future traceability.',
            },
          },
          {
            role: 'assistant',
            content: {
              type: 'text',
              text: "I'll review the current session's turns, extract key decisions and open questions, and propose themes that connect this session to related work.",
            },
          },
        ],
      };
    }
    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
