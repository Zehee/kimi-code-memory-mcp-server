export const LS_KEY_COLLAPSED = 'kimi-memory-vis.sidebarCollapsed';
export const LS_KEY_AUTO_VIS = 'kimi-memory-vis.autoVis';

export const state = {
  currentView: 'workspace',
  currentTheme: null,
  currentSearchKey: null,
  sidebarCollapsed: false,
  sidebarOpenMobile: false,
  decisionsFilter: '',
  editingEssence: false,
  data: {
    workspace: null,
    themes: [],
    decisions: [],
    memories: null,
    searches: null,
    searchDetail: null,
    themeDetail: null,
  },
  memoryFolders: [],
  memoriesError: null,
  selectedMemoryFolder: null,
  selectedMemoryFile: null,
  editingMemory: false,
};
