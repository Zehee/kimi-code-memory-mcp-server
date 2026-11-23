import type { Ctx } from '../types.js';
import { SearchViewRepository } from './search-view-repository.js';

export interface DeleteSearchViewResult {
  key: string;
  deletedRefinedTurns: number;
  skippedSharedRefinedTurns: number;
  skippedSharedRefinedTurnRefs: string[];
}

export async function deleteSearchView(
  ctx: Pick<Ctx, 'storeRoot' | 'themeManager' | 'refinedManager' | 'memoryStore'>,
  key: string,
  deleteRefinedTurns = false,
): Promise<DeleteSearchViewResult> {
  // The reference check, the view deletion and the refined cascade are one
  // logical transaction: hold the workspace lock so a concurrent search view
  // save or refined write cannot slip between them.
  return ctx.memoryStore.withWorkspaceLock(async () => {
    const repository = new SearchViewRepository(ctx.storeRoot);
    const view = repository.load(key);
    const referenced = new Map<string, { sessionId: string; turnId: number }>();

    for (const cluster of view.clusters) {
      for (const member of cluster.members) {
        referenced.set(`${member.sessionId}:${member.turnId}`, {
          sessionId: member.sessionId,
          turnId: member.turnId,
        });
      }
    }

    const shared = new Set<string>();
    if (deleteRefinedTurns) {
      for (const id of repository.collectReferencedTurns(view.key).keys()) {
        shared.add(id);
      }
      for (const themeName of ctx.themeManager.listThemes()) {
        const theme = ctx.themeManager.loadTheme(themeName);
        for (const turn of theme?.turns ?? []) {
          shared.add(`${turn.sessionId}:${turn.turnId}`);
        }
      }
    }

    const deletable = deleteRefinedTurns
      ? [...referenced.entries()].filter(([id]) => !shared.has(id)).map(([, ref]) => ref)
      : [];
    const skippedSharedRefinedTurnRefs = deleteRefinedTurns
      ? [...referenced.keys()].filter((id) => shared.has(id))
      : [];

    repository.delete(view.key);
    const deletedRefinedTurns =
      deletable.length > 0 ? await ctx.refinedManager.deleteRefinedTurns(deletable) : 0;

    return {
      key: view.key,
      deletedRefinedTurns,
      skippedSharedRefinedTurns: skippedSharedRefinedTurnRefs.length,
      skippedSharedRefinedTurnRefs,
    };
  });
}
