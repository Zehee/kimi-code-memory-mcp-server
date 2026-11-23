const TOKEN_STORAGE_KEY = 'kimi-memory-vis.token';

function readSessionToken() {
  try {
    return sessionStorage.getItem(TOKEN_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

function writeSessionToken(token) {
  try {
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Storage can be unavailable (private mode); the token then only lives in
    // memory for this page.
  }
}

function clearSessionToken() {
  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}

/**
 * The dashboard is opened with the bootstrap token in the URL fragment.
 * Fragments are never sent to the server, so the token is moved into
 * sessionStorage and removed from the address bar immediately.
 */
function consumeBootstrapToken() {
  let hash = '';
  try {
    hash = window.location.hash || '';
  } catch {
    return null;
  }
  if (!hash || hash.charAt(0) !== '#') return null;

  const raw = hash.slice(1);
  const separator = raw.indexOf('&');
  const head = separator === -1 ? raw : raw.slice(0, separator);
  const rest = separator === -1 ? '' : raw.slice(separator + 1);
  if (!head.startsWith('bootstrap=')) return null;

  let token = head.slice('bootstrap='.length);
  try {
    token = decodeURIComponent(token);
  } catch {
    // Keep the raw value when it is not valid percent encoding.
  }
  token = token.trim();
  if (token) {
    writeSessionToken(token);
  }

  const nextHash = rest ? `#${rest}` : '';
  try {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}${nextHash}`,
    );
  } catch {
    // Ignore browsers that refuse replaceState.
  }
  return token || null;
}

let authToken = readSessionToken();
const bootstrapToken = consumeBootstrapToken();
if (bootstrapToken) {
  authToken = bootstrapToken;
}

export function getAuthToken() {
  return authToken;
}

export async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) {
    clearSessionToken();
    authToken = null;
    throw new Error(
      '401: unauthorized. Open the dashboard from the MCP tool to start a new session.',
    );
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const error = new Error(`${res.status}: ${text}`);
    error.status = res.status;
    throw error;
  }
  return res.json();
}

export async function listMemoryFolders() {
  return api('/api/folders');
}

export async function writeMemory(
  folder,
  key,
  { content, title, tags, expectedRevision, expectedContentHash },
) {
  return api(`/api/memory/${encodeURIComponent(folder)}/${encodeURIComponent(key)}`, {
    method: 'POST',
    body: JSON.stringify({ content, title, tags, expectedRevision, expectedContentHash }),
  });
}

export async function deleteMemoryFile(folder, key) {
  return api(`/api/memory/${encodeURIComponent(folder)}/${encodeURIComponent(key)}`, {
    method: 'DELETE',
  });
}

export async function createMemoryFolder(folder) {
  return api('/api/folders', {
    method: 'POST',
    body: JSON.stringify({ folder }),
  });
}

export async function renameMemoryFolder(oldFolder, newFolder) {
  return api(`/api/folders/${encodeURIComponent(oldFolder)}/rename`, {
    method: 'POST',
    body: JSON.stringify({ newFolder }),
  });
}

export async function deleteMemoryFolder(folder, recursive) {
  return api(`/api/folders/${encodeURIComponent(folder)}?recursive=${recursive ? 'true' : 'false'}`, {
    method: 'DELETE',
  });
}

export async function deleteThemeApi(theme) {
  return api(`/api/themes/${encodeURIComponent(theme)}`, { method: 'DELETE' });
}

export async function deleteSearchViewApi(key, deleteRefinedTurns = false) {
  const qs = deleteRefinedTurns ? '?deleteRefinedTurns=true' : '';
  return api(`/api/searches/${encodeURIComponent(key)}${qs}`, { method: 'DELETE' });
}
