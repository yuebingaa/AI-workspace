import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { studioRoleLabels, type StudioRole } from "@/core/permissions";
import type { StudioInterfaceOption } from "./StudioHeader";
import { StudioIcon, type StudioIconName } from "./StudioIcon";

export type WorkspaceNavigationAction = "pages" | "data" | "files" | "models" | "connections" | "history" | "api" | "agent" | "wecom" | "import" | "backup" | "restore" | "undo" | "clearConversation";
const tools: Array<{ id: WorkspaceNavigationAction; label: string; icon: StudioIconName; keywords: string }> = [
  { id: "data", label: "数据浏览器", icon: "data", keywords: "Data Browser 项目 数据表 资源 回收站" },
  { id: "pages", label: "工作界面与数据", icon: "pages", keywords: "页面 结构 组件 看板" },
  { id: "files", label: "原始文件", icon: "files", keywords: "Files XLSX 工作簿 表格" },
  { id: "models", label: "语义模型", icon: "models", keywords: "指标 维度 口径" },
  { id: "connections", label: "数据库连接", icon: "connections", keywords: "SQL 连接 环境 Environment" },
  { id: "history", label: "任务与变更历史", icon: "history", keywords: "History 版本 记录" },
];
const settings: typeof tools = [
  { id: "api", label: "AI 接口配置", icon: "settings", keywords: "API 模型 设置" },
  { id: "agent", label: "Agent 执行与插件", icon: "settings", keywords: "DSH Harness 执行器 引擎 插件 设置" },
  { id: "wecom", label: "企业微信连接", icon: "wecom", keywords: "连接 授权" },
  { id: "clearConversation", label: "清除上下文", icon: "restore", keywords: "清空 聊天 对话 会话 重置" },
  { id: "backup", label: "下载工作区备份", icon: "backup", keywords: "下载 备份 导出" },
  { id: "restore", label: "从备份文件恢复", icon: "restore", keywords: "恢复 导入" },
  { id: "undo", label: "撤销上一步", icon: "undo", keywords: "撤回 还原" },
];
export function WorkspaceNavigation({ buttonRef, interfaces, activeInterfaceId, projectName, saveLabel, role, canUndo, canClearConversation = false, resourceBusy, historyCount, onRoleChange, onInterfaceChange, onCreateInterface, onAction }: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  interfaces: StudioInterfaceOption[]; activeInterfaceId: string; projectName?: string; saveLabel: string;
  role: StudioRole; canUndo: boolean; resourceBusy: boolean; historyCount: number;
  canClearConversation?: boolean;
  onRoleChange: (role: StudioRole) => void; onInterfaceChange: (id: string) => void;
  onCreateInterface: (label: string) => void; onAction: (action: WorkspaceNavigationAction) => void;
}) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false), [name, setName] = useState("");
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null);
  const normalized = query.trim().toLocaleLowerCase();
  const matches = (value: string) => value.toLocaleLowerCase().includes(normalized);
  const items = (normalized ? [...tools, ...settings] : tools).filter(item => matches(`${item.label} ${item.keywords}`));
  const recent = interfaces.filter(item => matches(item.label));
  function close(restoreFocus = true) { setOpen(false); if (restoreFocus) buttonRef.current?.focus(); }
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  function run(action: WorkspaceNavigationAction) { close(); onAction(action); }
  function handleKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (!["ArrowDown", "ArrowUp"].includes(event.key) || event.target instanceof HTMLSelectElement) return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input, summary, select")].filter(el => el.getClientRects().length > 0);
    const current = controls.indexOf(document.activeElement as HTMLElement);
    event.preventDefault(); controls[(current + (event.key === "ArrowDown" ? 1 : controls.length - 1)) % controls.length]?.focus();
  }
  function actionButton(item: typeof tools[number]) {
    const disabled = ((item.id === "data" || item.id === "files") && resourceBusy) || (item.id === "undo" && !canUndo)
      || (item.id === "clearConversation" && !canClearConversation);
    return <button type="button" key={item.id} className="studio-navigation-item" disabled={disabled} onClick={() => run(item.id)}><StudioIcon name={item.icon} /><span>{item.label}</span>{item.id === "history" && historyCount > 0 && <small>{historyCount}</small>}</button>;
  }
  return <div className="studio-navigation" ref={root}>
    <button ref={buttonRef} type="button" className="studio-navigation-toggle" aria-label={open ? "关闭工作区菜单" : "打开工作区菜单"} title="工作区菜单" aria-expanded={open} aria-controls="studio-navigation-menu" onClick={() => { setQuery(""); setCreating(false); setOpen(!open); }}><StudioIcon name="menu" /></button>
    {open && <nav id="studio-navigation-menu" className="studio-navigation-menu" aria-label="工作区功能菜单" onKeyDown={handleKey} onBlur={event => {
      if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== buttonRef.current) close(false);
    }}>
      <header><span className="studio-navigation-avatar">D</span><div><b>{projectName ?? "我的工作区"}</b><small>{interfaces.find(item => item.id === activeInterfaceId)?.label ?? "选择工作界面"}</small></div><button type="button" aria-label="收起工作区菜单" onClick={() => close()}>×</button></header>
      <div className="studio-navigation-quick"><button type="button" disabled={role === "viewer"} aria-expanded={creating} onClick={() => setCreating(!creating)}><StudioIcon name="plus" />新建界面</button><button type="button" onClick={() => run("import")}><StudioIcon name="upload" />导入表格</button></div>
      {creating && <form className="studio-navigation-create" onSubmit={event => { event.preventDefault(); if (!name.trim()) return; onCreateInterface(name.trim()); setName(""); close(); }}><label htmlFor="navigation-interface-name">工作界面名称</label><div><input id="navigation-interface-name" maxLength={50} value={name} placeholder="例如：销售分析" onChange={event => setName(event.target.value)} /><button type="submit" disabled={!name.trim()}>创建</button></div></form>}
      <label className="studio-navigation-search"><StudioIcon name="search" /><input ref={search} aria-label="查找功能或工作界面" value={query} onChange={event => setQuery(event.target.value)} placeholder="查找功能或工作界面…" /><kbd>Esc</kbd></label>
      <div className="studio-navigation-scroll">
        <div className="studio-navigation-section"><span>{normalized ? "搜索结果" : "工作区工具"}</span>{items.map(actionButton)}{matches("可视化测试 图表 Lab") && <a className="studio-navigation-item" href="/visualization-lab" target="_blank" rel="noopener noreferrer" onClick={() => close()}><StudioIcon name="chart" /><span>可视化测试</span><small>↗</small></a>}</div>
        {recent.length > 0 && <div className="studio-navigation-section"><span>{normalized ? "工作界面" : "最近工作界面"}</span>{recent.slice(0, 5).map(item => <button type="button" key={item.id} className="studio-navigation-item" aria-current={item.id === activeInterfaceId ? "page" : undefined} onClick={() => { close(); onInterfaceChange(item.id); }}><StudioIcon name="pages" /><span>{item.label}</span>{item.id === activeInterfaceId && <small>当前</small>}</button>)}{recent.length > 5 && <button type="button" className="studio-navigation-item" onClick={() => run("pages")}>查看全部工作界面 →</button>}</div>}
        {normalized && items.length === 0 && recent.length === 0 && !matches("可视化测试 图表 Lab") && <p className="studio-navigation-empty">没有找到相关功能，试试“数据”或“历史”。</p>}
        {!normalized && <details className="studio-navigation-settings"><summary><StudioIcon name="settings" />设置与备份<span>⌄</span></summary><div>{settings.map(actionButton)}<p>工作区备份不包含原始工作簿、逐行明细或 API Key。本地项目数据请备份整个项目文件夹。</p><label>界面演示角色<select aria-label="界面演示角色，不影响服务端授权" value={role} onChange={event => onRoleChange(event.target.value as StudioRole)}>{(Object.keys(studioRoleLabels) as StudioRole[]).map(item => <option key={item} value={item}>{studioRoleLabels[item]}</option>)}</select></label></div></details>}
      </div><footer title={saveLabel}><span aria-hidden="true">✓</span><span>{saveLabel}</span></footer>
    </nav>}
  </div>;
}
