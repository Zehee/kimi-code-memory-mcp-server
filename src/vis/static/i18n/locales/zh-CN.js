// ---- nav ----
export const zhCN = {
  'nav.workspace': '工作区',
  'nav.themes': '主题',
  'nav.searches': '搜索视图',
  'nav.decisions': '决策',
  'nav.memories': '记忆',
  'nav.settings': '设置',
  'nav.group.workspace': '工作区',
  'nav.group.analysis': '分析',
  'nav.group.memory': '记忆',
  'nav.group.system': '系统',
  'nav.expandSidebar': '展开侧边栏',
  'nav.toggleSidebar': '切换侧边栏',
  'nav.toggleMenu': '切换菜单',

  // ---- topbar ----
  'topbar.syncIndex': '同步索引',
  'topbar.syncIndexTitle': '重新校验 index.json 与文件系统',
  'topbar.refresh': '↻ 刷新',
  'topbar.refreshTitle': '刷新当前视图',
  'topbar.online': '在线',
  'topbar.switchLanguage': '切换语言',

  // ---- common ----
  'common.save': '保存',
  'common.cancel': '取消',
  'common.edit': '编辑',
  'common.delete': '删除',
  'common.rename': '重命名',
  'common.back': '返回',
  'common.noSummary': '暂无摘要',

  // ---- workspace essence ----
  'essence.title': '工作区精要',
  'essence.editorPlaceholder': '工作区精要为空。在这里写一份简短的工作区约定…',
  'essence.empty': '还没有精要。点击“编辑”来撰写一份。',
  'essence.saved': '精要已保存。',

  // ---- stats ----
  'stats.loading': '统计加载中…',
  'stats.memories': '记忆',
  'stats.themes': '主题',
  'stats.refinedTurns': '精炼轮次',
  'stats.sessions': '会话',

  // ---- sync ----
  'sync.syncing': '同步中…',
  'sync.synced': '已同步',
  'sync.failed': '失败：{err}',

  // ---- themes list ----
  'themes.countOne': '{n} 个主题',
  'themes.countMany': '{n} 个主题',
  'themes.col.theme': '主题',
  'themes.col.created': '创建时间',
  'themes.col.updated': '更新时间',
  'themes.col.turns': '轮次',
  'themes.col.memories': '记忆',
  'themes.col.actions': '操作',
  'themes.empty': '还没有主题。',

  // ---- theme detail ----
  'theme.detailFallback': '主题',
  'theme.loading': '主题加载中…',
  'theme.displayNamePlaceholder': '显示名称',
  'theme.timelineEmpty': '该主题尚未关联任何轮次或记忆。',
  'theme.untitledTurn': '未命名轮次',
  'theme.turnMeta': '{sessionId} · 第 {turnId} 轮',
  'theme.memoryBadge': '记忆',

  // ---- confirm dialogs ----
  'confirm.deleteTheme': '确定删除主题“{name}”吗？',
  'confirm.deleteSearchView': '确定删除搜索视图“{key}”吗？',
  'confirm.deleteRefinedTurns': '是否同时删除该视图引用的精炼轮次？\n\n点击“取消”则保留精炼轮次。',
  'confirm.deleteFolder': '确定删除文件夹“{path}”及其全部内容吗？此操作无法撤销。',
  'confirm.deleteMemoryFile': '确定删除“{path}”吗？此操作无法撤销。',

  // ---- searches list ----
  'searches.title': '已保存的搜索视图',
  'searches.empty': '还没有保存的搜索视图。',
  'searches.col.keywords': '关键词',
  'searches.col.created': '创建时间',
  'searches.col.hits': '命中数',
  'searches.col.clusters': '簇数',
  'searches.col.actions': '操作',

  // ---- search detail ----
  'searchDetail.title': '搜索详情',
  'searchDetail.loading': '搜索视图加载中…',
  'searchDetail.noTurns': '暂无精炼轮次。',
  'searchDetail.meta': '{hits} 次命中 · {clusters} 个簇 · {createdAt}',

  // ---- decisions ----
  'decisions.title': '近期决策',
  'decisions.filterPlaceholder': '筛选决策…',
  'decisions.empty': '没有匹配的决策。',
  'decisions.turnMeta': '第 {turnId} 轮 · {sessionId}',

  // ---- refined turn modal ----
  'modal.summary': '摘要',
  'modal.facts': '事实',
  'modal.notes': '备注',
  'modal.noFacts': '暂无事实',
  'modal.noNotes': '暂无备注',

  // ---- memories ----
  'memories.newFolder': '+ 新建文件夹',
  'memories.loadingFolders': '文件夹加载中…',
  'memories.selectPrompt': '选择一个文件夹或文件开始。',
  'memories.noFolders': '未找到文件夹。',
  'memories.newFileTitle': '新建文件',
  'memories.loadFailed': '记忆加载失败。',
  'memories.noFiles': '此文件夹中没有文件。',
  'memories.selectFilePrompt': '选择一个文件查看，或选择一个文件夹后新建文件。',
  'memories.fieldTitle': '标题',
  'memories.fieldTags': '标签',
  'memories.fieldContent': '内容',
  'memories.titlePlaceholder': '记忆标题',
  'memories.tagsPlaceholder': '标签1, 标签2',
  'memories.contentPlaceholder': '在这里用 Markdown 书写内容…',
  'memories.emptyFile': '空文件。',
  'memories.saved': '记忆已保存。',
  'memories.newFolderNamePrompt': '新文件夹名称：',
  'memories.renameFolderToPrompt': '将文件夹重命名为：',
  'memories.newKeyPrompt': '新记忆 key：',

  // ---- errors ----
  'error.saveFailed': '保存失败：{err}',
  'error.renameFailed': '重命名失败：{err}',
  'error.deleteFailed': '删除失败：{err}',
  'error.loadTurnFailed': '轮次加载失败：{err}',
  'error.loadMemoryFailed': '记忆加载失败：{err}',
  'error.createFolderFailed': '创建文件夹失败：{err}',
  'error.renameFolderFailed': '重命名文件夹失败：{err}',
  'error.deleteFolderFailed': '删除文件夹失败：{err}',
  'error.deleteMemoryFailed': '删除记忆失败：{err}',
  'error.createFolderFallback': '创建文件夹失败',
  'error.renameFolderFallback': '重命名文件夹失败',
  'error.deleteFolderFallback': '删除文件夹失败',
  'error.saveMemoryFallback': '保存记忆失败',
  'error.deleteMemoryFallback': '删除记忆失败',

  // ---- settings ----
  'settings.paths': '路径',
  'settings.workspaceId': '工作区 ID',
  'settings.workspacePath': '工作区路径',
  'settings.storeRoot': '存储根目录',
  'settings.mcpConfigHint': 'MCP 配置提示',
  'settings.environment': '环境',
  'settings.autoVis': '自动打开仪表盘（KIMI_MEMORY_AUTO_VIS）',
  'settings.autoVisHelp':
    '启用后，仪表盘会在启动时自动打开。此开关仅保存本地偏好；实际的环境变量需要在你的 Kimi Code/MCP 配置中设置。',
  'settings.links': '链接',
  'settings.language': '界面语言',

  // ---- document title ----
  docTitle: 'Kimi Memory',
  'docTitle.withFolder': 'Kimi Memory - {folder}',
};
