import { useEffect, useRef } from "react";
import type { AppSpec, DataRecipe, DataRow, DataSourceDefinition, LocalDataRuntime, QueryExecutionRecord } from "@/core/models";
import type { HarnessTableArtifact } from "@/core/harness/contracts";
import type { ExcelExportArtifact } from "@/core/exports/contracts";
import type { StudioRole } from "@/core/permissions";
import type { StudioPuckData } from "@/adapters/puck";
import { AppSpecRenderer } from "./AppSpecRenderer";
import { PuckEditorBoundary } from "./PuckEditorBoundary";
import type { PreviewDevice } from "./StudioHeader";
import { SpreadsheetWorkspace } from "./SpreadsheetWorkspace";
import { StudioArtwork } from "./StudioArtwork";

export type CanvasMode = "edit" | "preview";

export interface EdsCanvasReportOption {
  date: string;
  shift: string;
  selected: boolean;
}

export interface CanvasChangeFeedback {
  revision: string;
  status: "preview" | "applied";
  nodeIds: string[];
}

interface DataProductCanvasProps {
  hidden?: boolean;
  appSpec: AppSpec;
  dataRuntime: LocalDataRuntime;
  role: StudioRole;
  appSpecRevision: string;
  activePageId: string;
  device: PreviewDevice;
  isPreviewing: boolean;
  canUndo: boolean;
  mode: CanvasMode;
  puckData: StudioPuckData | null;
  puckSessionKey: number;
  hasPuckPreview: boolean;
  changeFeedback?: CanvasChangeFeedback | null;
  edsReportOptions?: EdsCanvasReportOption[];
  edsAnalysisRunning?: boolean;
  spreadsheetSource?: DataSourceDefinition;
  spreadsheetRows?: DataRow[];
  spreadsheetRecipe?: DataRecipe;
  spreadsheetAiResult?: HarnessTableArtifact;
  spreadsheetResultFocusRevision?: number;
  spreadsheetExportArtifact?: ExcelExportArtifact;
  onUndo: () => void;
  onModeChange: (mode: CanvasMode) => void;
  onPuckDataChange: (data: StudioPuckData) => void;
  onRequestPuckPreview: (data: StudioPuckData) => void;
  onApplyPuckPreview: () => void;
  onCancelPuckPreview: () => void;
  onEdsReportChange?: (reportIndex: number) => void;
  onAnalyzeEdsReports?: () => void;
  onImportSpreadsheet: () => void;
  onOpenSpreadsheetSource: () => void;
  onQueryExecuted: (record: QueryExecutionRecord) => void;
}

export function DataProductCanvas({
  hidden = false,
  appSpec,
  dataRuntime,
  role,
  appSpecRevision,
  activePageId,
  device,
  isPreviewing,
  canUndo,
  mode,
  puckData,
  puckSessionKey,
  hasPuckPreview,
  changeFeedback,
  edsReportOptions,
  edsAnalysisRunning,
  spreadsheetSource,
  spreadsheetRows = [],
  spreadsheetRecipe,
  spreadsheetAiResult,
  spreadsheetResultFocusRevision,
  spreadsheetExportArtifact,
  onUndo,
  onModeChange,
  onPuckDataChange,
  onRequestPuckPreview,
  onApplyPuckPreview,
  onCancelPuckPreview,
  onEdsReportChange,
  onAnalyzeEdsReports,
  onImportSpreadsheet,
  onOpenSpreadsheetSource,
  onQueryExecuted,
}: DataProductCanvasProps) {
  const page = appSpec.pages.find((candidate) => candidate.id === activePageId) ?? appSpec.pages[0];
  const canEdit = role !== "viewer";
  const isBlankWorkspace = Boolean(page && (page.root.children?.length ?? 0) === 0 && !spreadsheetSource);
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!changeFeedback) return;
    const frame = requestAnimationFrame(() => {
      const candidates = viewportRef.current?.querySelectorAll<HTMLElement>("[data-node-id]") ?? [];
      const target = Array.from(candidates).find((candidate) => (
        changeFeedback.nodeIds.includes(candidate.dataset.nodeId ?? "")
      ));
      const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      target?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center", inline: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [changeFeedback]);

  return (
    <section className="canvas-area" hidden={hidden}>
      <div className="canvas-toolbar">
        <div><button type="button" disabled={!canUndo} onClick={onUndo}>↶</button><button type="button" disabled>↷</button><span>100%</span></div>
        <div className="canvas-mode-switch" aria-label="画布模式">
          <button type="button" className={mode === "edit" ? "active" : ""} disabled={!canEdit} title={canEdit ? "进入可视化编辑" : "查看者只能预览"} onClick={() => onModeChange("edit")}>编辑</button>
          <button type="button" className={mode === "preview" ? "active" : ""} onClick={() => onModeChange("preview")}>预览</button>
        </div>
        <div>
          {isPreviewing && <span className="preview-badge">变更预览</span>}
          {mode === "edit" && puckData && <button type="button" className="canvas-primary" onClick={() => onRequestPuckPreview(puckData)}>生成变更预览</button>}
          {mode === "preview" && hasPuckPreview && <button type="button" onClick={onCancelPuckPreview}>{puckData ? "继续编辑" : "取消预览"}</button>}
          {mode === "preview" && hasPuckPreview && <button type="button" className="canvas-primary" onClick={onApplyPuckPreview}>应用编辑</button>}
          {!hasPuckPreview && mode === "preview" && <button type="button">分享</button>}
          <button type="button">•••</button>
        </div>
      </div>
      {edsReportOptions && edsReportOptions.length > 0 && (
        <div className="eds-canvas-switcher">
          <div><b>EDS 报告</b><small>{edsReportOptions.length > 1 ? "白班、夜班汇总已同时载入；切换后看板和 AI 当前数据同步更新。" : "当前派生汇总已载入，可交给 AI 进行只读诊断。"}</small></div>
          <div role="tablist" aria-label="EDS 看板班次">
            {edsReportOptions.map((option, index) => (
              <button
                type="button"
                role="tab"
                aria-selected={option.selected}
                key={`${option.date}-${option.shift}`}
                onClick={() => onEdsReportChange?.(index)}
              ><b>{option.shift}</b><small>{option.date}</small></button>
            ))}
          </div>
          <button
            type="button"
            className="eds-canvas-ai-action"
            disabled={edsAnalysisRunning}
            onClick={onAnalyzeEdsReports}
          >{edsAnalysisRunning ? "AI 正在分析…" : "AI 分析全部班次"}</button>
        </div>
      )}
      <div ref={viewportRef} className="canvas-design-viewport" tabIndex={0} aria-label="看板滚动区域">
        {changeFeedback && (
          <div className={`canvas-change-feedback ${changeFeedback.status}`} role="status">
            <i aria-hidden="true">{changeFeedback.status === "applied" ? "✓" : "✦"}</i>
            <span><b>{changeFeedback.status === "applied" ? "变更已应用" : "已定位变更组件"}</b><small>{changeFeedback.status === "applied" ? "正式页面已经更新" : "边框标记区域是本次预览内容"}</small></span>
          </div>
        )}
        {mode === "edit" ? (
          <div className="puck-editor-stage">
            {puckData ? (
              <PuckEditorBoundary
                key={`${activePageId}-${puckSessionKey}`}
                data={puckData}
                dataSources={appSpec.dataSources}
                dataRuntime={dataRuntime}
                role={role}
                pageId={activePageId}
                queryRevision={`puck:${puckSessionKey}`}
                onQueryExecuted={onQueryExecuted}
                onChange={onPuckDataChange}
                onRequestPreview={onRequestPuckPreview}
              />
            ) : <div className="puck-loading">没有可编辑的页面数据</div>}
          </div>
        ) : (
          <div className={`device-stage ${device} ${isPreviewing ? "previewing" : ""}${isBlankWorkspace ? " is-empty" : ""}`}>
            {isBlankWorkspace ? (
              <div className="empty-workspace-canvas">
                <div className="canvas-empty-copy">
                  <span className="canvas-empty-eyebrow">从数据到洞察</span>
                  <h2>{page?.title ?? "空白工作界面"}</h2>
                  <p>每一个好看板，都从一份数据开始。<br />导入表格，让 AI 帮你把发现变成清晰的图表。</p>
                  <button type="button" onClick={onImportSpreadsheet}>导入第一份表格 <span aria-hidden="true">↗</span></button>
                  <small>支持 CSV / XLSX · 可同时导入多份文件</small>
                </div>
                <StudioArtwork className="canvas-empty-art" />
              </div>
            ) : <div className="dashboard">
              {page ? <AppSpecRenderer node={page.root} context={{
                dataSources: appSpec.dataSources,
                dataRuntime,
                pageId: page.id,
                queryRevision: `canvas:${appSpecRevision}:${isPreviewing ? "preview" : "formal"}`,
                onQueryExecuted,
                ...(changeFeedback ? {
                  highlightedNodeIds: changeFeedback.nodeIds,
                  changeFeedback: changeFeedback.status,
                } : {}),
              }} /> : <div className="empty-canvas">当前没有可渲染页面</div>}
            </div>}
            <SpreadsheetWorkspace
              source={spreadsheetSource}
              rows={spreadsheetRows}
              recipe={spreadsheetRecipe}
              aiResult={spreadsheetAiResult}
              resultFocusRevision={spreadsheetResultFocusRevision}
              exportArtifact={spreadsheetExportArtifact}
              onImportSpreadsheet={onImportSpreadsheet}
              onOpenDataSource={onOpenSpreadsheetSource}
            />
          </div>
        )}
      </div>
    </section>
  );
}
