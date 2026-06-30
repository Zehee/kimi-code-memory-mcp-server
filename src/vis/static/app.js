(() => {
  const LS_KEY_COLLAPSED = 'kimi-memory-vis.sidebarCollapsed';
  const LS_KEY_AUTO_VIS = 'kimi-memory-vis.autoVis';

  const sections = [
    { id: 'workspace', label: 'Workspace', icon: '◈' },
    { id: 'themes', label: 'Themes', icon: '◉' },
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
      items: [{ id: 'themes', label: 'Themes', icon: '◉' }],
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

  const viewToSection = {
    workspace: 'workspace',
    themes: 'themes',
    'theme-detail': 'themes',
    decisions: 'decisions',
    memories: 'memories',
    settings: 'settings',
  };

  const state = {
    currentView: 'workspace',
    currentTheme: null,
    sidebarCollapsed: false,
    sidebarOpenMobile: false,
    decisionsFilter: '',
    data: {
      workspace: null,
      themes: [],
      decisions: [],
      memories: null,
      themeDetail: null,
    },
    memoryFolders: [],
    selectedMemoryFolder: null,
    selectedMemoryFile: null,
  };

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  function formatDate(iso) {
    if (!iso) return '–';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? iso : d.toLocaleString();
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${text}`);
    }
    return res.json();
  }

  async function listMemoryFolders() {
    return api('/api/folders');
  }

  async function writeMemory(folder, key, { content, title, tags }) {
    return api(`/api/memory/${encodeURIComponent(folder)}/${encodeURIComponent(key)}`, {
      method: 'POST',
      body: JSON.stringify({ content, title, tags }),
    });
  }

  async function deleteMemoryFile(folder, key) {
    return api(`/api/memory/${encodeURIComponent(folder)}/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
  }

  async function createMemoryFolder(folder) {
    return api('/api/folders', {
      method: 'POST',
      body: JSON.stringify({ folder }),
    });
  }

  async function renameMemoryFolder(oldFolder, newFolder) {
    return api(`/api/folders/${encodeURIComponent(oldFolder)}/rename`, {
      method: 'POST',
      body: JSON.stringify({ newFolder }),
    });
  }

  async function deleteMemoryFolder(folder, recursive) {
    return api(`/api/folders/${encodeURIComponent(folder)}?recursive=${recursive ? 'true' : 'false'}`, {
      method: 'DELETE',
    });
  }

  function setStatus(el, message, type = 'success') {
    if (!el) return;
    el.textContent = message;
    el.className = `composer-status ${type}`.trim();
    if (message) {
      setTimeout(() => {
        el.textContent = '';
        el.className = 'composer-status';
      }, 3000);
    }
  }

  function getInitialCollapsed() {
    const saved = localStorage.getItem(LS_KEY_COLLAPSED);
    if (saved !== null) return saved === 'true';
    return window.innerWidth < 768;
  }

  function updateCollapsedClass() {
    $('#app').classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
  }

  function toggleSidebar() {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    localStorage.setItem(LS_KEY_COLLAPSED, String(state.sidebarCollapsed));
    updateCollapsedClass();
  }

  function toggleMobileSidebar() {
    state.sidebarOpenMobile = !state.sidebarOpenMobile;
    $('#sidebar').classList.toggle('open', state.sidebarOpenMobile);
  }

  function sectionFor(view) {
    return viewToSection[view] || 'workspace';
  }

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
    const known = ['workspace', 'themes', 'decisions', 'memories', 'settings', 'theme-detail'];
    if (known.includes(raw)) return { view: raw, theme: null };
    return { view: 'workspace', theme: null };
  }

  function applyHash() {
    const { view, theme } = parseHash();
    state.currentView = view;
    state.currentTheme = theme;
    state.sidebarOpenMobile = false;
    $('#sidebar').classList.remove('open');
    renderAll();
    loadDataForView(view, theme);
  }

  function renderAll() {
    renderRail();
    renderSidebar();
    renderTopbar();
    renderContent();
  }

  function renderRail() {
    const currentSection = sectionFor(state.currentView);
    const railItems = sections
      .map(
        (s) => `
        <div class="rail-item ${s.id === currentSection ? 'active' : ''}" data-section="${escapeHtml(
          s.id,
        )}" title="${escapeHtml(s.label)}">
          <span class="rail-icon">${escapeHtml(s.icon)}</span>
          <span class="rail-label">${escapeHtml(s.label)}</span>
        </div>
      `,
      )
      .join('');

    const expandItem = state.sidebarCollapsed
      ? `<div class="rail-item rail-expand" id="railExpandBtn" title="Expand sidebar"><span class="rail-icon">▶</span><span class="rail-label">Expand</span></div>`
      : '';

    $('#rail').innerHTML = railItems + expandItem;

    $('#railExpandBtn')?.addEventListener('click', toggleSidebar);

    $('#rail').querySelectorAll('.rail-item[data-section]').forEach((el) => {
      el.addEventListener('click', () => {
        const section = el.dataset.section;
        const view = section === 'themes' && state.currentTheme ? `themes/${state.currentTheme}` : section;
        setHash(view);
        applyHash();
      });
    });
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
    const parts = [{ label: 'Workspace', hash: '#workspace' }];
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
      case 'settings':
        content.innerHTML = renderSettingsView();
        bindSettingsView();
        break;
      default:
        content.innerHTML = renderWorkspaceView();
        bindWorkspaceView();
    }
  }

  function renderWorkspaceView() {
    return `
      <section class="view view-active" data-view="workspace">
        <div class="page-header">
          <h1 class="page-title">Workspace</h1>
        </div>
        <div class="stat-grid" id="statsGrid"></div>
        <div class="composer-card">
          <div class="composer-header">
            <h2 class="composer-title">Workspace essence</h2>
            <button class="btn btn-primary" id="saveEssenceBtn" type="button">Save</button>
          </div>
          <div class="composer-body">
            <textarea class="essence-editor" id="essenceEditor" placeholder="Workspace essence is empty. Write a short constitution here…"></textarea>
          </div>
          <div class="composer-status" id="essenceStatus"></div>
        </div>
      </section>
    `;
  }

  function bindWorkspaceView() {
    renderStats(state.data.workspace?.stats || {});
    $('#essenceEditor').value = state.data.workspace?.essence || '';
    $('#saveEssenceBtn').addEventListener('click', saveEssence);
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
    renderSidebar();
    if (state.currentView === 'workspace') {
      renderStats(data.stats);
      $('#essenceEditor').value = data.essence;
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

  function renderThemesView() {
    return `
      <section class="view view-active" data-view="themes">
        <div class="page-header">
          <h1 class="page-title">Themes</h1>
          <span class="badge" id="themeCountBadge">0 themes</span>
        </div>
        <div class="theme-grid" id="themesGrid"></div>
      </section>
    `;
  }

  function bindThemesView() {
    renderThemes();
  }

  function renderThemes() {
    const grid = $('#themesGrid');
    const badge = $('#themeCountBadge');
    if (!grid) return;
    badge.textContent = `${state.data.themes.length} theme${state.data.themes.length === 1 ? '' : 's'}`;
    if (state.data.themes.length === 0) {
      grid.innerHTML = '<div class="empty-state">No themes yet.</div>';
      return;
    }
    grid.innerHTML = state.data.themes
      .map(
        (theme) => `
        <div class="theme-card" data-theme="${escapeHtml(theme.name)}">
          <div class="theme-name">${escapeHtml(theme.displayName || theme.name)}</div>
          <div class="theme-meta">
            <span>${theme.turnCount} turns</span>
            <span>${theme.memoryCount} memories</span>
          </div>
        </div>
      `,
      )
      .join('');

    grid.querySelectorAll('.theme-card').forEach((card) => {
      card.addEventListener('click', () => {
        const theme = card.dataset.theme;
        setHash(`themes/${theme}`);
        applyHash();
      });
    });
  }

  async function loadThemes() {
    state.data.themes = await api('/api/themes');
    if (state.currentView === 'themes') renderThemes();
  }

  function renderThemeDetailView() {
    const detail = state.data.themeDetail;
    const title = detail?.displayName || state.currentTheme || 'Theme';
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
          </div>
        </div>
        <div class="timeline" id="themeTimeline"></div>
      </section>
    `;
  }

  function bindThemeDetailView() {
    renderThemeTimeline();
    $('#renameThemeBtn').addEventListener('click', renameTheme);
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
            <div class="timeline-item">
              <div class="timeline-header">
                <span class="badge">Turn</span>
                <span class="timeline-time">${formatDate(turn.timestamp)} · ${escapeHtml(
                  turn.sessionId,
                )} #${turn.turnId}</span>
              </div>
              <div class="timeline-card">
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
      renderTopbar();
      renderThemeTimeline();
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

    return `
      <div class="folder-branch" data-folder="${escapeHtml(path)}">
        <div class="folder-row ${isSelected ? 'active' : ''}" style="padding-left:${12 + depth * 14}px">
          <span class="folder-row-main" data-folder="${escapeHtml(path)}">
            <span class="folder-icon">${isRoot ? '📁' : '📂'}</span>
            <span class="folder-name">${escapeHtml(node.name || 'root')}</span>
          </span>
          <span class="folder-actions">
            <button class="icon-btn" data-action="new-file" data-folder="${escapeHtml(path)}" title="New file">✚</button>
            <button class="icon-btn" data-action="rename" data-folder="${escapeHtml(path)}" title="Rename">✎</button>
            ${!isRoot ? `<button class="icon-btn" data-action="delete" data-folder="${escapeHtml(path)}" title="Delete">🗑</button>` : ''}
          </span>
        </div>
        ${childrenHtml}
      </div>
    `;
  }

  function renderFolderTree() {
    const tree = $('#folderTree');
    if (!tree) return;
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
      const tags = Array.isArray(file.tags) ? file.tags.join(', ') : '';
      composerHtml = `
        <div class="composer-card memory-composer">
          <div class="composer-header">
            <h2 class="composer-title">${escapeHtml(file.key)}</h2>
            <div class="composer-status" id="composerStatus"></div>
          </div>
          <div class="composer-body">
            <label class="field-label">Title</label>
            <input type="text" class="composer-input" id="memoryTitle" value="${escapeHtml(file.title || '')}" placeholder="Memory title" />
            <label class="field-label">Tags</label>
            <input type="text" class="composer-input" id="memoryTags" value="${escapeHtml(tags)}" placeholder="tag1, tag2" />
            <label class="field-label">Content</label>
            <textarea class="composer-textarea" id="memoryContent" placeholder="Write markdown content…">${escapeHtml(file.content || '')}</textarea>
          </div>
          <div class="composer-footer">
            <button class="btn btn-primary" id="saveMemoryBtn" type="button">Save</button>
            <button class="btn btn-secondary" id="deleteMemoryBtn" type="button">Delete</button>
          </div>
        </div>
      `;
    } else {
      composerHtml = `
        <div class="empty-state" style="min-height:180px">
          <div>
            <div style="font-size:18px;margin-bottom:8px">📝</div>
            <div>Select a file to edit, or choose a folder and create a new file.</div>
          </div>
        </div>
      `;
    }

    const folder = state.selectedMemoryFolder;
    const fileListHtml = folder
      ? `
        <div class="file-list-section">
          <div class="file-list-header">Files in ${escapeHtml(folder)}</div>
          ${renderFileList(folder)}
        </div>
      `
      : '';

    editor.innerHTML = composerHtml + fileListHtml;

    if (file) {
      $('#saveMemoryBtn').addEventListener('click', saveSelectedMemory);
      $('#deleteMemoryBtn').addEventListener('click', deleteSelectedMemory);
    }

    editor.querySelectorAll('.file-row').forEach((row) => {
      row.addEventListener('click', () => {
        selectFile(row.dataset.folder, row.dataset.key);
      });
    });
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

  async function loadMemories() {
    const [tree, folders] = await Promise.all([api('/api/memories'), listMemoryFolders()]);
    state.data.memories = tree;
    state.memoryFolders = folders;
    if (state.selectedMemoryFolder && !folders.includes(state.selectedMemoryFolder)) {
      state.selectedMemoryFolder = null;
      state.selectedMemoryFile = null;
    }
    if (state.currentView === 'memories') {
      renderFolderTree();
      renderMemoryEditor();
    }
  }

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

  function loadDataForView(view, theme) {
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
    }
  }

  function init() {
    state.sidebarCollapsed = getInitialCollapsed();
    updateCollapsedClass();

    $('#collapseBtn').addEventListener('click', toggleSidebar);

    window.addEventListener('hashchange', applyHash);
    window.addEventListener('popstate', applyHash);

    applyHash();
  }

  init();
})();
