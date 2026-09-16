import type { ReactNode, RefObject } from "react";
import { WorkspaceModeBar, type WorkspaceMode } from "./AgentWorkspace";

export interface StudioInterfaceOption { id: string; label: string; description: string; }
interface StudioHeaderProps {
  interfaces: StudioInterfaceOption[]; activeInterfaceId: string; saveLabel: string;
  mode: WorkspaceMode; navigation: ReactNode; assistantOpen: boolean;
  publishButtonRef: RefObject<HTMLButtonElement | null>; assistantButtonRef: RefObject<HTMLButtonElement | null>;
  onInterfaceChange: (id: string) => void; onModeChange: (mode: WorkspaceMode) => void;
  onOpenPublish: () => void; onOpenAssistant: () => void;
}

export function StudioHeader({ interfaces, activeInterfaceId, saveLabel, mode, navigation, assistantOpen, publishButtonRef, assistantButtonRef, onInterfaceChange, onModeChange, onOpenPublish, onOpenAssistant }: StudioHeaderProps) {
  const active = interfaces.find(item => item.id === activeInterfaceId);
  return <header className="topbar">
    <div className="studio-header-start">
      {navigation}
      <div className="brand"><span className="brand-mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 4h6a8 8 0 0 1 0 16H5V4Z" stroke="currentColor" strokeWidth="1.8" /><path d="M9 8h3v8H9z" fill="currentColor" /></svg></span><span className="brand-name">DataCanvas</span></div>
      <details className="interface-switcher">
        <summary aria-label="切换工作界面" title={active?.label}><b>{active?.label ?? "选择工作界面"}</b><span aria-hidden="true">⌄</span></summary>
        <div role="menu" aria-label="工作界面列表"><header><b>工作界面</b></header>{interfaces.map(item => <button key={item.id} type="button" role="menuitem" aria-current={item.id === activeInterfaceId ? "page" : undefined} className={item.id === activeInterfaceId ? "active" : ""} onClick={event => { event.currentTarget.closest("details")?.removeAttribute("open"); onInterfaceChange(item.id); }}><span className="interface-option-mark">▤</span><span><b>{item.label}</b><small>{item.description}</small></span>{item.id === activeInterfaceId && <span className="interface-option-current">当前</span>}</button>)}</div>
      </details>
    </div>
    <WorkspaceModeBar mode={mode} pageTitle={active?.label ?? "工作界面"} onChange={onModeChange} />
    <div className="top-actions">
      <span className="header-save-state" title={saveLabel}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg><span>{saveLabel}</span></span>
      {mode !== "agent" && <button ref={assistantButtonRef} type="button" className="studio-assistant-entry" aria-controls="studio-assistant-panel" aria-expanded={assistantOpen} onClick={onOpenAssistant}>AI 助手</button>}
      <button ref={publishButtonRef} type="button" className="publish" onClick={onOpenPublish}>发布<span aria-hidden="true"> ↗</span></button>
    </div>
  </header>;
}
