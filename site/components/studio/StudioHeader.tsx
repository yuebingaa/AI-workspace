import type { RefObject } from "react";
import { studioRoleLabels, type StudioRole } from "@/core/permissions";

export type PreviewDevice = "desktop" | "mobile";

export interface StudioInterfaceOption {
  id: string;
  label: string;
  description: string;
}

interface StudioHeaderProps {
  interfaces: StudioInterfaceOption[];
  activeInterfaceId: string;
  device: PreviewDevice;
  canUndo: boolean;
  saveLabel: string;
  role: StudioRole;
  historyCount: number;
  historyButtonRef: RefObject<HTMLButtonElement | null>;
  publishButtonRef: RefObject<HTMLButtonElement | null>;
  pagesButtonRef: RefObject<HTMLButtonElement | null>;
  assistantButtonRef: RefObject<HTMLButtonElement | null>;
  onDeviceChange: (device: PreviewDevice) => void;
  onUndo: () => void;
  onRoleChange: (role: StudioRole) => void;
  onExportBackup: () => void;
  onChooseBackupFile: () => void;
  onInterfaceChange: (interfaceId: string) => void;
  onOpenHistory: () => void;
  onOpenPublish: () => void;
  onOpenPages: () => void;
  onOpenAssistant: () => void;
}

function InterfaceSwitcher({ interfaces, activeInterfaceId, compact = false, onInterfaceChange }: Pick<StudioHeaderProps, "interfaces" | "activeInterfaceId" | "onInterfaceChange"> & { compact?: boolean }) {
  const activeInterface = interfaces.find((item) => item.id === activeInterfaceId) ?? interfaces[0];

  return (
    <details className={`interface-switcher${compact ? " compact-interface-switcher" : ""}`}>
      <summary aria-label={compact ? "打开紧凑工作界面菜单" : "切换工作界面"}>
        {!compact && <span className="status-dot" />}
        <b>{compact ? "界面" : activeInterface?.label ?? "选择工作界面"}</b>
        <span className="interface-switcher-arrow" aria-hidden="true">⌄</span>
      </summary>
      <div role="menu" aria-label="工作界面列表">
        <header><b>切换工作界面</b><small>每个界面保留自己的页面和数据入口</small></header>
        {interfaces.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={item.id === activeInterfaceId ? "active" : ""}
            aria-current={item.id === activeInterfaceId ? "page" : undefined}
            onClick={(event) => {
              event.currentTarget.closest("details")?.removeAttribute("open");
              onInterfaceChange(item.id);
            }}
          >
            <span className="interface-option-mark">{item.label.slice(0, 1)}</span>
            <span><b>{item.label}</b><small>{item.description}</small></span>
            {item.id === activeInterfaceId && <span className="interface-option-current">当前</span>}
          </button>
        ))}
        <p>后续新增的业务界面会自动加入此列表。</p>
      </div>
    </details>
  );
}

export function StudioHeader({ interfaces, activeInterfaceId, device, canUndo, saveLabel, role, historyCount, historyButtonRef, publishButtonRef, pagesButtonRef, assistantButtonRef, onDeviceChange, onUndo, onRoleChange, onExportBackup, onChooseBackupFile, onInterfaceChange, onOpenHistory, onOpenPublish, onOpenPages, onOpenAssistant }: StudioHeaderProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">D</span>
        <span className="brand-name">DataCanvas AI</span>
        <small>AI 数据产品工作室</small>
      </div>
      <InterfaceSwitcher interfaces={interfaces} activeInterfaceId={activeInterfaceId} onInterfaceChange={onInterfaceChange} />
      <div className="top-actions">
        <InterfaceSwitcher compact interfaces={interfaces} activeInterfaceId={activeInterfaceId} onInterfaceChange={onInterfaceChange} />
        <div className="topbar-secondary-actions">
          <label className="role-switcher" title="仅用于前端交互演示，不影响服务端 Harness 授权">界面演示角色
            <select aria-label="界面演示角色，不影响服务端授权" value={role} onChange={(event) => onRoleChange(event.target.value as StudioRole)}>
              {(Object.keys(studioRoleLabels) as StudioRole[]).map((item) => <option key={item} value={item}>{studioRoleLabels[item]}</option>)}
            </select>
          </label>
          <button type="button" className={device === "desktop" ? "active" : ""} onClick={() => onDeviceChange("desktop")}>桌面</button>
          <button type="button" className={device === "mobile" ? "active" : ""} onClick={() => onDeviceChange("mobile")}>手机</button>
        </div>
        <button ref={pagesButtonRef} type="button" className="compact-panel-entry" onClick={onOpenPages}>页面</button>
        <button ref={assistantButtonRef} type="button" className="compact-panel-entry" onClick={onOpenAssistant}>AI 助手</button>
        <button ref={historyButtonRef} type="button" className="history-entry" onClick={onOpenHistory}>任务历史 <span>{historyCount}</span></button>
        <details className="backup-menu">
          <summary aria-label="打开工作区备份菜单">备份</summary>
          <div>
            <b>工作区备份</b>
            <p>保存页面、EDS 派生汇总、聊天上下文与审计记录；不包含原始工作簿、逐行明细或 API Key。</p>
            <button type="button" onClick={onExportBackup}>下载备份</button>
            <button type="button" onClick={onChooseBackupFile}>从文件恢复</button>
          </div>
        </details>
        <div className="topbar-secondary-actions">
          <button type="button" disabled={!canUndo} onClick={onUndo}>撤销</button>
          <span className="saved">{saveLabel}</span>
        </div>
        <details className="header-more-menu">
          <summary aria-label="打开更多工作区操作">更多</summary>
          <div>
            <b>更多工作区操作</b>
            <label className="role-switcher" title="仅用于前端交互演示，不影响服务端 Harness 授权">界面演示角色
              <select aria-label="紧凑菜单中的界面演示角色" value={role} onChange={(event) => onRoleChange(event.target.value as StudioRole)}>
                {(Object.keys(studioRoleLabels) as StudioRole[]).map((item) => <option key={item} value={item}>{studioRoleLabels[item]}</option>)}
              </select>
            </label>
            <span className="header-more-label">预览设备</span>
            <div className="header-more-devices">
              <button type="button" className={device === "desktop" ? "active" : ""} onClick={() => onDeviceChange("desktop")}>桌面</button>
              <button type="button" className={device === "mobile" ? "active" : ""} onClick={() => onDeviceChange("mobile")}>手机</button>
            </div>
            <button type="button" disabled={!canUndo} onClick={onUndo}>撤销上一步</button>
            <small>{saveLabel}</small>
          </div>
        </details>
        <button ref={publishButtonRef} type="button" className="publish" onClick={onOpenPublish}>发布</button>
      </div>
    </header>
  );
}
