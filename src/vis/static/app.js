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
        <button class="btn btn-secondary btn-sm" id="refreshBtn" type="button" title="Refresh current view">↻ Refresh</button>
        <span class="status-badge"><span class="status-dot"></span>Online</span>
      </div>
    `;

    $('#menuToggle').addEventListener('click', toggleMobileSidebar);
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
          <button class="btn btn-secondary btn-sm" id="syncBtn" type="button">Sync index</button>
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
    $('#syncBtn').addEventListener('click', syncIndex);
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
    const btn = $('#syncBtn');
    const original = btn.textContent;
    btn.textContent = 'Syncing…';
    try {
      await api('/api/sync', { method: 'POST' });
      await loadWorkspace();
      btn.textContent = 'Synced';
    } catch (err) {
      btn.textContent = `Failed: ${err.message}`;
    }
    setTimeout(() => (btn.textContent = original), 1500);
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
        </div>
        <div class="memories-layout">
          <div class="memory-tree" id="memoryTree"></div>
          <div class="memory-preview" id="memoryPreview">
            <div class="empty-state">Select a memory to view its content.</div>
          </div>
        </div>
      </section>
    `;
  }

  function bindMemoriesView() {
    renderMemoryTree();
  }

  function renderMemoryNode(node, basePath = '') {
    const currentPath = basePath ? `${basePath}/${node.name}` : node.name;
    const filesHtml =
      node.files && node.files.length
        ? node.files
            .map(
              (file) => `
              <div class="tree-file" data-path="${escapeHtml(currentPath)}/${escapeHtml(file.key)}" data-key="${escapeHtml(
                file.key,
              )}" data-folder="${escapeHtml(currentPath)}">
                <span>📄</span>
                <span>${escapeHtml(file.title || file.key)}</span>
              </div>
            `,
            )
            .join('')
        : '';

    const childrenHtml =
      node.children && node.children.length
        ? node.children.map((child) => renderMemoryNode(child, currentPath)).join('')
        : '';

    const commentHtml = node.comment ? `<div class="tree-comment">${escapeHtml(node.comment)}</div>` : '';

    if (!node.children?.length && !node.files?.length) {
      return '';
    }

    return `
      <div class="tree-node">
        <div class="tree-folder">
          <span class="tree-folder-icon">▸</span>
          <span>${escapeHtml(node.name)}</span>
        </div>
        ${commentHtml}
        ${filesHtml}
        ${childrenHtml}
      </div>
    `;
  }

  function renderMemoryTree() {
    const tree = $('#memoryTree');
    if (!tree) return;
    if (!state.data.memories) {
      tree.innerHTML = '<div class="empty-state">Loading memories…</div>';
      return;
    }
    tree.innerHTML = renderMemoryNode(state.data.memories);

    tree.querySelectorAll('.tree-file').forEach((fileEl) => {
      fileEl.addEventListener('click', () => {
        tree.querySelectorAll('.tree-file').forEach((f) => f.classList.remove('active'));
        fileEl.classList.add('active');
        loadMemoryContent(fileEl.dataset.folder, fileEl.dataset.key);
      });
    });
  }

  async function loadMemoryContent(folder, key) {
    const preview = $('#memoryPreview');
    try {
      const memory = await api(`/api/memory/${encodeURIComponent(folder)}/${encodeURIComponent(key)}`);
      preview.innerHTML = `
        <div class="preview-header">
          <div>
            <h2 class="preview-title">${escapeHtml(memory.title || key)}</h2>
            <div class="preview-path">${escapeHtml(folder)}/${escapeHtml(key)}</div>
            <div class="tag-list" style="margin-top:8px">
              ${memory.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
            </div>
          </div>
        </div>
        <div class="preview-content">${escapeHtml(memory.content)}</div>
      `;
    } catch (err) {
      preview.innerHTML = `
        <div class="preview-header">
          <h2 class="preview-title">${escapeHtml(key)}</h2>
        </div>
        <div class="preview-content error">Failed to load memory: ${escapeHtml(err.message)}</div>
      `;
    }
  }

  async function loadMemories() {
    state.data.memories = await api('/api/memories');
    if (state.currentView === 'memories') renderMemoryTree();
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
