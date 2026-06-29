(() => {
  const state = {
    workspace: null,
    themes: [],
    decisions: [],
    memories: null,
    activeMemoryPath: null,
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
    el.textContent = message;
    el.className = `status ${type}`;
    if (message) {
      setTimeout(() => {
        el.textContent = '';
        el.className = 'status';
      }, 3000);
    }
  }

  function showView(name) {
    $$('.view').forEach((v) => v.classList.remove('view-active'));
    $(`#view-${name}`).classList.add('view-active');
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
    $('#sidebar')?.classList.remove('open');
  }

  function renderStats(stats) {
    const grid = $('#stats-grid');
    grid.innerHTML = Object.entries(stats)
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
    state.workspace = data;
    $('#workspace-id').textContent = data.id;
    renderStats(data.stats);
    $('#essence-editor').value = data.essence;
  }

  async function saveEssence() {
    const content = $('#essence-editor').value;
    const status = $('#essence-status');
    try {
      await api('/api/essence', {
        method: 'POST',
        body: JSON.stringify({ content }),
      });
      setStatus(status, 'Essence saved.', 'success');
    } catch (err) {
      setStatus(status, `Save failed: ${err.message}`, 'error');
    }
  }

  async function syncIndex() {
    const btn = $('#sync-btn');
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

  function renderThemes() {
    const grid = $('#themes-grid');
    if (state.themes.length === 0) {
      grid.innerHTML = '<div class="empty-state">No themes yet.</div>';
      return;
    }
    grid.innerHTML = state.themes
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
      card.addEventListener('click', () => openThemeModal(card.dataset.theme));
    });
  }

  async function loadThemes() {
    state.themes = await api('/api/themes');
    renderThemes();
  }

  async function openThemeModal(themeName) {
    const data = await api(`/api/themes/${encodeURIComponent(themeName)}`);
    $('#modal-title').textContent = data.displayName || data.theme;
    const body = $('#modal-body');

    body.innerHTML = `
      <div class="inline-edit">
        <input id="theme-display-name" type="text" value="${escapeHtml(
          data.displayName || data.theme,
        )}" placeholder="Display name" />
        <button id="theme-save-name" class="btn btn-primary btn-sm" type="button">Rename</button>
      </div>
      <div class="timeline" id="theme-timeline"></div>
    `;

    const timeline = $('#theme-timeline');
    if (data.items.length === 0) {
      timeline.innerHTML = '<div class="empty-state">No turns or memories linked to this theme.</div>';
    } else {
      timeline.innerHTML = data.items
        .map((item) => {
          if (item.type === 'turn') {
            const turn = item.data;
            const bullets =
              Array.isArray(turn.facts) && turn.facts.length
                ? `<ul class="decision-bullets">${turn.facts
                    .map((f) => `<li>${escapeHtml(f)}</li>`)
                    .join('')}</ul>`
                : '';
            const tags = [
              ...(turn.entities?.files || []),
              ...(Object.values(turn.categories || {}).flat()),
            ];
            return `
              <div class="timeline-item">
                <div class="timeline-dot"></div>
                <div class="timeline-time">${formatDate(turn.timestamp)} · Turn ${turn.turnId}</div>
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
            <div class="timeline-item">
              <div class="timeline-dot memory"></div>
              <div class="timeline-time">${formatDate(memory.timestamp)} · Memory</div>
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

    $('#theme-save-name').addEventListener('click', async () => {
      const displayName = $('#theme-display-name').value;
      try {
        await api(`/api/themes/${encodeURIComponent(themeName)}`, {
          method: 'POST',
          body: JSON.stringify({ displayName }),
        });
        await loadThemes();
        $('#modal-title').textContent = displayName;
      } catch (err) {
        alert(`Rename failed: ${err.message}`);
      }
    });

    openModal();
  }

  function renderDecisions() {
    const list = $('#decisions-list');
    if (state.decisions.length === 0) {
      list.innerHTML = '<div class="empty-state">No recent decisions.</div>';
      return;
    }
    list.innerHTML = state.decisions
      .map(
        (d) => `
        <div class="decision-card">
          <div class="decision-header">
            <h3 class="decision-title">Turn ${d.turnId} · ${escapeHtml(d.sessionId)}</h3>
            <span class="decision-time">${formatDate(d.timestamp)}</span>
          </div>
          <div class="decision-summary">${escapeHtml(d.summary)}</div>
          <ul class="decision-bullets">
            ${d.decisions.map((dec) => `<li>${escapeHtml(dec)}</li>`).join('')}
          </ul>
          <div class="tag-list">
            ${d.files.map((f) => `<span class="tag file">${escapeHtml(f)}</span>`).join('')}
            ${d.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('')}
          </div>
        </div>
      `,
      )
      .join('');
  }

  async function loadDecisions() {
    state.decisions = await api('/api/decisions?limit=50');
    renderDecisions();
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
              )}">
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

    const commentHtml = node.comment
      ? `<div class="tree-comment">${escapeHtml(node.comment)}</div>`
      : '';

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

  async function loadMemoryContent(filePath, key) {
    const folder = filePath.replace(new RegExp(`/${key}$`), '');
    const encodedFolder = encodeURIComponent(folder);
    const encodedKey = encodeURIComponent(key);
    const preview = $('#memory-preview');

    try {
      const memory = await api(`/api/memory/${encodedFolder}/${encodedKey}`);
      preview.innerHTML = `
        <div class="preview-header">
          <div>
            <h2 class="preview-title">${escapeHtml(memory.title || key)}</h2>
            <div class="preview-path">${escapeHtml(filePath)}</div>
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

  function renderMemories() {
    const tree = $('#memory-tree');
    if (!state.memories) {
      tree.innerHTML = '<div class="empty-state">Loading memories…</div>';
      return;
    }
    tree.innerHTML = renderMemoryNode(state.memories);

    tree.querySelectorAll('.tree-file').forEach((fileEl) => {
      fileEl.addEventListener('click', () => {
        tree.querySelectorAll('.tree-file').forEach((f) => f.classList.remove('active'));
        fileEl.classList.add('active');
        state.activeMemoryPath = fileEl.dataset.path;
        loadMemoryContent(fileEl.dataset.path, fileEl.dataset.key);
      });
    });
  }

  async function loadMemories() {
    state.memories = await api('/api/memories');
    renderMemories();
  }

  function openModal() {
    $('#modal').classList.add('open');
    $('#modal').setAttribute('aria-hidden', 'false');
  }

  function closeModal() {
    $('#modal').classList.remove('open');
    $('#modal').setAttribute('aria-hidden', 'true');
  }

  function init() {
    $$('.nav-item').forEach((link) => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const view = link.dataset.view;
        showView(view);
        history.pushState(null, '', `#${view}`);
        if (view === 'themes' && state.themes.length === 0) loadThemes();
        if (view === 'decisions' && state.decisions.length === 0) loadDecisions();
        if (view === 'memories' && !state.memories) loadMemories();
      });
    });

    $('#menu-toggle').addEventListener('click', () => {
      $('.sidebar').classList.toggle('open');
    });

    $('#save-essence').addEventListener('click', saveEssence);
    $('#sync-btn').addEventListener('click', syncIndex);
    $('#modal-close').addEventListener('click', closeModal);
    $('.modal-backdrop').addEventListener('click', closeModal);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    const initialView = location.hash.replace('#', '') || 'workspace';
    showView(initialView);

    loadWorkspace();
    if (initialView === 'themes') loadThemes();
    if (initialView === 'decisions') loadDecisions();
    if (initialView === 'memories') loadMemories();
  }

  init();
})();
