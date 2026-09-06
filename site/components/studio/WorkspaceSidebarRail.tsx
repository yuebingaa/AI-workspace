import type { RefObject } from "react";

interface WorkspaceSidebarRailProps {
  toggleButtonRef: RefObject<HTMLButtonElement | null>;
  hasOriginalWorkbook: boolean;
  onExpand: () => void;
  onOpenEdsAnalysis: () => void;
  onUploadCsv: () => void;
  onOpenOriginalWorkbook: () => void;
}

function RailIcon({ name }: { name: "panel" | "analysis" | "upload" | "workbook" }) {
  if (name === "panel") return <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M9 4v16" /></svg>;
  if (name === "analysis") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 19V9m7 10V5m7 14v-7" /><path d="M3 19h18" /></svg>;
  if (name === "upload") return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5" /><path d="M5 14v5h14v-5" /></svg>;
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v5h4M9 12h7m-7 4h7" /></svg>;
}

function RailButton({ label, icon, buttonRef, onClick }: { label: string; icon: "panel" | "analysis" | "upload" | "workbook"; buttonRef?: RefObject<HTMLButtonElement | null>; onClick: () => void }) {
  return (
    <button ref={buttonRef} type="button" aria-label={label} data-tooltip={label} onClick={onClick}>
      <RailIcon name={icon} />
    </button>
  );
}

export function WorkspaceSidebarRail({ toggleButtonRef, hasOriginalWorkbook, onExpand, onOpenEdsAnalysis, onUploadCsv, onOpenOriginalWorkbook }: WorkspaceSidebarRailProps) {
  return (
    <nav className="workspace-sidebar-rail" aria-label="工作区快捷入口">
      <RailButton buttonRef={toggleButtonRef} label="打开侧边栏" icon="panel" onClick={onExpand} />
      <span className="workspace-sidebar-rail-divider" />
      <RailButton label="EDS 分析" icon="analysis" onClick={onOpenEdsAnalysis} />
      <RailButton label="上传 CSV" icon="upload" onClick={onUploadCsv} />
      <RailButton label={hasOriginalWorkbook ? "打开原始表格" : "放置原始表格"} icon="workbook" onClick={onOpenOriginalWorkbook} />
    </nav>
  );
}
