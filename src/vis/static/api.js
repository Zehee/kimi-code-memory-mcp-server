export async function api(path, options = {}) {
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

export async function listMemoryFolders() {
  return api('/api/folders');
}

export async function writeMemory(folder, key, { content, title, tags }) {
  return api(`/api/memory/${encodeURIComponent(folder)}/${encodeURIComponent(key)}`, {
    method: 'POST',
    body: JSON.stringify({ content, title, tags }),
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
