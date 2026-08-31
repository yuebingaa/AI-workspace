import type { AppSpec } from "@/core/models";
import { AppSpecRenderer } from "./AppSpecRenderer";
import type { PreviewDevice } from "./StudioHeader";

interface DataProductCanvasProps {
  appSpec: AppSpec;
  activePageId: string;
  device: PreviewDevice;
  isPreviewing: boolean;
  canUndo: boolean;
  onUndo: () => void;
}

export function DataProductCanvas({ appSpec, activePageId, device, isPreviewing, canUndo, onUndo }: DataProductCanvasProps) {
  const page = appSpec.pages.find((candidate) => candidate.id === activePageId) ?? appSpec.pages[0];

  return (
    <section className="canvas-area">
      <div className="canvas-toolbar">
        <div><button type="button" disabled={!canUndo} onClick={onUndo}>↶</button><button type="button" disabled>↷</button><span>100%</span></div>
        <div>{isPreviewing && <span className="preview-badge">变更预览</span>}<button type="button">预览</button><button type="button">分享</button><button type="button">•••</button></div>
      </div>
      <div className={`device-stage ${device} ${isPreviewing ? "previewing" : ""}`}>
        <div className="dashboard">
          {page ? <AppSpecRenderer node={page.root} /> : <div className="empty-canvas">当前没有可渲染页面</div>}
        </div>
      </div>
    </section>
  );
}
