import { Button } from "@/components/ui/button";
import type { RefObject } from "react";
import { StudioIcon, type StudioIconName } from "./StudioIcon";

interface WorkspaceSidebarRailProps {
  toggleButtonRef: RefObject<HTMLButtonElement | null>;
  filesOpen: boolean;
  filesButtonRef: RefObject<HTMLButtonElement | null>;
  onExpand: () => void;
  onUploadCsv: () => void;
  onOpenOriginalWorkbook: () => void;
  onOpenDataBrowser?: () => void;
  onOpenModels?: () => void;
  onOpenConnections?: () => void;
  onOpenHistory?: () => void;
}

function RailButton({ label, tooltip = label, icon, buttonRef, expanded, controls, onClick }: { label: string; tooltip?: string; icon: StudioIconName; buttonRef?: RefObject<HTMLButtonElement | null>; expanded?: boolean; controls?: string; onClick: () => void }) {
  return (
    <Button variant="ghost" size="icon" ref={buttonRef} type="button" aria-label={label} aria-expanded={expanded} aria-controls={controls} data-tooltip={tooltip} onClick={onClick}>
      <StudioIcon name={icon} />
    </Button>
  );
}

export function WorkspaceSidebarRail({ toggleButtonRef, filesButtonRef, filesOpen, onExpand, onUploadCsv, onOpenOriginalWorkbook, onOpenDataBrowser, onOpenModels, onOpenConnections, onOpenHistory }: WorkspaceSidebarRailProps) {
  return (
    <nav className="workspace-sidebar-rail" aria-label="工作区快捷入口">
      {onOpenDataBrowser && <RailButton label="打开 Data Browser 数据浏览器" tooltip="数据浏览器" icon="data" onClick={onOpenDataBrowser} />}
      {onOpenConnections && <RailButton label="数据库连接" icon="connections" onClick={onOpenConnections} />}
      <RailButton label="原始文件" icon="files" buttonRef={filesButtonRef} expanded={filesOpen} controls={filesOpen ? "studio-files-panel" : undefined} onClick={onOpenOriginalWorkbook} />
      {onOpenModels && <RailButton label="语义模型" icon="models" onClick={onOpenModels} />}
      <RailButton buttonRef={toggleButtonRef} label="选择工作界面" tooltip="工作界面" icon="pages" onClick={onExpand} />
      {onOpenHistory && <RailButton label="任务与变更历史" icon="history" onClick={onOpenHistory} />}
      <span className="workspace-sidebar-rail-divider" />
      <RailButton label="导入表格" icon="upload" onClick={onUploadCsv} />
    </nav>
  );
}
