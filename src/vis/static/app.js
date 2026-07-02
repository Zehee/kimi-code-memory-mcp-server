import { state, LS_KEY_AUTO_VIS } from './state.js';
import {
  formatDate,
  escapeHtml,
  iconKimiMemory,
  iconPanelLeftClose,
  iconPanelLeftOpen,
  setStatus,
  getInitialCollapsed,
  updateCollapsedClass,
  toggleSidebar,
  toggleMobileSidebar,
  sectionFor,
  workspaceFolderName,
  updateDocumentTitle,
} from './utils/helpers.js';
import { renderMarkdown } from './utils/markdown.js';
import {
  api,
  listMemoryFolders,
  writeMemory,
  deleteMemoryFile,
  createMemoryFolder,
  renameMemoryFolder,
  deleteMemoryFolder,
  deleteThemeApi,
  deleteSearchViewApi,
} from './api.js';

const sections = [
  { id: 'workspace', label: 'Workspace', icon: '◈' },
  { id: 'themes', label: 'Themes', icon: '◉' },
  { id: 'searches', label: 'Searches', icon: '🔍' },
  { id: 'decisions', label: 'Decisions', icon: '◆' },
  { id: 'memories', label: 'Memories', icon: '▣' },
  { id: 'settings', label: 'Settings', icon: '⚙' },
];

const navGroups = [
  {
    label: 'Workspace',
    items: [{ id: 'workspace', label: 'Workspace', icon: '◈' }],
  },
  {
    label: 'Analysis',
    items: [
      { id: 'themes', label: 'Themes', icon: '◉' },
      { id: 'searches', label: 'Searches', icon: '🔍' },
    ],
  },
  {
    label: 'Memory',
    items: [
      { id: 'decisions', label: 'Decisions', icon: '◆' },
      { id: 'memories', label: 'Memories', icon: '▣' },
    ],
  },
  {
    label: 'System',
    items: [{ id: 'settings', label: 'Settings', icon: '⚙' }],
  },
];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

function setHash(view, theme) {
  const hash = theme ? `#${view}/${encodeURIComponent(theme)}` : `#${view}`;
  if (location.hash !== hash) {
    history.pushState(null, '', hash);
  }
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '');
  if (!raw) return { view: 'workspace', theme: null };
  if (raw.startsWith('themes/')) {
    return { view: 'theme-detail', theme: decodeURIComponent(raw.slice(7)) };
  }
  if (raw.startsWith('searches/')) {
    return { view: 'search-detail', key: decodeURIComponent(raw.slice(9)) };
  }
  const known = ['workspace', 'themes', 'searches', 'decisions', 'memories', 'settings', 'theme-detail'];
  if (known.includes(raw)) return { view: raw, theme: null };
  return { view: 'workspace', theme: null };
}

function applyHash() {
  const { view, theme, key } = parseHash();
  state.currentView = view;
  const newKey = key || null;
  if (view === 'search-detail' && newKey !== state.currentSearchKey) {
    state.data.searchDetail = null;
  }
  state.currentSearchKey = newKey;
  if (view === 'theme-detail') {
    if (theme !== state.currentTheme) {
      state.data.themeDetail = null;
    }
    state.currentTheme = theme;
  } else {
    state.currentTheme = theme;
  }
  state.sidebarOpenMobile = false;
  $('#sidebar').classList.remove('open');
  renderAll();
  loadDataForView(view, theme, key);
}

function renderAll() {
  renderSidebarCollapsedTop();
  renderSidebarHeader();
  renderSidebar();
  renderTopbar();
  renderContent();
}

function renderSidebarCollapsedTop() {
  const expandIcon = iconPanelLeftOpen();
  $('#sidebarCollapsedTop').innerHTML = `
    <button class="sidebar-toggle-btn" id="sidebarExpandBtn" type="button" aria-label="Expand sidebar">
      ${expandIcon}
    </button>
  `;
  $('#sidebarExpandBtn')?.addEventListener('click', toggleSidebar);
}

function renderSidebarHeader() {
  const toggleIcon = state.sidebarCollapsed ? iconPanelLeftOpen() : iconPanelLeftClose();
  $('#sidebarHeader').innerHTML = `
    <a class="brand" href="#workspace" title="Kimi Memory">
      ${iconKimiMemory()}
      <span>Kimi Memory</span>
    </a>
    <button class="sidebar-toggle-btn" id="sidebarToggleBtn" type="button" aria-label="Toggle sidebar">
      ${toggleIcon}
    </button>
  `;

  $('#sidebarToggleBtn').addEventListener('click', toggleSidebar);
}

function renderSidebar() {
  const currentSection = sectionFor(state.currentView);
  const currentView = state.currentView;

  $('#sidebarNav').innerHTML = navGroups
    .map((group) => {
      const itemsHtml = group.items
        .map(
          (item) => `
          <a class="nav-item ${item.id === currentView ? 'active' : ''}" href="#${item.id}" data-view="${escapeHtml(
            item.id,
          )}">
            <span class="nav-icon">${escapeHtml(item.icon)}</span>
            <span>${escapeHtml(item.label)}</span>
          </a>
        `,
        )
        .join('');
      const isGroupActive = group.items.some((item) => item.id === currentSection || item.id === currentView);
      return `
        <div class="nav-group" style="${isGroupActive ? '' : 'opacity:0.7'}">
          <div class="nav-group-label">${escapeHtml(group.label)}</div>
          ${itemsHtml}
        </div>
      `;
    })
    .join('');

  $('#sidebarNav').querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      const view = el.dataset.view;
      setHash(view);
      applyHash();
    });
  });

  const workspaceId = state.data.workspace?.id || '–';
  $('#sidebarFooter').textContent = workspaceId;
}

function renderBreadcrumb() {
  const parts = [{ label: workspaceFolderName(), hash: '#workspace' }];
  if (state.currentView === 'themes' || state.currentView === 'theme-detail') {
    parts.push({ label: 'Themes', hash: '#themes' });
  }

  if (state.currentView === 'theme-detail' && state.currentTheme) {
    const displayName = state.data.themeDetail?.displayName || state.currentTheme;
    parts.push({ label: displayName, hash: null });
  } else if (state.currentView === 'decisions') {
    parts.push({ label: 'Decisions', hash: null });
  } else if (state.currentView === 'memories') {
    parts.push({ label: 'Memories', hash: null });
  } else if (state.currentView === 'settings') {
    parts.push({ label: 'Settings', hash: null });
  } else if (state.currentView === 'themes') {
    // list already handled
  }

  return parts
    .map((p, idx) => {
      const isLast = idx === parts.length - 1;
      const content = p.hash && !isLast
        ? `<a href="${p.hash}">${escapeHtml(p.label)}</a>`
        : `<span>${escapeHtml(p.label)}</span>`;
      const sep = idx > 0 ? `<span class="sep">/</span>` : '';
      return `${sep}${content}`;
    })
    .join('');
}

function renderTopbar() {
  $('#topbar').innerHTML = `
    <div class="topbar-left">
      <button class="menu-toggle" id="menuToggle" type="button" aria-label="Toggle menu">☰</button>
      <nav class="breadcrumb" id="breadcrumb">${renderBreadcrumb()}</nav>
    </div>
    <div class="topbar-right">
      <button class="btn btn-secondary btn-sm" id="syncTopbarBtn" type="button" title="Reconcile index.json with filesystem">Sync index</button>
      <button class="btn btn-secondary btn-sm" id="refreshBtn" type="button" title="Refresh current view">↻ Refresh</button>
      <span class="status-badge"><span class="status-dot"></span>Online</span>
    </div>
  `;

  $('#menuToggle').addEventListener('click', toggleMobileSidebar);
  $('#syncTopbarBtn').addEventListener('click', syncIndex);
  $('#refreshBtn').addEventListener('click', () => loadDataForView(state.currentView, state.currentTheme));
  $('#breadcrumb').querySelectorAll('a').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href) {
        location.hash = href;
        applyHash();
      }
    });
  });
}

function renderContent() {
  const content = $('#content');
  switch (state.currentView) {
    case 'workspace':
      content.innerHTML = renderWorkspaceView();
      bindWorkspaceView();
      break;
    case 'themes':
      content.innerHTML = renderThemesView();
      bindThemesView();
      break;
    case 'theme-detail':
      content.innerHTML = renderThemeDetailView();
      bindThemeDetailView();
      break;
    case 'decisions':
      content.innerHTML = renderDecisionsView();
      bindDecisionsView();
      break;
    case 'memories':
      content.innerHTML = renderMemoriesView();
      bindMemoriesView();
      break;
    case 'searches':
      content.innerHTML = renderSearchesView();
      bindSearchesView();
      break;
    case 'search-detail':
      content.innerHTML = renderSearchDetailView();
      bindSearchDetailView();
      break;
    case 'settings':
      content.innerHTML = renderSettingsView();
      bindSettingsView();
      break;
    default:
      content.innerHTML = renderWorkspaceView();
      bindWorkspaceView();
  }
}

// ---- Workspace view ----

function renderWorkspaceView() {
  const editing = state.editingEssence;
  const essence = state.data.workspace?.essence || '';
  const bodyHtml = editing
    ? `<textarea class="essence-editor" id="essenceEditor" placeholder="Workspace essence is empty. Write a short constitution here…">${escapeHtml(
        essence,
      )}</textarea>`
    : `<div class="essence-content md-content" id="essenceContent">${
        essence ? renderMarkdown(essence) : '<span class="muted">No essence yet. Click Edit to write one.</span>'
      }</div>`;
  const actionsHtml = editing
    ? `
      <button class="btn btn-primary btn-sm" id="saveEssenceBtn" type="button">Save</button>
      <button class="btn btn-secondary btn-sm" id="cancelEditEssenceBtn" type="button">Cancel</button>
    `
    : `<button class="btn btn-secondary btn-sm" id="editEssenceBtn" type="button">Edit</button>`;
  return `
    <section class="view view-active" data-view="workspace">
      <div class="page-header">
        <h1 class="page-title">Workspace</h1>
      </div>
      <div class="stat-grid" id="statsGrid"></div>
      <div class="composer-card">
        <div class="composer-header">
          <h2 class="composer-title">Workspace essence</h2>
          <div class="page-header-actions">${actionsHtml}</div>
        </div>
        <div class="composer-body">
          ${bodyHtml}
        </div>
        <div class="composer-status" id="essenceStatus"></div>
      </div>
    </section>
  `;
}

function bindWorkspaceView() {
  renderStats(state.data.workspace?.stats || {});
  $('#editEssenceBtn')?.addEventListener('click', startEditEssence);
  $('#saveEssenceBtn')?.addEventListener('click', saveEssence);
  $('#cancelEditEssenceBtn')?.addEventListener('click', cancelEditEssence);
}

function startEditEssence() {
  state.editingEssence = true;
  renderContent();
}

function cancelEditEssence() {
  state.editingEssence = false;
  renderContent();
}

function renderStats(stats) {
  const grid = $('#statsGrid');
  if (!grid) return;
  const entries = Object.entries(stats);
  if (entries.length === 0) {
    grid.innerHTML = '<div class="empty-state">Loading stats…</div>';
    return;
  }
  grid.innerHTML = entries
    .map(
      ([key, value]) => `
      <div class="stat-card">
        <div class="stat-value">${escapeHtml(String(value))}</div>
        <div class="stat-label">${escapeHtml(key.replace(/([A-Z])/g, ' $1').toLowerCase())}</div>
      </div>
    `,
    )
    .join('');
}

async function loadWorkspace() {
  const data = await api('/api/workspace');
  state.data.workspace = data;
  updateDocumentTitle();
  renderSidebar();
  if (state.currentView === 'workspace') {
    renderStats(data.stats);
    const contentEl = $('#essenceContent');
    if (contentEl && !state.editingEssence) {
      contentEl.innerHTML = data.essence ? renderMarkdown(data.essence) : '<span class="muted">No essence yet. Click Edit to write one.</span>';
    }
  }
  if (state.currentView === 'settings') {
    updateSettingsView();
  }
}

async function saveEssence() {
  const content = $('#essenceEditor').value;
  const status = $('#essenceStatus');
  try {
    await api('/api/essence', {
      method: 'POST',
      body: JSON.stringify({ content }),
    });
    if (state.data.workspace) state.data.workspace.essence = content;
    state.editingEssence = false;
    renderContent();
    setStatus(status, 'Essence saved.', 'success');
  } catch (err) {
    setStatus(status, `Save failed: ${err.message}`, 'error');
  }
}

async function syncIndex() {
  const btn = $('#syncTopbarBtn');
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = 'Syncing…';
  btn.disabled = true;
  try {
    await api('/api/sync', { method: 'POST' });
    await loadWorkspace();
    btn.textContent = 'Synced';
  } catch (err) {
    btn.textContent = `Failed: ${err.message}`;
  }
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1500);
}

// ---- Themes view ----

function renderThemesView() {
  return `
    <section class="view view-active" data-view="themes">
      <div class="page-header">
        <h1 class="page-title">Themes</h1>
        <span class="badge" id="themeCountBadge">0 themes</span>
      </div>
      <div class="search-table-wrap">
        <table class="search-table" id="themesTable">
          <thead>
            <tr>
              <th>Theme</th>
              <th>Created</th>
              <th>Updated</th>
              <th class="search-number">Turns</th>
              <th class="search-number">Memories</th>
              <th class="search-actions">Actions</th>
            </tr>
          </thead>
          <tbody id="themesTableBody"></tbody>
        </table>
      </div>
    </section>
  `;
}

function bindThemesView() {
  renderThemes();
}

function renderThemes() {
  const tbody = $('#themesTableBody');
  const badge = $('#themeCountBadge');
  if (!tbody) return;
  badge.textContent = `${state.data.themes.length} theme${state.data.themes.length === 1 ? '' : 's'}`;
  if (state.data.themes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">No themes yet.</td></tr>';
    return;
  }
  tbody.innerHTML = state.data.themes
    .map(
      (theme) => `
      <tr class="search-row theme-row" data-theme="${escapeHtml(theme.name)}">
        <td class="search-query">
          <span class="theme-icon">◆</span>
          ${escapeHtml(theme.displayName || theme.name)}
        </td>
        <td>${escapeHtml(theme.createdAt ? new Date(theme.createdAt).toLocaleString() : '-')}</td>
        <td>${escapeHtml(theme.updatedAt ? new Date(theme.updatedAt).toLocaleString() : '-')}</td>
        <td class="search-number">${theme.turnCount ?? 0}</td>
        <td class="search-number">${theme.memoryCount ?? 0}</td>
        <td class="search-actions">
          <button class="btn btn-danger btn-sm" data-action="delete-theme" data-theme="${escapeHtml(
            theme.name,
          )}" type="button">Delete</button>
        </td>
      </tr>
    `,
    )
    .join('');
}

async function loadThemes() {
  state.data.themes = await api('/api/themes');
  if (state.currentView === 'themes') renderThemes();
}

function renderThemeDetailView() {
  const detail = state.data.themeDetail;
  const title = detail?.displayName || state.currentTheme || 'Theme';
  if (!detail) {
    return `
      <section class="view view-active" data-view="theme-detail">
        <div class="page-header">
          <h1 class="page-title">${escapeHtml(title)}</h1>
        </div>
        <div class="empty-state">Loading theme…</div>
      </section>
    `;
  }
  return `
    <section class="view view-active" data-view="theme-detail">
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(title)}</h1>
          <div class="muted">${escapeHtml(state.currentTheme || '')}</div>
        </div>
        <div class="inline-edit">
          <input id="themeDisplayName" type="text" value="${escapeHtml(title)}" placeholder="Display name" />
          <button id="renameThemeBtn" class="btn btn-primary btn-sm" type="button">Rename</button>
          <div class="page-header-actions">
            <button class="btn btn-secondary btn-sm" id="backToThemesBtn" type="button">Back</button>
            <button class="btn btn-danger btn-sm" id="deleteThemeBtn" type="button">Delete</button>
          </div>
        </div>
      </div>
      <div class="timeline" id="themeTimeline"></div>
    </section>
  `;
}

function bindThemeDetailView() {
  renderThemeTimeline();
  $('#renameThemeBtn')?.addEventListener('click', renameTheme);
  $('#deleteThemeBtn')?.addEventListener('click', () => deleteTheme(state.currentTheme));
  $('#backToThemesBtn')?.addEventListener('click', () => {
    setHash('themes');
    applyHash();
  });
}

function renderThemeTimeline() {
  const timeline = $('#themeTimeline');
  if (!timeline) return;
  const detail = state.data.themeDetail;
  if (!detail || !detail.items || detail.items.length === 0) {
    timeline.innerHTML = '<div class="empty-state">No turns or memories linked to this theme.</div>';
    return;
  }

  timeline.innerHTML = detail.items
    .map((item) => {
      if (item.type === 'turn') {
        const turn = item.data;
        const bullets =
          Array.isArray(turn.facts) && turn.facts.length
            ? `<ul class="decision-bullets">${turn.facts.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}</ul>`
            : '';
        const tags = [...(turn.entities?.files || []), ...(Object.values(turn.categories || {}).flat())];
        return `
          <div class="timeline-item hit" data-session="${escapeHtml(turn.sessionId)}" data-turn="${turn.turnId}">
            <div class="timeline-dot"></div>
            <div class="timeline-card">
              <div class="timeline-meta">${escapeHtml(turn.sessionId)} · turn ${turn.turnId}</div>
              <h4>${escapeHtml(turn.summary || 'Untitled turn')}</h4>
              ${bullets}
              <div class="tag-list">
                ${tags
                  .map((t) => `<span class="tag${t.includes('.') ? ' file' : ''}">${escapeHtml(t)}</span>`)
                  .join('')}
              </div>
            </div>
          </div>
        `;
      }
      const memory = item.data;
      return `
        <div class="timeline-item memory">
          <div class="timeline-header">
            <span class="badge">Memory</span>
            <span class="timeline-time">${formatDate(memory.timestamp)}</span>
          </div>
          <div class="timeline-card">
            <h4>${escapeHtml(memory.title || memory.key)}</h4>
            <p>${escapeHtml(memory.content.slice(0, 240))}${memory.content.length > 240 ? '…' : ''}</p>
            <div class="timeline-meta">${escapeHtml(memory.folder)}/${escapeHtml(memory.key)}</div>
          </div>
        </div>
      `;
    })
    .join('');
}

async function loadThemeDetail(themeName) {
  if (!themeName) return;
  const data = await api(`/api/themes/${encodeURIComponent(themeName)}`);
  state.data.themeDetail = data;
  state.currentTheme = themeName;
  if (state.currentView === 'theme-detail') {
    renderContent();
  }
}

async function renameTheme() {
  const themeName = state.currentTheme;
  const displayName = $('#themeDisplayName').value.trim();
  if (!themeName || !displayName) return;
  try {
    await api(`/api/themes/${encodeURIComponent(themeName)}`, {
      method: 'POST',
      body: JSON.stringify({ displayName }),
    });
    if (state.data.themeDetail) state.data.themeDetail.displayName = displayName;
    await loadThemes();
    renderTopbar();
  } catch (err) {
    alert(`Rename failed: ${err.message}`);
  }
}

async function deleteTheme(themeName) {
  if (!themeName) return;
  if (!confirm(`Delete theme "${themeName}"?`)) return;
  try {
    await deleteThemeApi(themeName);
    if (state.currentTheme === themeName) {
      setHash('themes');
      applyHash();
    }
    await loadThemes();
    await loadWorkspace();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

// ---- Searches view ----

async function deleteSearchView(key) {
  if (!key) return;
  if (!confirm(`Delete search view "${key}"?`)) return;
  const deleteRefinedTurns = confirm('Also delete the refined turns referenced by this view?\n\nCancel keeps the refined turns.');
  try {
    await deleteSearchViewApi(key, deleteRefinedTurns);
    if (state.currentSearchKey === key) {
      setHash('searches');
      applyHash();
    }
    await loadSearches();
    await loadWorkspace();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

function renderSearchesView() {
  const searches = state.data.searches || [];
  if (searches.length === 0) {
    return `
      <section class="view view-active" data-view="searches">
        <div class="page-header">
          <h1 class="page-title">Saved Searches</h1>
        </div>
        <div class="empty-state">No saved search views yet.</div>
      </section>
    `;
  }
  const rowsHtml = searches
    .map(
      (s) => `
      <tr class="search-row" data-key="${escapeHtml(s.key)}">
        <td class="search-cell search-query">${escapeHtml(s.query || s.key)}</td>
        <td class="search-cell">${escapeHtml(s.createdAt ? new Date(s.createdAt).toLocaleString() : '-')}</td>
        <td class="search-cell search-number">${s.totalHits ?? s.resultCount ?? 0}</td>
        <td class="search-cell search-number">${s.clusterCount ?? 0}</td>
        <td class="search-actions">
          <button class="btn btn-danger btn-sm" data-action="delete-search" data-key="${escapeHtml(
            s.key,
          )}" type="button">Delete</button>
        </td>
      </tr>
    `,
    )
    .join('');
  return `
    <section class="view view-active" data-view="searches">
      <div class="page-header">
        <h1 class="page-title">Saved Searches</h1>
      </div>
      <div class="search-table-wrap">
        <table class="search-table" id="searchesTable">
          <thead>
            <tr>
              <th>Keywords</th>
              <th>Created</th>
              <th class="search-number">Hits</th>
              <th class="search-number">Clusters</th>
              <th class="search-actions">Actions</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    </section>
  `;
}

function bindSearchesView() {
  // Clicks are handled via content event delegation to avoid duplicate listeners.
}

async function loadSearches() {
  try {
    const searches = await api('/api/searches');
    state.data.searches = Array.isArray(searches) ? searches : [];
  } catch (err) {
    state.data.searches = [];
    console.error('loadSearches failed:', err);
  }
  if (state.currentView === 'searches') {
    renderContent();
    bindSearchesView();
  }
}

function renderSearchDetailView() {
  const detail = state.data.searchDetail;
  if (!detail) {
    return `
      <section class="view view-active" data-view="search-detail">
        <div class="page-header">
          <h1 class="page-title">Search Detail</h1>
        </div>
        <div class="empty-state">Loading search view…</div>
      </section>
    `;
  }
  const turnsHtml = (detail.turns || [])
    .map(
      (turn, idx) => `
      <div class="timeline-item ${turn.isHit ? 'hit' : ''}" data-session="${escapeHtml(turn.sessionId)}" data-turn="${turn.turnId}" style="--i:${idx}">
        <div class="timeline-dot"></div>
        <div class="timeline-card">
          <div class="timeline-meta">${escapeHtml(turn.sessionId)} · turn ${turn.turnId}</div>
          <div class="timeline-summary">${escapeHtml(turn.summary || 'No summary')}</div>
        </div>
      </div>
    `,
    )
    .join('');
  return `
    <section class="view view-active" data-view="search-detail">
      <div class="page-header">
        <div>
          <h1 class="page-title">${escapeHtml(detail.query || detail.key)}</h1>
          <div class="muted">${detail.totalHits ?? 0} hits · ${detail.clusterCount ?? 0} clusters · ${escapeHtml(
            detail.createdAt ? new Date(detail.createdAt).toLocaleString() : '',
          )}</div>
        </div>
        <div class="page-header-actions">
          <button class="btn btn-secondary btn-sm" id="backToSearchesBtn" type="button">Back</button>
          <button class="btn btn-danger btn-sm" id="deleteSearchViewBtn" type="button">Delete</button>
        </div>
      </div>
      <div class="timeline" id="searchTimeline">${turnsHtml || '<div class="empty-state">No refined turns.</div>'}</div>
    </section>
  `;
}

function bindSearchDetailView() {
  $('#backToSearchesBtn')?.addEventListener('click', () => {
    setHash('searches');
    applyHash();
  });
  $('#deleteSearchViewBtn')?.addEventListener('click', () => deleteSearchView(state.currentSearchKey));
  // Timeline item clicks are handled via content event delegation.
}

async function loadSearchDetail() {
  const key = state.currentSearchKey;
  if (!key) return;
  try {
    const detail = await api(`/api/searches/${encodeURIComponent(key)}`);
    state.data.searchDetail = detail;
  } catch (err) {
    state.data.searchDetail = null;
    console.error('loadSearchDetail failed:', err);
  }
  if (state.currentView === 'search-detail') {
    renderContent();
    bindSearchDetailView();
  }
}

// ---- Decisions view ----

function renderList(items, empty) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<p class="muted">${escapeHtml(empty)}</p>`;
  }
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

async function showRefinedTurnModal(sessionId, turnId) {
  try {
    const turn = await api(`/api/refined-turn/${encodeURIComponent(sessionId)}/${turnId}`);
    const factsHtml = renderList(turn.facts, 'No facts');
    const notesHtml = renderList(turn.notes, 'No notes');
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h3>${escapeHtml(sessionId)} · turn ${turnId}</h3>
          <button class="modal-close" type="button">×</button>
        </div>
        <div class="modal-body">
          <div class="muted">${escapeHtml(turn.timestamp ? new Date(turn.timestamp).toLocaleString() : '')}</div>
          <h4>Summary</h4>
          <p>${escapeHtml(turn.summary || 'No summary')}</p>
          <h4>Facts</h4>
          ${factsHtml}
          <h4>Notes</h4>
          ${notesHtml}
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });
  } catch (err) {
    alert(`Failed to load turn: ${err.message}`);
  }
}

function renderDecisionsView() {
  return `
    <section class="view view-active" data-view="decisions">
      <div class="page-header">
        <h1 class="page-title">Recent Decisions</h1>
        <input type="search" class="search-input" id="decisionsFilter" placeholder="Filter decisions…" value="${escapeHtml(
          state.decisionsFilter,
        )}" />
      </div>
      <div class="decisions-list" id="decisionsList"></div>
    </section>
  `;
}

function bindDecisionsView() {
  $('#decisionsFilter').addEventListener('input', (e) => {
    state.decisionsFilter = e.target.value.toLowerCase();
    renderDecisions();
  });
  renderDecisions();
}

function renderDecisions() {
  const list = $('#decisionsList');
  if (!list) return;
  const filtered = state.data.decisions.filter((d) => {
    if (!state.decisionsFilter) return true;
    const hay = `${d.summary} ${d.decisions.join(' ')} ${d.files.join(' ')} ${d.tags.join(' ')}`.toLowerCase();
    return hay.includes(state.decisionsFilter);
  });

  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty-state">No matching decisions.</div>';
    return;
  }

  list.innerHTML = filtered
    .map(
      (d) => `
      <div class="decision-row">
        <div class="decision-row-main">
          <div class="decision-row-title">Turn ${d.turnId} · ${escapeHtml(d.sessionId)}</div>
          <div class="decision-row-summary">${escapeHtml(d.summary)}</div>
          <div class="tag-list">
            ${d.decisions.map((dec) => `<span class="tag">${escapeHtml(dec)}</span>`).join('')}
            ${d.files.map((f) => `<span class="tag file">${escapeHtml(f)}</span>`).join('')}
            ${d.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          </div>
        </div>
        <div class="decision-row-meta">
          <div class="decision-time">${formatDate(d.timestamp)}</div>
        </div>
      </div>
    `,
    )
    .join('');
}

async function loadDecisions() {
  state.data.decisions = await api('/api/decisions?limit=50');
  if (state.currentView === 'decisions') renderDecisions();
}

// ---- Memories view ----

function renderMemoriesView() {
  return `
    <section class="view view-active" data-view="memories">
      <div class="page-header">
        <h1 class="page-title">Memories</h1>
        <button class="btn btn-primary btn-sm" id="newFolderTopBtn" type="button">+ New folder</button>
      </div>
      <div class="memories-layout">
        <div class="folder-tree" id="folderTree">
          <div class="empty-state">Loading folders…</div>
        </div>
        <div class="memory-editor" id="memoryEditor">
          <div class="empty-state">Select a folder or file to get started.</div>
        </div>
      </div>
    </section>
  `;
}

function bindMemoriesView() {
  renderFolderTree();
  renderMemoryEditor();
  $('#newFolderTopBtn')?.addEventListener('click', () => createFolderPrompt(state.selectedMemoryFolder));
}

function renderFolderRow(node, path, depth = 0) {
  const isRoot = path === node.name;
  const isSelected = state.selectedMemoryFolder === path;
  const childrenHtml = (node.children || [])
    .map((child) => renderFolderRow(child, `${path}/${child.name}`, depth + 1))
    .join('');

  const files = Array.isArray(node.files) ? node.files : [];
  const filesHtml = files.length
    ? `<div class="tree-file-list">
        ${files
          .map(
            (file) => `
          <div class="tree-file-row ${
            state.selectedMemoryFile?.folder === path && state.selectedMemoryFile?.key === file.key
              ? 'active'
              : ''
          }" data-folder="${escapeHtml(path)}" data-key="${escapeHtml(file.key)}" style="padding-left:${
              12 + (depth + 1) * 14
            }px">
            <span class="file-icon">📄</span>
            <span class="file-name">${escapeHtml(file.title || file.key)}</span>
          </div>
        `,
          )
          .join('')}
      </div>`
    : '';

  return `
    <div class="folder-branch" data-folder="${escapeHtml(path)}">
      <div class="folder-row ${isSelected ? 'active' : ''}" style="padding-left:${12 + depth * 14}px">
        <span class="folder-row-main" data-folder="${escapeHtml(path)}">
          <span class="folder-icon">${isRoot ? '📁' : '📂'}</span>
          <span class="folder-name">${escapeHtml(node.name || 'root')}</span>
          ${files.length > 0 ? `<span class="folder-count">${files.length}</span>` : ''}
        </span>
        <span class="folder-actions">
          <button class="icon-btn" data-action="new-file" data-folder="${escapeHtml(path)}" title="New file">✚</button>
          <button class="icon-btn" data-action="rename" data-folder="${escapeHtml(path)}" title="Rename">✎</button>
          ${!isRoot ? `<button class="icon-btn" data-action="delete" data-folder="${escapeHtml(path)}" title="Delete">🗑</button>` : ''}
        </span>
      </div>
      ${filesHtml}
      ${childrenHtml}
    </div>
  `;
}

function renderFolderTree() {
  const tree = $('#folderTree');
  if (!tree) return;
  if (state.memoriesError) {
    tree.innerHTML = `<div class="empty-state" style="color:var(--err)">Failed to load memories.<br><small>${escapeHtml(state.memoriesError)}</small></div>`;
    return;
  }
  if (!state.data.memories) {
    tree.innerHTML = '<div class="empty-state">Loading folders…</div>';
    return;
  }

  const virtualRoot = state.data.memories;
  const rootsHtml = (virtualRoot.children || [])
    .map((root) => renderFolderRow(root, root.name))
    .join('');
  tree.innerHTML = rootsHtml || '<div class="empty-state">No folders found.</div>';

  tree.querySelectorAll('.folder-row-main').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectFolder(el.dataset.folder);
    });
  });

  tree.querySelectorAll('.tree-file-row').forEach((el) => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      selectFile(el.dataset.folder, el.dataset.key);
    });
  });

  tree.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const folder = btn.dataset.folder;
      const action = btn.dataset.action;
      if (action === 'new-file') createFilePrompt(folder);
      else if (action === 'rename') renameFolderPrompt(folder);
      else if (action === 'delete') deleteFolderPrompt(folder);
    });
  });
}

function getFolderNode(root, folderPath) {
  const parts = folderPath.split('/');
  let current = root;
  if (!current) return null;
  for (const part of parts) {
    current = (current.children || []).find((c) => c.name === part);
    if (!current) return null;
  }
  return current;
}

function renderFileList(folderPath) {
  const node = getFolderNode(state.data.memories, folderPath);
  if (!node || !node.files.length) {
    return '<div class="empty-state" style="min-height:120px">No files in this folder.</div>';
  }
  const filesHtml = node.files
    .map(
      (file) => `
      <div class="file-row ${state.selectedMemoryFile?.folder === folderPath && state.selectedMemoryFile?.key === file.key ? 'active' : ''}"
           data-folder="${escapeHtml(folderPath)}" data-key="${escapeHtml(file.key)}">
        <span class="file-icon">📄</span>
        <span class="file-name">${escapeHtml(file.title || file.key)}</span>
      </div>
    `,
    )
    .join('');
  return `<div class="file-list">${filesHtml}</div>`;
}

function renderMemoryEditor() {
  const editor = $('#memoryEditor');
  if (!editor) return;

  const file = state.selectedMemoryFile;
  let composerHtml = '';
  if (file) {
    const editing = state.editingMemory || file.isNew;
    const tagsHtml = (Array.isArray(file.tags) ? file.tags : [])
      .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
      .join('');
    const tagsEditValue = Array.isArray(file.tags) ? file.tags.join(', ') : '';
    const bodyHtml = editing
      ? `
        <label class="field-label">Title</label>
        <input type="text" class="composer-input" id="memoryTitle" value="${escapeHtml(
          file.title || '',
        )}" placeholder="Memory title" />
        <label class="field-label">Tags</label>
        <input type="text" class="composer-input" id="memoryTags" value="${escapeHtml(
          tagsEditValue,
        )}" placeholder="tag1, tag2" />
        <label class="field-label">Content</label>
        <textarea class="composer-textarea" id="memoryContent" placeholder="Write markdown content…">${escapeHtml(
          file.content || '',
        )}</textarea>
      `
      : `
        <div class="memory-meta">
          <div class="memory-title">${escapeHtml(file.title || file.key)}</div>
          <div class="tag-list">${tagsHtml}</div>
        </div>
        <div class="memory-content md-content">${
          file.content ? renderMarkdown(file.content) : '<span class="muted">Empty file.</span>'
        }</div>
      `;
    const actionsHtml = editing
      ? `
        <button class="btn btn-primary btn-sm" id="saveMemoryBtn" type="button">Save</button>
        <button class="btn btn-secondary btn-sm" id="cancelEditMemoryBtn" type="button">Cancel</button>
        ${!file.isNew ? '<button class="btn btn-danger btn-sm" id="deleteMemoryBtn" type="button">Delete</button>' : ''}
      `
      : `
        <button class="btn btn-secondary btn-sm" id="editMemoryBtn" type="button">Edit</button>
        <button class="btn btn-danger btn-sm" id="deleteMemoryBtn" type="button">Delete</button>
      `;
    composerHtml = `
      <div class="composer-card memory-composer">
        <div class="composer-header">
          <h2 class="composer-title">${escapeHtml(file.key)}</h2>
          <div class="page-header-actions">
            ${actionsHtml}
          </div>
        </div>
        <div class="composer-status" id="composerStatus"></div>
        <div class="composer-body">
          ${bodyHtml}
        </div>
      </div>
    `;
  } else {
    composerHtml = `
      <div class="empty-state" style="min-height:180px">
        <div>
          <div style="font-size:18px;margin-bottom:8px">📝</div>
          <div>Select a file to view, or choose a folder and create a new file.</div>
        </div>
      </div>
    `;
  }

  editor.innerHTML = composerHtml;

  if (file) {
    $('#editMemoryBtn')?.addEventListener('click', startEditMemory);
    $('#saveMemoryBtn')?.addEventListener('click', saveSelectedMemory);
    $('#cancelEditMemoryBtn')?.addEventListener('click', cancelEditMemory);
    $('#deleteMemoryBtn')?.addEventListener('click', deleteSelectedMemory);
  }
}

function startEditMemory() {
  state.editingMemory = true;
  renderMemoryEditor();
}

function cancelEditMemory() {
  state.editingMemory = false;
  if (state.selectedMemoryFile?.isNew) {
    state.selectedMemoryFile = null;
  }
  renderMemoryEditor();
}

function selectFolder(folderPath) {
  state.selectedMemoryFolder = folderPath;
  state.selectedMemoryFile = null;
  renderFolderTree();
  renderMemoryEditor();
}

async function selectFile(folder, key) {
  try {
    const memory = await api(`/api/memory/${encodeURIComponent(folder)}/${encodeURIComponent(key)}`);
    state.selectedMemoryFile = { folder, key, ...memory };
    state.selectedMemoryFolder = folder;
    state.editingMemory = false;
    renderFolderTree();
    renderMemoryEditor();
  } catch (err) {
    alert(`Failed to load memory: ${err.message}`);
  }
}

async function createFolderPrompt(parentFolder) {
  const parent = parentFolder && state.memoryFolders.includes(parentFolder) ? parentFolder : 'memory';
  const name = prompt('New folder name:', '');
  if (!name) return;
  const folderPath = `${parent}/${name.trim()}`.replace(/\/+/g, '/');
  try {
    const result = await createMemoryFolder(folderPath);
    if (!result.ok) throw new Error(result.error || 'Failed to create folder');
    state.selectedMemoryFolder = folderPath;
    await loadMemories();
  } catch (err) {
    alert(`Create folder failed: ${err.message}`);
  }
}

async function renameFolderPrompt(folderPath) {
  const newPath = prompt('Rename folder to:', folderPath);
  if (!newPath || newPath === folderPath) return;
  try {
    const result = await renameMemoryFolder(folderPath, newPath);
    if (!result.ok) throw new Error(result.error || 'Failed to rename folder');
    if (state.selectedMemoryFolder === folderPath) state.selectedMemoryFolder = newPath;
    await loadMemories();
  } catch (err) {
    alert(`Rename folder failed: ${err.message}`);
  }
}

async function deleteFolderPrompt(folderPath) {
  if (!confirm(`Delete folder "${folderPath}" and all its contents? This cannot be undone.`)) return;
  try {
    const result = await deleteMemoryFolder(folderPath, true);
    if (!result.ok) throw new Error(result.error || 'Failed to delete folder');
    if (state.selectedMemoryFolder === folderPath) {
      state.selectedMemoryFolder = null;
      state.selectedMemoryFile = null;
    }
    await loadMemories();
  } catch (err) {
    alert(`Delete folder failed: ${err.message}`);
  }
}

async function createFilePrompt(folderPath) {
  const key = prompt('New memory key:', '');
  if (!key) return;
  state.selectedMemoryFile = { folder: folderPath, key, title: '', tags: [], content: '', isNew: true };
  state.selectedMemoryFolder = folderPath;
  state.editingMemory = true;
  renderFolderTree();
  renderMemoryEditor();
}

function parseTagsInput(value) {
  return String(value || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

async function saveSelectedMemory() {
  const file = state.selectedMemoryFile;
  if (!file) return;
  const title = $('#memoryTitle').value;
  const tags = parseTagsInput($('#memoryTags').value);
  const content = $('#memoryContent').value;
  const status = $('#composerStatus');
  try {
    const result = await writeMemory(file.folder, file.key, { content, title, tags });
    if (!result.ok) throw new Error(result.error || 'Failed to save memory');
    setStatus(status, 'Memory saved.', 'success');
    state.editingMemory = false;
    state.selectedMemoryFile = { ...file, title, tags, content, isNew: false };
    await loadMemories();
  } catch (err) {
    setStatus(status, `Save failed: ${err.message}`, 'error');
  }
}

async function deleteSelectedMemory() {
  const file = state.selectedMemoryFile;
  if (!file) return;
  if (!confirm(`Delete "${file.folder}/${file.key}"? This cannot be undone.`)) return;
  try {
    const result = await deleteMemoryFile(file.folder, file.key);
    if (!result.ok) throw new Error(result.error || 'Failed to delete memory');
    state.selectedMemoryFile = null;
    await loadMemories();
  } catch (err) {
    alert(`Delete memory failed: ${err.message}`);
  }
}

function deriveFoldersFromTree(tree) {
  const folders = [];
  function walk(node, prefix) {
    if (!node) return;
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    if (prefix || node.name) folders.push(path);
    for (const child of node.children || []) walk(child, path);
  }
  if (tree && Array.isArray(tree.children)) {
    for (const root of tree.children) walk(root, '');
  }
  return folders.sort();
}

function findFirstFolderWithFiles(node) {
  if (!node) return null;
  if (Array.isArray(node.files) && node.files.length > 0 && node.name) {
    return node.name;
  }
  for (const child of node.children || []) {
    const found = findFirstFolderWithFiles(child);
    if (found) return node.name ? `${node.name}/${found}` : found;
  }
  return null;
}

async function loadMemories() {
  state.memoriesError = null;
  try {
    const tree = await api('/api/memories');
    state.data.memories = tree;
    let folders = [];
    try {
      folders = await listMemoryFolders();
    } catch (err) {
      console.warn('Failed to fetch /api/folders, deriving from tree:', err);
      folders = deriveFoldersFromTree(tree);
    }
    state.memoryFolders = folders;
    if (state.selectedMemoryFolder && !folders.includes(state.selectedMemoryFolder)) {
      state.selectedMemoryFolder = null;
      state.selectedMemoryFile = null;
    }
    if (!state.selectedMemoryFolder && tree) {
      const autoFolder = findFirstFolderWithFiles(tree);
      if (autoFolder) state.selectedMemoryFolder = autoFolder;
    }
    if (state.currentView === 'memories') {
      renderFolderTree();
      renderMemoryEditor();
    }
  } catch (err) {
    state.memoriesError = String(err.message || err);
    console.error('loadMemories failed:', err);
    if (state.currentView === 'memories') {
      renderFolderTree();
      renderMemoryEditor();
    }
  }
}

// ---- Settings view ----

function renderSettingsView() {
  const ws = state.data.workspace || {};
  const autoVis = localStorage.getItem(LS_KEY_AUTO_VIS) === 'true';
  return `
    <section class="view view-active" data-view="settings">
      <div class="page-header">
        <h1 class="page-title">Settings</h1>
      </div>
      <div class="settings-grid">
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Paths</h2>
          </div>
          <div class="card-body">
            <div class="info-row">
              <span class="info-label">Workspace ID</span>
              <code class="info-value" id="settingsWorkspaceId">${escapeHtml(ws.id || '–')}</code>
            </div>
            <div class="info-row">
              <span class="info-label">Workspace path</span>
              <code class="info-value" id="settingsCwd">${escapeHtml(ws.cwd || '–')}</code>
            </div>
            <div class="info-row">
              <span class="info-label">Store root</span>
              <code class="info-value" id="settingsStoreRoot">${escapeHtml(ws.storePath || '–')}</code>
            </div>
            <div class="info-row">
              <span class="info-label">MCP config hint</span>
              <code class="info-value">~/.kimi-code/mcp.json</code>
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Environment</h2>
          </div>
          <div class="card-body">
            <label class="toggle-row">
              <span>Auto-open dashboard (KIMI_MEMORY_AUTO_VIS)</span>
              <input type="checkbox" id="autoVisToggle" ${autoVis ? 'checked' : ''} />
            </label>
            <p class="help-text">When enabled, the dashboard will open automatically on startup. This toggle stores a local preference; the actual environment variable must be set in your Kimi Code/MCP configuration.</p>
          </div>
        </div>
        <div class="card">
          <div class="card-header">
            <h2 class="card-title">Links</h2>
          </div>
          <div class="card-body">
            <div class="link-list">
              <a class="btn btn-secondary" href="https://github.com/Zehee/kimi-code-memory-mcp-server" target="_blank" rel="noopener">GitHub</a>
              <a class="btn btn-secondary" href="https://www.npmjs.com/package/kimi-code-memory-mcp-server" target="_blank" rel="noopener">npm</a>
            </div>
          </div>
        </div>
      </div>
    </section>
  `;
}

function updateSettingsView() {
  if (state.currentView !== 'settings') return;
  const ws = state.data.workspace || {};
  $('#settingsWorkspaceId').textContent = ws.id || '–';
  $('#settingsCwd').textContent = ws.cwd || '–';
  $('#settingsStoreRoot').textContent = ws.storePath || '–';
}

function bindSettingsView() {
  $('#autoVisToggle').addEventListener('change', (e) => {
    localStorage.setItem(LS_KEY_AUTO_VIS, String(e.target.checked));
  });
}

// ---- Routing / init ----

function loadDataForView(view, theme, key) {
  switch (view) {
    case 'workspace':
    case 'settings':
      if (!state.data.workspace) loadWorkspace();
      break;
    case 'themes':
      if (state.data.themes.length === 0) loadThemes();
      break;
    case 'theme-detail':
      loadThemeDetail(theme);
      break;
    case 'decisions':
      if (state.data.decisions.length === 0) loadDecisions();
      break;
    case 'memories':
      if (!state.data.memories) loadMemories();
      break;
    case 'searches':
      if (!state.data.searches) loadSearches();
      break;
    case 'search-detail':
      loadSearchDetail();
      break;
  }
}

function handleContentClick(e) {
  const deleteThemeBtn = e.target.closest('[data-action="delete-theme"]');
  if (deleteThemeBtn) {
    e.stopPropagation();
    deleteTheme(deleteThemeBtn.dataset.theme);
    return;
  }

  const deleteSearchBtn = e.target.closest('[data-action="delete-search"]');
  if (deleteSearchBtn) {
    e.stopPropagation();
    deleteSearchView(deleteSearchBtn.dataset.key);
    return;
  }

  const searchRow = e.target.closest('#searchesTable .search-row');
  if (searchRow) {
    const key = searchRow.dataset.key;
    setHash(`searches/${key}`);
    applyHash();
    return;
  }

  const themeRow = e.target.closest('#themesTable .theme-row');
  if (themeRow) {
    const theme = themeRow.dataset.theme;
    setHash(`themes/${theme}`);
    applyHash();
    return;
  }

  const searchTimelineItem = e.target.closest('#searchTimeline .timeline-item');
  if (searchTimelineItem) {
    const sessionId = searchTimelineItem.dataset.session;
    const turnId = parseInt(searchTimelineItem.dataset.turn, 10);
    showRefinedTurnModal(sessionId, turnId);
    return;
  }

  const themeTimelineItem = e.target.closest('#themeTimeline .timeline-item[data-session]');
  if (themeTimelineItem) {
    const sessionId = themeTimelineItem.dataset.session;
    const turnId = parseInt(themeTimelineItem.dataset.turn, 10);
    showRefinedTurnModal(sessionId, turnId);
    return;
  }
}

function init() {
  state.sidebarCollapsed = getInitialCollapsed();
  updateCollapsedClass();

  $('#content').addEventListener('click', handleContentClick);

  window.addEventListener('hashchange', applyHash);
  window.addEventListener('popstate', applyHash);

  applyHash();
  loadWorkspace();
}

init();
