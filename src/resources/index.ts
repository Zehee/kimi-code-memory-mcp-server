/**
 * MCP Resources for the Kimi Code Memory server.
 *
 * Resources expose workspace memory files, themes, and the workspace essence
 * as addressable URIs that clients can read through the MCP protocol.
 */

import fs from 'fs';
import path from 'path';
import type { Resource, TextResourceContents } from '@modelcontextprotocol/sdk/types.js';
import type { Ctx } from '../types.js';

export interface ResourceProvider {
  resources: () => Resource[];
  readResource: (uri: string) => { contents: TextResourceContents[] };
}

export function createResources(ctx: Ctx): ResourceProvider {
  function listMemoryResources(): Resource[] {
    const refs = ctx.indexDao.listRefs().filter((ref) => ref.folder.startsWith('memory/'));
    return refs.map((ref) => ({
      uri: `memory://${ref.folder}/${ref.key}`,
      name: ref.title || ref.key,
      mimeType: 'text/markdown',
      description: `Memory in ${ref.folder}${ref.tags.length ? ` (tags: ${ref.tags.join(', ')})` : ''}`,
    }));
  }

  function listThemeResources(): Resource[] {
    return ctx.themeManager.listThemes().map((theme) => ({
      uri: `theme://${theme}`,
      name: theme,
      mimeType: 'text/markdown',
      description: `Theme association summary for "${theme}"`,
    }));
  }

  function listEssenceResource(): Resource[] {
    const essencePath = path.join(ctx.storeRoot, 'essence', 'essence.md');
    if (!fs.existsSync(essencePath)) return [];
    return [
      {
        uri: 'essence://essence',
        name: 'Workspace Essence',
        mimeType: 'text/markdown',
        description: 'Condensed workspace essence derived from memory.',
      },
    ];
  }

  function resources(): Resource[] {
    return [...listMemoryResources(), ...listThemeResources(), ...listEssenceResource()];
  }

  function readMemoryResource(uri: string, folder: string, key: string): TextResourceContents[] {
    const result = ctx.memoryStore.read(folder, key);
    if (!result) {
      throw new Error(`Memory resource not found: ${uri}`);
    }
    return [
      {
        uri,
        mimeType: 'text/markdown',
        text: result.content,
      },
    ];
  }

  function readThemeResource(uri: string, theme: string): TextResourceContents[] {
    const association = ctx.themeManager.loadTheme(theme);
    if (!association) {
      throw new Error(`Theme resource not found: ${uri}`);
    }

    const lines: string[] = [
      `# Theme: ${association.displayName || association.theme}`,
      '',
      `- Created: ${association.createdAt}`,
      `- Updated: ${association.updatedAt}`,
      `- Memories: ${association.memories.length}`,
      `- Turns: ${association.turns.length}`,
      '',
      '## Memories',
    ];

    if (association.memories.length === 0) {
      lines.push('_No memories associated yet._');
    } else {
      for (const memory of association.memories) {
        lines.push(`- ${memory.folder}/${memory.key} (${memory.title})`);
      }
    }

    lines.push('', '## Turns');
    if (association.turns.length === 0) {
      lines.push('_No turns associated yet._');
    } else {
      for (const turn of association.turns) {
        lines.push(`- Session ${turn.sessionId}, turn ${turn.turnId} (${turn.timestamp})`);
      }
    }

    return [
      {
        uri,
        mimeType: 'text/markdown',
        text: lines.join('\n'),
      },
    ];
  }

  function readEssenceResource(uri: string): TextResourceContents[] {
    const essencePath = path.join(ctx.storeRoot, 'essence', 'essence.md');
    if (!fs.existsSync(essencePath)) {
      throw new Error(`Essence resource not found: ${uri}`);
    }
    return [
      {
        uri,
        mimeType: 'text/markdown',
        text: fs.readFileSync(essencePath, 'utf8'),
      },
    ];
  }

  function readResource(uri: string): { contents: TextResourceContents[] } {
    if (uri.startsWith('memory://')) {
      const rest = uri.slice('memory://'.length);
      const lastSlash = rest.lastIndexOf('/');
      if (lastSlash <= 0) {
        throw new Error(`Invalid memory resource URI: ${uri}`);
      }
      const folder = rest.slice(0, lastSlash);
      const key = rest.slice(lastSlash + 1);
      return { contents: readMemoryResource(uri, folder, key) };
    }

    if (uri.startsWith('theme://')) {
      const theme = uri.slice('theme://'.length);
      if (!theme) {
        throw new Error(`Invalid theme resource URI: ${uri}`);
      }
      return { contents: readThemeResource(uri, theme) };
    }

    if (uri === 'essence://essence') {
      return { contents: readEssenceResource(uri) };
    }

    throw new Error(`Unsupported resource URI scheme: ${uri}`);
  }

  return { resources, readResource };
}
