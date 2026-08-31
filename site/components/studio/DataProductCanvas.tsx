import type { AppSpec, LocalDataRuntime } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import type { StudioPuckData } from "@/adapters/puck";
import { AppSpecRenderer } from "./AppSpecRenderer";
import { PuckEditorBoundary } from "./PuckEditorBoundary";
import type { PreviewDevice } from "./StudioHeader";

export type CanvasMode = "edit" | "preview";

interface DataProductCanvasProps {
  appSpec: AppSpec;
  dataRuntime: LocalDataRuntime;
  role: StudioRole;
  activePageId: string;
  device: PreviewDevice;
  isPreviewing: boolean;
  canUndo: boolean;
  mode: CanvasMode;
  puckData: StudioPuckData | null;
  puckSessionKey: number;
  hasPuckPreview: boolean;
  onUndo: () => void;
  onModeChange: (mode: CanvasMode) => void;
  onPuckDataChange: (data: StudioPuckData) => void;
  onRequestPuckPreview: (data: StudioPuckData) => void;
  onApplyPuckPreview: () => void;
  onCancelPuckPreview: () => void;
}

export function DataProductCanvas({
  appSpec,
  dataRuntime,
  role,
  activePageId,
  device,
  isPreviewing,
  canUndo,
  mode,
  puckData,
  puckSessionKey,
  hasPuckPreview,
  onUndo,
  onModeChange,
  onPuckDataChange,
  onRequestPuckPreview,
  onApplyPuckPreview,
  onCancelPuckPreview,
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
      {mode === "edit" ? (
        <div className="puck-editor-stage">
          {puckData ? (
            <PuckEditorBoundary
              key={`${activePageId}-${puckSessionKey}`}
              data={puckData}
              dataSources={appSpec.dataSources}
              dataRuntime={dataRuntime}
              role={role}
              onChange={onPuckDataChange}
              onRequestPreview={onRequestPuckPreview}
            />
          ) : <div className="puck-loading">没有可编辑的页面数据</div>}
        </div>
      ) : (
        <div className={`device-stage ${device} ${isPreviewing ? "previewing" : ""}`}>
          <div className="dashboard">
            {page ? <AppSpecRenderer node={page.root} context={{ dataSources: appSpec.dataSources, dataRuntime }} /> : <div className="empty-canvas">当前没有可渲染页面</div>}
          </div>
        </div>
      )}
    </section>
  );
}
