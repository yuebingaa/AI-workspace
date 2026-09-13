import type { ReactNode, RefObject } from "react";
import type { AppSpec, DataProduct } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import { LEGACY_DEMO_PAGE_IDS } from "@/core/workspaces";

interface OriginalWorkbookItem {
  id: string;
  datasetId: string;
  file: File;
  aiRawAccess: boolean;
}

interface PageStructurePanelProps {
  dataProduct: DataProduct;
  appSpec: AppSpec;
  activePageId: string;
  onPageChange: (pageId: string) => void;
  onCreateInterface: () => void;
  role: StudioRole;
  onRenamePage: (pageId: string, currentTitle: string) => void;
  onDeletePage: (pageId: string, currentTitle: string) => void;
  activeDataSourceId: string;
  onOpenDataSource: (dataSourceId: string) => void;
  onUploadCsv: () => void;
  originalWorkbooks: OriginalWorkbookItem[];
  originalWorkbookButtonRef?: RefObject<HTMLButtonElement | null>;
  onOpenOriginalWorkbook: (workbookId: string) => void;
  onAnalyzeDataSource: (dataSourceId: string) => void;
  analysisRunning?: boolean;
  semanticModelsPanel?: ReactNode;
  dataBrowserPanel?: ReactNode;
}

export function PageStructurePanel({ dataProduct, appSpec, activePageId, onPageChange, onCreateInterface, role, onRenamePage, onDeletePage, activeDataSourceId, onOpenDataSource, onUploadCsv, originalWorkbooks, originalWorkbookButtonRef, onOpenOriginalWorkbook, onAnalyzeDataSource, analysisRunning = false, semanticModelsPanel, dataBrowserPanel }: PageStructurePanelProps) {
  const visibleNavigation = appSpec.navigation.filter((item) => !LEGACY_DEMO_PAGE_IDS.has(item.pageId));
  const visibleDatasets = dataProduct.datasets.filter((dataset) => dataset.shared || dataset.workspaceId === activePageId);

  return (
    <aside className="left-panel panel">
      {dataBrowserPanel}
      <div className="panel-title"><span>工作界面与数据</span><button type="button" disabled={role === "viewer"} onClick={onCreateInterface}>＋ 空白界面</button></div>
      {visibleNavigation.length > 0 && <nav className="page-list" aria-label="页面列表">
        {visibleNavigation.map((item) => (
          <div className="page-list-row" key={item.id}>
            <button type="button" className={activePageId === item.pageId ? "selected" : ""} onClick={() => onPageChange(item.pageId)}>
              <span className="icon">◉</span>{item.title}
            </button>
            {role !== "viewer" ? (
              <span className="page-structure-actions">
                <button type="button" className="page-structure-edit" aria-label={`重命名${item.title}`} title="重命名工作界面" onClick={() => onRenamePage(item.pageId, item.title)}>✎</button>
                <button type="button" className="page-structure-delete" aria-label={`删除${item.title}`} title={visibleNavigation.length <= 1 ? "至少保留一个工作界面" : "删除工作界面"} disabled={visibleNavigation.length <= 1} onClick={() => onDeletePage(item.pageId, item.title)}>×</button>
              </span>
            ) : null}
          </div>
        ))}
      </nav>}

      <div className="section-label data-source-section-head"><span>数据管理</span><div><button type="button" onClick={onUploadCsv}>导入表格</button></div></div>
      {visibleDatasets.length > 0 && <div className="data-source-card-list">
        {visibleDatasets.map((dataset) => (
          <article key={dataset.id} className={`data-card${activeDataSourceId === dataset.id ? " active" : ""}`}>
            <button type="button" className="data-card-main" onClick={() => onOpenDataSource(dataset.id)}>
              <div className="data-head"><span className="db">⌘</span><div><b>{dataset.name}</b><small>{dataset.rowCount.toLocaleString("zh-CN")} 行 · {dataset.columnCount} 列</small></div></div>
              <div className="quality"><span>数据质量</span><b>{dataset.qualityScore}%</b></div>
              <div className="quality-bar"><i style={{ width: `${dataset.qualityScore}%` }} /></div>
              {dataset.ephemeral && <small className="dataset-retention">临时数据 · {dataset.expiresAt ? `${new Date(dataset.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 到期` : "服务重启后失效"}</small>}
              <span className="data-card-open-label">查看字段、预览与记录 →</span>
            </button>
            <button type="button" className="data-card-ai-action" disabled={analysisRunning} onClick={() => onAnalyzeDataSource(dataset.id)}>{analysisRunning && activeDataSourceId === dataset.id ? "AI 分析中…" : "✦ AI 数据分析"}</button>
          </article>
        ))}
      </div>}

      {semanticModelsPanel}
      <div className="section-label">原始资料</div>
      <div className="original-workbook-list">
        {originalWorkbooks.map((workbook, index) => (
          <section className="original-workbook-card attached" aria-label={`原始表格 ${workbook.file.name}`} key={workbook.id}>
            <div><span className="original-workbook-icon">XLSX</span><div><b>{workbook.file.name}</b><small>{(workbook.file.size / 1024).toFixed(1)} KiB · 仅当前会话</small></div></div>
            <p>{workbook.aiRawAccess
              ? "可分页查看；AI 完整扫描已开放，相关提问会覆盖全部数据行。"
              : "可分页查看；AI 完整扫描未授权，原文件不进入本地持久化。"}</p>
            <div><button type="button" disabled={analysisRunning} onClick={() => onAnalyzeDataSource(workbook.datasetId)}>{analysisRunning && activeDataSourceId === workbook.datasetId ? "AI 分析中…" : "✦ AI 数据分析"}</button><button ref={index === 0 ? originalWorkbookButtonRef : undefined} type="button" onClick={() => onOpenOriginalWorkbook(workbook.id)}>打开原始表格</button></div>
          </section>
        ))}
        {originalWorkbooks.length === 0 && (
          <section className="original-workbook-card" aria-label="原始表格资料区">
            <div><span className="original-workbook-icon">XLSX</span><div><b>原始表格</b><small>导入 XLSX 后可在这里打开完整工作簿</small></div></div>
            <p>当前工作界面还没有会话级原始文件。</p>
          </section>
        )}
      </div>
      <button type="button" className="original-workbook-add" onClick={onUploadCsv}>{originalWorkbooks.length > 0 ? "继续导入表格" : "放置原始表格"}</button>
    </aside>
  );
}
