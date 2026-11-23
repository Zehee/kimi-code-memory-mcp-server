/** WS4: what one malformed theme file does to consumers that iterate all themes. */
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { pathToFileURL } from 'node:url';
const REPO = 'D:/workspace/kimi-code-memory-mcp-server/src';
const imp = (rel: string) => import(pathToFileURL(path.join(REPO, rel)).href);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ws4-'));
process.env.MEMORY_STORE_ROOT = path.join(tmp, 'store'); process.env.MEMORY_SESSIONS_ROOT = tmp;
const { MemoryStore } = await imp('dao/memory-store.ts');
const { IndexDao } = await imp('dao/index.ts');
const { ThemeManager } = await imp('theme-manager.ts');
const { getThemes, getThemeTimeline } = await imp('vis/api.ts');
const storeRoot = path.join(tmp, 'store');
const themes = new ThemeManager(path.join(storeRoot, 'themes'));
themes.saveTheme('good', { theme: 'good', displayName: 'Good', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', turns: [], memories: [] });
fs.writeFileSync(path.join(storeRoot, 'themes', 'zz-malformed.json'), JSON.stringify({ theme: 'zz-malformed', displayName: 'Malformed', createdAt: '', updatedAt: '', turns: 'oops', memories: [] }));
const ctx: any = { cwd: storeRoot, workspaceId: 'ws', storeRoot, indexDao: new IndexDao(storeRoot), memoryStore: new MemoryStore(storeRoot), themeManager: themes, refinedManager: {} };
async function attempt(label: string, fn: () => unknown | Promise<unknown>) {
  try { const r: any = await fn(); console.log(`  ${label}: ok -> ${Array.isArray(r) ? r.map((t: any) => t.name).join(',') : String(r).slice(0, 110)}`); }
  catch (e: any) { console.log(`  ${label}: THROWS ${e.name} (http ${e.statusCode}): ${String(e.message).slice(0, 80)}`); }
}
console.log('=== consumers with one malformed theme file present ===');
console.log(`  themes on disk: ${themes.listThemes().join(', ')}`);
await attempt('GET /api/themes (list all)                 ', () => getThemes(ctx));
await attempt('GET /api/themes/good                      ', () => `turns=${getThemeTimeline(ctx, 'good').turns?.length}`);
await attempt('GET /api/themes/zz-malformed              ', () => getThemeTimeline(ctx, 'zz-malformed'));
await attempt('reconcileIndex                            ', async () => { const o: any = await ctx.indexDao.reconcileIndex(); return `synced=${o.synced} skipped=${o.skipped} errors=${JSON.stringify(o.errors).slice(0, 90)}`; });
await attempt('reconcileIndex again (persistence check)  ', async () => { const o: any = await ctx.indexDao.reconcileIndex(); return `synced=${o.synced} skipped=${o.skipped} errors=${o.errors.length}`; });
await attempt('tag good                                 ', () => themes.addThemeAssociation('good', { sessionId: 's', turnId: 1 }).then(() => 'appended'));
await attempt('tag zz-malformed                         ', () => themes.addThemeAssociation('zz-malformed', { sessionId: 's', turnId: 1 }).then(() => 'appended'));
console.log(`  malformed file still byte-identical (not replaced by a blank association): ${fs.readFileSync(path.join(storeRoot, 'themes', 'zz-malformed.json'), 'utf8').includes('"turns":"oops"')}`);
await attempt('DELETE zz-malformed                       ', () => themes.deleteTheme('zz-malformed'));
fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
