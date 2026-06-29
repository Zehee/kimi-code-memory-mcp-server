/**
 * Pure renderer: turns a TreeNode data structure into an ASCII memory index tree.
 *
 * This module performs no file I/O; callers are responsible for building the
 * TreeNode (including timestamps used for `[new]` markers).
 */

export interface TreeFile {
  key: string;
  title: string;
  tags: string[];
  updatedAt?: string;
  createdAt?: string;
}

export interface TreeNode {
  name: string;
  comment: string;
  children: Map<string, TreeNode>;
  files: TreeFile[];
}

export class MemoryIndexTreeRenderer {
  render(root: TreeNode, recentLimit = 5): string {
    const timeEntries: { fullPath: string; updatedAt: string; createdAt: string }[] = [];

    const collectTimes = (node: TreeNode, nodePath: string): void => {
      for (const file of node.files) {
        timeEntries.push({
          fullPath: `${nodePath}/${file.key}`,
          updatedAt: file.updatedAt || '',
          createdAt: file.createdAt || '',
        });
      }
      for (const [name, child] of node.children.entries()) {
        collectTimes(child, `${nodePath}/${name}`);
      }
    };

    collectTimes(root, root.name);

    const recentKeys = new Set(
      timeEntries
        .sort((a, b) => {
          const aUpdated = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
          const bUpdated = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
          if (bUpdated !== aUpdated) return bUpdated - aUpdated;
          const aCreated = a.createdAt ? new Date(a.createdAt).getTime() : 0;
          const bCreated = b.createdAt ? new Date(b.createdAt).getTime() : 0;
          return bCreated - aCreated;
        })
        .slice(0, recentLimit)
        .map((e) => e.fullPath),
    );

    const renderNode = (
      node: TreeNode,
      nodePath: string,
      prefix = '',
      isLast = true,
      isRoot = false,
    ): string[] => {
      const lines: string[] = [];
      const comment = node.comment;
      if (isRoot) {
        lines.push(`${node.name}/${comment ? ` — ${comment}` : ''}`);
      } else {
        const connector = prefix === '' ? '' : isLast ? '└── ' : '├── ';
        lines.push(`${prefix}${connector}${node.name}/${comment ? ` — ${comment}` : ''}`);
      }

      const childEntries = Array.from(node.children.entries()).sort((a, b) =>
        a[0].localeCompare(b[0]),
      );
      const allFiles = [...node.files].sort((a, b) => a.key.localeCompare(b.key));
      const items: (
        | { type: 'folder'; name: string; data: TreeNode }
        | { type: 'file'; name: string; data: TreeFile }
      )[] = [
        ...childEntries.map(([name, childNode]) => ({
          type: 'folder' as const,
          name,
          data: childNode,
        })),
        ...allFiles.map((file) => ({ type: 'file' as const, name: file.key, data: file })),
      ];

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const isLastItem = i === items.length - 1;
        const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');
        if (item.type === 'folder') {
          lines.push(
            ...renderNode(item.data, `${nodePath}/${item.name}`, childPrefix, isLastItem, false),
          );
        } else {
          const file = item.data;
          const fileConnector = isLastItem ? '└── ' : '├── ';
          const tagStr = file.tags.length > 0 ? ` [${file.tags.join(', ')}]` : '';
          const newMark = recentKeys.has(`${nodePath}/${file.key}`) ? ' [new]' : '';
          lines.push(
            `${childPrefix}${fileConnector}${file.key} — ${file.title}${tagStr}${newMark}`,
          );
        }
      }

      return lines;
    };

    return renderNode(root, root.name, '', true, true).join('\n');
  }
}
