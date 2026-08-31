export type PreviewDevice = "desktop" | "mobile";

interface StudioHeaderProps {
  productName: string;
  device: PreviewDevice;
  canUndo: boolean;
  saveLabel: string;
  onDeviceChange: (device: PreviewDevice) => void;
  onUndo: () => void;
}

export function StudioHeader({ productName, device, canUndo, saveLabel, onDeviceChange, onUndo }: StudioHeaderProps) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark">D</span>
        <span>DataCanvas AI</span>
        <small>AI 数据产品工作室</small>
      </div>
      <div className="project-name"><span className="status-dot" />{productName}<button type="button" aria-label="切换项目">⌄</button></div>
      <div className="top-actions">
        <button type="button" className={device === "desktop" ? "active" : ""} onClick={() => onDeviceChange("desktop")}>桌面</button>
        <button type="button" className={device === "mobile" ? "active" : ""} onClick={() => onDeviceChange("mobile")}>手机</button>
        <button type="button" disabled={!canUndo} onClick={onUndo}>撤销</button>
        <span className="saved">{saveLabel}</span>
        <button type="button" className="publish">发布</button>
      </div>
    </header>
  );
}
