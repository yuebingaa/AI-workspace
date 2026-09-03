import type { RefObject } from "react";
import { studioRoleLabels, type StudioRole } from "@/core/permissions";

export type PreviewDevice = "desktop" | "mobile";

interface StudioHeaderProps {
  productName: string;
  device: PreviewDevice;
  canUndo: boolean;
  saveLabel: string;
  role: StudioRole;
  historyCount: number;
  historyButtonRef: RefObject<HTMLButtonElement | null>;
  onDeviceChange: (device: PreviewDevice) => void;
  onUndo: () => void;
  onRoleChange: (role: StudioRole) => void;
  onResetDemo: () => void;
  onOpenHistory: () => void;
}

export function StudioHeader({ productName, device, canUndo, saveLabel, role, historyCount, historyButtonRef, onDeviceChange, onUndo, onRoleChange, onResetDemo, onOpenHistory }: StudioHeaderProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">D</span>
        <span>DataCanvas AI</span>
        <small>AI 数据产品工作室</small>
      </div>
      <div className="project-name"><span className="status-dot" />{productName}<button type="button" aria-label="切换项目">⌄</button></div>
      <div className="top-actions">
        <label className="role-switcher" title="仅用于前端交互演示，不影响服务端 Harness 授权">界面演示角色
          <select aria-label="界面演示角色，不影响服务端授权" value={role} onChange={(event) => onRoleChange(event.target.value as StudioRole)}>
            {(Object.keys(studioRoleLabels) as StudioRole[]).map((item) => <option key={item} value={item}>{studioRoleLabels[item]}</option>)}
          </select>
        </label>
        <button type="button" className={device === "desktop" ? "active" : ""} onClick={() => onDeviceChange("desktop")}>桌面</button>
        <button type="button" className={device === "mobile" ? "active" : ""} onClick={() => onDeviceChange("mobile")}>手机</button>
        <button ref={historyButtonRef} type="button" className="history-entry" onClick={onOpenHistory}>任务历史 <span>{historyCount}</span></button>
        <button type="button" disabled={!canUndo} onClick={onUndo}>撤销</button>
        <button type="button" onClick={onResetDemo}>恢复演示数据</button>
        <span className="saved">{saveLabel}</span>
        <button type="button" className="publish">发布</button>
      </div>
    </header>
  );
}
