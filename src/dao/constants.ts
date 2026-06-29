/**
 * Shared types and constants for the index DAO layer.
 */

export interface IndexEntry {
  title?: string;
  tags?: string[];
  comment?: string;
}

export interface IndexData {
  version: string;
  meta: {
    lastSyncAt: string | null;
    structureHash: string | null;
  };
  index: Record<string, IndexEntry>;
}

export interface ReconcileOptions {
  folderComments?: Record<string, string>;
}

export interface ReconcileReport {
  scannedFiles: number;
  addedEntries: number;
  removedEntries: number;
  updatedEntries: number;
  addedFolders: number;
}

export interface ReconcileResult {
  synced: boolean;
  skipped: boolean;
  structureHash: string;
  report: ReconcileReport;
}

export const FALLBACK_FOLDER_COMMENTS: Record<string, string> = {
  memory: '完整记忆索引（按领域分组）',
  decisions: '关键产品/架构决策',
  rules: '协作规则与编码红线',
  knowledge: '项目知识',
  architecture: '架构与数据模型',
  frontend: '前端与渲染',
  product: '产品与版型',
  engineering: '工程实践',
  reference: '参考文档',
  notes: '日常速记',
  essence: '整理后的工作区精要',
};
