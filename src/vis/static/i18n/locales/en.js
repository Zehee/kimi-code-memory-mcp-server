// ---- nav ----
export const en = {
  'nav.workspace': 'Workspace',
  'nav.themes': 'Themes',
  'nav.searches': 'Searches',
  'nav.decisions': 'Decisions',
  'nav.memories': 'Memories',
  'nav.settings': 'Settings',
  'nav.group.workspace': 'Workspace',
  'nav.group.analysis': 'Analysis',
  'nav.group.memory': 'Memory',
  'nav.group.system': 'System',
  'nav.expandSidebar': 'Expand sidebar',
  'nav.toggleSidebar': 'Toggle sidebar',
  'nav.toggleMenu': 'Toggle menu',

  // ---- topbar ----
  'topbar.syncIndex': 'Sync index',
  'topbar.syncIndexTitle': 'Reconcile index.json with filesystem',
  'topbar.refresh': '↻ Refresh',
  'topbar.refreshTitle': 'Refresh current view',
  'topbar.online': 'Online',
  'topbar.switchLanguage': 'Switch language',

  // ---- common ----
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.edit': 'Edit',
  'common.delete': 'Delete',
  'common.rename': 'Rename',
  'common.back': 'Back',
  'common.noSummary': 'No summary',

  // ---- workspace essence ----
  'essence.title': 'Workspace essence',
  'essence.editorPlaceholder': 'Workspace essence is empty. Write a short constitution here…',
  'essence.empty': 'No essence yet. Click Edit to write one.',
  'essence.saved': 'Essence saved.',

  // ---- stats ----
  'stats.loading': 'Loading stats…',
  'stats.memories': 'memories',
  'stats.themes': 'themes',
  'stats.refinedTurns': 'refined turns',
  'stats.sessions': 'sessions',

  // ---- sync ----
  'sync.syncing': 'Syncing…',
  'sync.synced': 'Synced',
  'sync.failed': 'Failed: {err}',

  // ---- themes list ----
  'themes.countOne': '{n} theme',
  'themes.countMany': '{n} themes',
  'themes.col.theme': 'Theme',
  'themes.col.created': 'Created',
  'themes.col.updated': 'Updated',
  'themes.col.turns': 'Turns',
  'themes.col.memories': 'Memories',
  'themes.col.actions': 'Actions',
  'themes.empty': 'No themes yet.',

  // ---- theme detail ----
  'theme.detailFallback': 'Theme',
  'theme.loading': 'Loading theme…',
  'theme.displayNamePlaceholder': 'Display name',
  'theme.timelineEmpty': 'No turns or memories linked to this theme.',
  'theme.untitledTurn': 'Untitled turn',
  'theme.turnMeta': '{sessionId} · turn {turnId}',
  'theme.memoryBadge': 'Memory',

  // ---- confirm dialogs ----
  'confirm.deleteTheme': 'Delete theme "{name}"?',
  'confirm.deleteSearchView': 'Delete search view "{key}"?',
  'confirm.deleteRefinedTurns':
    'Also delete the refined turns referenced by this view?\n\nCancel keeps the refined turns.',
  'confirm.deleteFolder': 'Delete folder "{path}" and all its contents? This cannot be undone.',
  'confirm.deleteMemoryFile': 'Delete "{path}"? This cannot be undone.',

  // ---- searches list ----
  'searches.title': 'Saved Searches',
  'searches.empty': 'No saved search views yet.',
  'searches.col.keywords': 'Keywords',
  'searches.col.created': 'Created',
  'searches.col.hits': 'Hits',
  'searches.col.clusters': 'Clusters',
  'searches.col.actions': 'Actions',

  // ---- search detail ----
  'searchDetail.title': 'Search Detail',
  'searchDetail.loading': 'Loading search view…',
  'searchDetail.noTurns': 'No refined turns.',
  'searchDetail.meta': '{hits} hits · {clusters} clusters · {createdAt}',

  // ---- decisions ----
  'decisions.title': 'Recent Decisions',
  'decisions.filterPlaceholder': 'Filter decisions…',
  'decisions.empty': 'No matching decisions.',
  'decisions.turnMeta': 'Turn {turnId} · {sessionId}',

  // ---- refined turn modal ----
  'modal.summary': 'Summary',
  'modal.facts': 'Facts',
  'modal.notes': 'Notes',
  'modal.noFacts': 'No facts',
  'modal.noNotes': 'No notes',

  // ---- memories ----
  'memories.newFolder': '+ New folder',
  'memories.loadingFolders': 'Loading folders…',
  'memories.selectPrompt': 'Select a folder or file to get started.',
  'memories.noFolders': 'No folders found.',
  'memories.newFileTitle': 'New file',
  'memories.loadFailed': 'Failed to load memories.',
  'memories.noFiles': 'No files in this folder.',
  'memories.selectFilePrompt': 'Select a file to view, or choose a folder and create a new file.',
  'memories.fieldTitle': 'Title',
  'memories.fieldTags': 'Tags',
  'memories.fieldContent': 'Content',
  'memories.titlePlaceholder': 'Memory title',
  'memories.tagsPlaceholder': 'tag1, tag2',
  'memories.contentPlaceholder': 'Write markdown content…',
  'memories.emptyFile': 'Empty file.',
  'memories.saved': 'Memory saved.',
  'memories.newFolderNamePrompt': 'New folder name:',
  'memories.renameFolderToPrompt': 'Rename folder to:',
  'memories.newKeyPrompt': 'New memory key:',

  // ---- errors ----
  'error.saveFailed': 'Save failed: {err}',
  'error.renameFailed': 'Rename failed: {err}',
  'error.deleteFailed': 'Delete failed: {err}',
  'error.loadTurnFailed': 'Failed to load turn: {err}',
  'error.loadMemoryFailed': 'Failed to load memory: {err}',
  'error.createFolderFailed': 'Create folder failed: {err}',
  'error.renameFolderFailed': 'Rename folder failed: {err}',
  'error.deleteFolderFailed': 'Delete folder failed: {err}',
  'error.deleteMemoryFailed': 'Delete memory failed: {err}',
  'error.createFolderFallback': 'Failed to create folder',
  'error.renameFolderFallback': 'Failed to rename folder',
  'error.deleteFolderFallback': 'Failed to delete folder',
  'error.saveMemoryFallback': 'Failed to save memory',
  'error.deleteMemoryFallback': 'Failed to delete memory',

  // ---- settings ----
  'settings.paths': 'Paths',
  'settings.workspaceId': 'Workspace ID',
  'settings.workspacePath': 'Workspace path',
  'settings.storeRoot': 'Store root',
  'settings.mcpConfigHint': 'MCP config hint',
  'settings.environment': 'Environment',
  'settings.autoVis': 'Auto-open dashboard (KIMI_MEMORY_AUTO_VIS)',
  'settings.autoVisHelp':
    'When enabled, the dashboard will open automatically on startup. This toggle stores a local preference; the actual environment variable must be set in your Kimi Code/MCP configuration.',
  'settings.links': 'Links',
  'settings.language': 'Language',

  // ---- document title ----
  docTitle: 'Kimi Memory',
  'docTitle.withFolder': 'Kimi Memory - {folder}',
};
