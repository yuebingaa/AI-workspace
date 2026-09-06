import type { RefObject } from "react";
import type { AppSpec, DataProduct } from "@/core/models";
import type { StudioRole } from "@/core/permissions";

const LEGACY_DEMO_PAGE_IDS = new Set(["page_home", "page_sales", "page_customers"]);
const LEGACY_DEMO_DATASET_IDS = new Set(["dataset_retail_orders"]);

interface PageStructurePanelProps {
  dataProduct: DataProduct;
  appSpec: AppSpec;
  activePageId: string;
  onPageChange: (pageId: string) => void;
  role: StudioRole;
  onRenamePage: (pageId: string, currentTitle: string) => void;
  activeDataSourceId: string;
  onOpenDataSource: (dataSourceId: string) => void;
  onUploadCsv: () => void;
  onOpenEdsAnalysis: () => void;
  edsAnalysisButtonRef?: RefObject<HTMLButtonElement | null>;
  originalWorkbook: File | null;
  aiRawAccess?: boolean;
  originalWorkbookButtonRef?: RefObject<HTMLButtonElement | null>;
  onOpenOriginalWorkbook: () => void;
}

export function PageStructurePanel({ dataProduct, appSpec, activePageId, onPageChange, role, onRenamePage, activeDataSourceId, onOpenDataSource, onUploadCsv, onOpenEdsAnalysis, edsAnalysisButtonRef, originalWorkbook, aiRawAccess = false, originalWorkbookButtonRef, onOpenOriginalWorkbook }: PageStructurePanelProps) {
  const visibleNavigation = appSpec.navigation.filter((item) => !LEGACY_DEMO_PAGE_IDS.has(item.pageId));
  const visibleDatasets = dataProduct.datasets.filter((dataset) => !LEGACY_DEMO_DATASET_IDS.has(dataset.id));

  return (
    <aside className="left-panel panel">
      <div className="panel-title"><span>EDS 工作区</span></div>
      {visibleNavigation.length > 0 && <nav className="page-list" aria-label="页面列表">
        {visibleNavigation.map((item) => (
          <div className="page-list-row" key={item.id}>
            <button type="button" className={activePageId === item.pageId ? "selected" : ""} onClick={() => onPageChange(item.pageId)}>
              <span className="icon">◉</span>{item.title}
            </button>
            {role === "admin" ? (
              <button type="button" className="page-structure-edit" title="重命名页面" onClick={() => onRenamePage(item.pageId, item.title)}>编辑</button>
            ) : null}
          </div>
        ))}
      </nav>}

      <div className="section-label data-source-section-head"><span>数据管理</span><div><button ref={edsAnalysisButtonRef} type="button" onClick={onOpenEdsAnalysis}>EDS 分析</button><button type="button" onClick={onUploadCsv}>上传 CSV</button></div></div>
      {visibleDatasets.length > 0 && <div className="data-source-card-list">
        {visibleDatasets.map((dataset) => (
          <button type="button" key={dataset.id} className={`data-card${activeDataSourceId === dataset.id ? " active" : ""}`} onClick={() => onOpenDataSource(dataset.id)}>
            <div className="data-head"><span className="db">⌘</span><div><b>{dataset.name}</b><small>{dataset.rowCount.toLocaleString("zh-CN")} 行 · {dataset.columnCount} 列</small></div></div>
            <div className="quality"><span>数据质量</span><b>{dataset.qualityScore}%</b></div>
            <div className="quality-bar"><i style={{ width: `${dataset.qualityScore}%` }} /></div>
            {dataset.ephemeral && <small className="dataset-retention">临时数据 · {dataset.expiresAt ? `${new Date(dataset.expiresAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 到期` : "服务重启后失效"}</small>}
            <span className="data-card-open-label">查看字段、预览与记录 →</span>
          </button>
        ))}
      </div>}

      <div className="section-label">原始资料</div>
      <section className={`original-workbook-card${originalWorkbook ? " attached" : ""}`} aria-label="原始表格资料区">
        <div><span className="original-workbook-icon">XLSX</span><div><b>{originalWorkbook ? originalWorkbook.name : "原始表格"}</b><small>{originalWorkbook ? `${(originalWorkbook.size / 1024).toFixed(1)} KiB · 仅当前会话` : "导入 EDS 并生成看板后放置在这里"}</small></div></div>
        <p>{originalWorkbook ? aiRawAccess
          ? "可分页查看；AI 完整扫描已开放，相关提问会覆盖全部数据行。"
          : "可分页查看；AI 完整扫描未授权，原文件不进入本地持久化。"
          : "当前没有会话级原始文件。已有派生看板不受影响。"}</p>
        <div>
          {originalWorkbook && <button ref={originalWorkbookButtonRef} type="button" onClick={onOpenOriginalWorkbook}>打开原始表格</button>}
          <button type="button" onClick={onOpenEdsAnalysis}>{originalWorkbook ? "重新导入" : "放置原始表格"}</button>
        </div>
      </section>
    </aside>
  );
}
