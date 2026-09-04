import type { AppSpec, LocalDataRuntime, QueryExecutionRecord } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import type { StudioPuckData } from "@/adapters/puck";
import { AppSpecRenderer } from "./AppSpecRenderer";
import { PuckEditorBoundary } from "./PuckEditorBoundary";
import type { PreviewDevice } from "./StudioHeader";

export type CanvasMode = "edit" | "preview";

export interface EdsCanvasReportOption {
  date: string;
  shift: string;
  selected: boolean;
}

interface DataProductCanvasProps {
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
  edsReportOptions?: EdsCanvasReportOption[];
  edsAnalysisRunning?: boolean;
  onUndo: () => void;
  onModeChange: (mode: CanvasMode) => void;
  onPuckDataChange: (data: StudioPuckData) => void;
  onRequestPuckPreview: (data: StudioPuckData) => void;
  onApplyPuckPreview: () => void;
  onCancelPuckPreview: () => void;
  onEdsReportChange?: (reportIndex: number) => void;
  onAnalyzeEdsReports?: () => void;
  onQueryExecuted: (record: QueryExecutionRecord) => void;
}

export function DataProductCanvas({
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
  edsReportOptions,
  edsAnalysisRunning,
  onUndo,
  onModeChange,
  onPuckDataChange,
  onRequestPuckPreview,
  onApplyPuckPreview,
  onCancelPuckPreview,
  onEdsReportChange,
  onAnalyzeEdsReports,
  onQueryExecuted,
}: DataProductCanvasProps) {
  const page = appSpec.pages.find((candidate) => candidate.id === activePageId) ?? appSpec.pages[0];
  const canEdit = role !== "viewer";

  return (
    <section className="canvas-area">
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
        <div className={`device-stage ${device} ${isPreviewing ? "previewing" : ""}`}>
          <div className="dashboard">
            {page ? <AppSpecRenderer node={page.root} context={{ dataSources: appSpec.dataSources, dataRuntime, pageId: page.id, queryRevision: `canvas:${appSpecRevision}:${isPreviewing ? "preview" : "formal"}`, onQueryExecuted }} /> : <div className="empty-canvas">当前没有可渲染页面</div>}
          </div>
        </div>
      )}
    </section>
  );
}
