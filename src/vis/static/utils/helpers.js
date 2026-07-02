import { state, LS_KEY_COLLAPSED } from '../state.js';

const $ = (sel) => document.querySelector(sel);

export function formatDate(iso) {
  if (!iso) return '–';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function iconKimiMemory() {
  return `<svg class="brand-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`;
}

export function iconPanelLeftClose() {
  return `<svg class="toggle-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 9l-3 3 3 3"/><line x1="14" y1="4" x2="14" y2="20"/></svg>`;
}

export function iconPanelLeftOpen() {
  return `<svg class="toggle-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 9l3 3-3 3"/><line x1="14" y1="4" x2="14" y2="20"/></svg>`;
}

export function setStatus(el, message, type = 'success') {
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

export function getInitialCollapsed() {
  const saved = localStorage.getItem(LS_KEY_COLLAPSED);
  if (saved !== null) return saved === 'true';
  return window.innerWidth < 768;
}

export function updateCollapsedClass() {
  $('#app').classList.toggle('sidebar-collapsed', state.sidebarCollapsed);
}

export function toggleSidebar() {
  state.sidebarCollapsed = !state.sidebarCollapsed;
  localStorage.setItem(LS_KEY_COLLAPSED, String(state.sidebarCollapsed));
  updateCollapsedClass();
}

export function toggleMobileSidebar() {
  state.sidebarOpenMobile = !state.sidebarOpenMobile;
  $('#sidebar').classList.toggle('open', state.sidebarOpenMobile);
}

const viewToSection = {
  workspace: 'workspace',
  themes: 'themes',
  'theme-detail': 'themes',
  searches: 'searches',
  'search-detail': 'searches',
  decisions: 'decisions',
  memories: 'memories',
  settings: 'settings',
};

export function sectionFor(view) {
  return viewToSection[view] || 'workspace';
}

export function workspaceFolderName() {
  const cwd = state.data.workspace?.cwd;
  if (!cwd) return 'Workspace';
  return (
    String(cwd)
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .pop() || 'Workspace'
  );
}

export function updateDocumentTitle() {
  const folder = workspaceFolderName();
  document.title = folder === 'Workspace' ? 'Kimi Memory' : `Kimi Memory - ${folder}`;
}
