import { Button } from "@/components/ui/button";
import { DropdownMenu } from "@radix-ui/themes";
import type { ReactNode, RefObject } from "react";
import { WorkspaceModeBar, type WorkspaceMode } from "./AgentWorkspace";

export interface StudioInterfaceOption { id: string; label: string; description: string; }
interface StudioHeaderProps {
  interfaces: StudioInterfaceOption[]; activeInterfaceId: string; saveLabel: string;
  mode: WorkspaceMode; navigation: ReactNode; assistantOpen: boolean;
  assistantButtonRef: RefObject<HTMLButtonElement | null>;
  onInterfaceChange: (id: string) => void; onModeChange: (mode: WorkspaceMode) => void;
  onOpenAssistant: () => void;
}

export function StudioHeader({ interfaces, activeInterfaceId, saveLabel, mode, navigation, assistantOpen, assistantButtonRef, onInterfaceChange, onModeChange, onOpenAssistant }: StudioHeaderProps) {
  const active = interfaces.find(item => item.id === activeInterfaceId);
  return <header className="topbar">
    <div className="studio-header-start">
      {navigation}
      <div className="brand"><span className="brand-mark" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 4h6a8 8 0 0 1 0 16H5V4Z" stroke="currentColor" strokeWidth="1.8" /><path d="M9 8h3v8H9z" fill="currentColor" /></svg></span><span className="brand-name">DataCanvas</span></div>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger><Button variant="ghost" className="interface-switcher-trigger" aria-label="切换工作界面" title={active?.label}>{active?.label ?? "选择工作界面"}<DropdownMenu.TriggerIcon /></Button></DropdownMenu.Trigger>
        <DropdownMenu.Content aria-label="工作界面列表" align="start">
          <DropdownMenu.Label>工作界面</DropdownMenu.Label>
          {interfaces.map(item => <DropdownMenu.Item key={item.id} aria-current={item.id === activeInterfaceId ? "page" : undefined} shortcut={item.id === activeInterfaceId ? "当前" : undefined} onSelect={() => onInterfaceChange(item.id)}>
            <span>{item.label}</span>
          </DropdownMenu.Item>)}
        </DropdownMenu.Content>
      </DropdownMenu.Root>
    </div>
    <WorkspaceModeBar mode={mode} pageTitle={active?.label ?? "工作界面"} onChange={onModeChange} />
    <div className="top-actions">
      <span className="header-save-state" title={saveLabel}><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 8 3 3 7-7" /></svg><span>{saveLabel}</span></span>
      {mode !== "agent" && <Button variant="ghost" ref={assistantButtonRef} type="button" className="studio-assistant-entry" aria-controls="studio-assistant-panel" aria-expanded={assistantOpen} onClick={onOpenAssistant}>AI 助手</Button>}
    </div>
  </header>;
}
