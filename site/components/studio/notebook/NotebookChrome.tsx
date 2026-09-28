import { Button } from "@/components/ui/button";
import { TextInput } from "@/components/ui/fields";
import { useState } from "react";
import type { DataSourceDefinition } from "@/core/models";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookTable } from "@/core/notebook/contracts";
import { notebookCellPresentation, notebookToolbarOrder } from "./cell-presentation";

export function NotebookIcon({ kind }: { kind: NotebookCell["kind"] | "ask" | "upload" }) {
  return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {kind === "sql" || kind === "python" ? <><path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-16-2 20" /></> :
      kind === "warehouseSql" || kind === "data" ? <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0" /></> :
      kind === "text" ? <><path d="M4 5h16M12 5v15M8 20h8M4 5v3m16-3v3" /></> :
      kind === "parameter" ? <><rect x="2" y="6" width="20" height="12" rx="2" /><path d="M6 10v4m-1-4h2m-2 4h2m4-2h7" /></> :
      kind === "chart" ? <><path d="M3 3v18h18M7 15l4-7 5 4 5-8" /></> :
      kind === "table" ? <><rect x="3" y="4" width="18" height="16" rx="1" /><path d="M3 9h18M3 14h18M9 4v16" /></> :
      kind === "transform" ? <><path d="M3 6h18M3 12h18M3 18h18" /><circle cx="8" cy="6" r="2" fill="var(--studio-surface)" /><circle cx="16" cy="12" r="2" fill="var(--studio-surface)" /><circle cx="10" cy="18" r="2" fill="var(--studio-surface)" /></> :
      kind === "semanticQuery" ? <><rect x="2" y="8" width="6" height="8" rx="1" /><rect x="16" y="2" width="6" height="6" rx="1" /><rect x="16" y="16" width="6" height="6" rx="1" /><path d="M8 12h4V5h4m-4 7v7h4" /></> :
      kind === "upload" ? <><path d="M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6" /></> :
      <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /></>}
  </svg>;
}

export function NotebookTitle({ name, disabled, onRename }: { name: string; disabled: boolean; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  return editing ? <form className="notebook-title-editor" onSubmit={(event) => {
    event.preventDefault();
    if (value.trim()) { onRename(value.trim()); setEditing(false); }
  }}>
    <TextInput aria-label="分析文档名称" autoFocus value={value} maxLength={160} required disabled={disabled}
      onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); setEditing(false); }
      }} />
    <Button variant="primary" type="submit" disabled={disabled || !value.trim()}>保存名称</Button>
    <Button variant="secondary" type="button" onClick={() => setEditing(false)}>取消</Button>
  </form> : <h1><Button variant="ghost" type="button" className="notebook-title" title="重命名分析文档" disabled={disabled}
    onClick={() => { setValue(name); setEditing(true); }}>{name}</Button></h1>;
}

export function NotebookInsertToolbar({ disabled, availableKinds = notebookToolbarOrder, onAdd }: {
  disabled: boolean;
  availableKinds?: readonly NotebookCell["kind"][];
  onAdd: (kind: NotebookCell["kind"]) => void;
}) {
  const available = new Set(availableKinds);
  return <div className="notebook-add" role="group" aria-label="添加分析单元">{notebookToolbarOrder.filter((kind) => available.has(kind)).map((kind) => {
    const { label, toolbarLabel, detail } = notebookCellPresentation[kind];
    return <Button size="small" variant="ghost" key={kind} type="button" disabled={disabled} aria-label={`＋ ${label}`} title={detail} onClick={() => onAdd(kind)}>
      <NotebookIcon kind={kind} /><span>{toolbarLabel}</span>
    </Button>;
  })}
  </div>;
}

export function NotebookStart({ sources, connectionCount, disabled, instruction, onInstructionChange, onAskAi, onImport, onBrowseData, onConnections, onAddSource }: {
  sources: DataSourceDefinition[]; connectionCount: number; disabled: boolean; instruction: string;
  onInstructionChange: (value: string) => void; onAskAi: () => void; onImport: () => void;
  onBrowseData: () => void; onConnections: () => void; onAddSource: (id: string) => void;
}) {
  return <section className="notebook-start" aria-label="开始分析">
    <div className="notebook-start-intro"><h2>从一个问题开始</h2><p>连接数据，把想法变成可重复的分析。</p></div>
    <form className="notebook-question" onSubmit={(event) => { event.preventDefault(); onAskAi(); }}>
      <NotebookIcon kind="ask" />
      <TextInput aria-label="Notebook 分析问题" placeholder="你想从数据中了解什么？" value={instruction} maxLength={1000} disabled={disabled}
        onChange={(event) => onInstructionChange(event.target.value)} />
      <Button variant="primary" type="submit" disabled={disabled} aria-label="在 AI 助手中继续" title="在 AI 助手中继续">↗</Button>
    </form>
    <div className="notebook-start-caption"><span>用自然语言描述问题</span><span>在 AI 助手中继续 ↗</span></div>
    <div className="notebook-data-entry">
      <div className="notebook-start-label">选择数据开始</div>
      <div className="notebook-data-options">
        <Button variant="secondary" type="button" disabled={disabled} onClick={onImport}><NotebookIcon kind="upload" /><span><b>上传文件</b><small>CSV / Excel</small></span><span aria-hidden="true">↗</span></Button>
        <Button variant="secondary" type="button" disabled={disabled} onClick={onBrowseData}><NotebookIcon kind="table" /><span><b>浏览数据</b><small>打开数据浏览器</small></span><span aria-hidden="true">↗</span></Button>
        <Button variant="secondary" type="button" disabled={disabled} onClick={onConnections}><NotebookIcon kind="data" /><span><b>数据库连接</b><small>{connectionCount ? `${connectionCount} 个连接可用` : "查看可用连接"}</small></span><span aria-hidden="true">↗</span></Button>
      </div>
      {sources.length > 0 && <div className="notebook-source-shortcuts"><span>直接使用 · {sources.length} 份</span>{sources.slice(0, 3).map((source) =>
        <Button variant="secondary" key={source.id} type="button" disabled={disabled} title={`${source.name} · ${source.rowCount} 行`} onClick={() => onAddSource(source.id)}><NotebookIcon kind="table" /><span>{source.name}</span></Button>)}
      </div>}
    </div>
  </section>;
}

export function NotebookFields({ fields }: { fields: NotebookTable["fields"] }) {
  const [search, setSearch] = useState("");
  const matches = fields.filter((field) => `${field.name} ${field.label}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <aside className="notebook-fields" aria-label="输入字段参考"><header><b>数据字段</b><span>{fields.length}</span></header>
    <TextInput aria-label="搜索输入字段" placeholder="搜索字段…" value={search} onChange={(event) => setSearch(event.target.value)} />
    {fields.length ? <ul>{matches.map((field, index) => <li key={`${field.name}-${index}`} title={`${field.name} · ${field.type}`}><span aria-hidden="true">{field.type === "number" ? "#" : field.type === "date" ? "◷" : "A"}</span><span>{field.label || field.name}{field.label !== field.name && <small>{field.name}</small>}</span></li>)}</ul> : <p>选择数据源或运行上游步骤后，字段会显示在这里。</p>}
    {fields.length > 0 && !matches.length && <p>没有匹配的字段</p>}
  </aside>;
}
