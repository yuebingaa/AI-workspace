"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { deleteUploadedDataset, loadUploadedDataset } from "@/core/datasets/client";
import type { DatasetUploadResponse } from "@/core/datasets/contracts";
import { downloadProjectFile, loadProject, projectRequest } from "@/core/projects/client";
import { projectSessionSchema, type ProjectManifest } from "@/core/projects/contracts";
import { projectDatasetReferences } from "@/core/projects/references";
import type { SemanticModel } from "@/core/semantic/contracts";
import type { AppSpec } from "@/core/models";
import { useLocalProjects } from "./LocalProjectsProvider";

type Category = "tables" | "files" | "models" | "results" | "trash" | "projects";
const categories: Array<[Category, string, string]> = [["tables", "数据表", "▦"], ["files", "原始文件", "▤"], ["models", "语义模型", "◇"], ["results", "已保存结果", "◫"], ["trash", "回收站", "♧"], ["projects", "项目文件夹", "▱"]];
const recentSchema = z.object({ projects: z.array(z.object({ handle: z.string(), path: z.string(), name: z.string() })) });
export function DataBrowser({ onClose, onImport, onUse, onRemoved, onModel, models, canEdit, preview }: {
  onClose: () => void; onImport: () => void;
  onUse: (result: DatasetUploadResponse, destination: "preview" | "notebook" | "agent") => void;
  onRemoved: (id: string) => void; onModel: (id?: string) => void;
  models: SemanticModel[]; canEdit: boolean;
  preview?: AppSpec;
}) {
  const project = useLocalProjects();
  const [category, setCategory] = useState<Category>(project.session ? "tables" : "projects");
  const [manifest, setManifest] = useState<ProjectManifest | null>(project.session?.manifest ?? null);
  const [recent, setRecent] = useState<Array<{ handle: string; name: string; path: string }>>([]);
  const [path, setPath] = useState(""); const [name, setName] = useState("我的数据项目");
  const [search, setSearch] = useState(""); const [selectedId, setSelectedId] = useState("");
  const [rename, setRename] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  async function refresh() {
    if (project.session) setManifest((await loadProject(project.session.handle)).manifest);
    setRecent(recentSchema.parse(await projectRequest(undefined, null)).projects);
  }
  useEffect(() => { let cancelled = false;
    void Promise.all([project.session ? loadProject(project.session.handle) : Promise.resolve(null), projectRequest(undefined, null)]).then(([loaded, list]) => {
      if (!cancelled) { if (loaded) setManifest(loaded.manifest); setRecent(recentSchema.parse(list).projects); }
    }).catch((caught) => { if (!cancelled) setError(caught instanceof Error ? caught.message : "项目列表读取失败"); });
    const focused = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { cancelled = true; focused?.focus(); };
  }, [project.session]);
  async function act(operation: () => Promise<void>) {
    if (busy) return; setBusy(true); setError("");
    try { await operation(); } catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败"); } finally { setBusy(false); }
  }
  async function open(create: boolean, existingPath = path) {
    if (preview && !window.confirm("当前有尚未确认的看板预览。切换项目将放弃该预览，正式看板保持不变。继续吗？")) return;
    await project.flush();
    const session = projectSessionSchema.parse(await projectRequest(create ? { action: "create", path: existingPath, name } : { action: "open", path: existingPath }, null));
    await project.select(session); onClose();
  }
  const tables = (manifest?.tables ?? []).filter((entry) => category === "trash" ? Boolean(entry.deletedAt) : !entry.deletedAt && (category === "results" ? entry.kind === "result" : entry.kind === "table"))
    .filter((entry) => `${entry.descriptor.source.name} ${entry.descriptor.originalFileName}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const selected = tables.find((entry) => entry.descriptor.datasetId === selectedId) ?? tables[0];
  const uses = selected ? projectDatasetReferences(project.repository?.load() ?? manifest?.state ?? null, selected.descriptor.datasetId, selected.descriptor.recipe, preview) : [];
  async function use(destination: "preview" | "notebook" | "agent") {
    if (!selected) return;
    const data = await loadUploadedDataset(selected.descriptor.datasetId); onUse(data, destination); onClose();
  }
  async function remove() {
    if (!selected || !window.confirm(`将“${selected.descriptor.source.name}”移入项目回收站？原始文件不会删除，可从回收站恢复。`)) return;
    await project.flush();
    await deleteUploadedDataset(selected.descriptor.datasetId);
    onRemoved(selected.descriptor.datasetId); setSelectedId(""); await refresh();
  }
  const count = (key: Category) => key === "models" ? models.length : key === "files" ? manifest?.files.length ?? 0 : key === "projects" ? recent.length
    : (manifest?.tables ?? []).filter((table) => key === "trash" ? table.deletedAt : !table.deletedAt && table.kind === (key === "results" ? "result" : "table")).length;
  return <div className="data-browser-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="data-browser" ref={dialogRef} role="dialog" aria-modal="true" aria-label="Data Browser 数据浏览器" onKeyDown={(event) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key === "Tab") {
        const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]'));
        const first = nodes[0], last = nodes.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header className="data-browser-header"><div><span className="data-browser-mark">▦</span><div><small>LOCAL DATA WORKSPACE</small><h2>Data Browser <span>数据浏览器</span></h2></div></div>
        <div className="data-browser-actions"><button disabled={busy} onClick={() => { void act(refresh); }}>刷新</button><button aria-label="关闭数据浏览器" disabled={busy} onClick={onClose}>×</button></div></header>
      <div className="data-browser-project"><div><b>{project.session?.manifest.name ?? "尚未打开本地项目"}</b><p title={project.session?.path}>{project.session?.path ?? "把数据、语义模型和分析步骤保存在一个本地文件夹中"}</p></div><span className={`project-save-status ${project.status.state}`}>{project.session ? project.status.message : "本地单用户"}</span></div>
      {(error || project.status.state === "error") && <div className="data-browser-error" role="alert">{error || project.status.message}</div>}
      {project.status.state === "error" && <div className="data-browser-error"><p>自动保存已暂停。请先关闭此面板，用顶部“备份”导出未保存定义，再重新读取磁盘版本。该操作不会删除数据文件。</p><button disabled={busy} onClick={() => { if (window.confirm("放弃当前窗口尚未保存的工作台定义，重新读取磁盘版本？如需保留当前修改，请先取消并导出备份。")) void act(async () => { await project.reloadDiscardingChanges(); onClose(); }); }}>放弃未保存修改并重新打开</button></div>}
      <div className="data-browser-body"><nav aria-label="数据资源分类">{categories.map(([key, label, icon]) => <button key={key} aria-current={category === key ? "page" : undefined} onClick={() => { setCategory(key); setSearch(""); setSelectedId(""); }}><span>{icon}</span>{label}<small>{count(key)}</small></button>)}
        <p>文件在本机保存。<br />AI 只按所选数据和授权方式读取。</p></nav>
        <main className="data-browser-content">
          {category === "projects" ? <><div className="data-browser-section-title"><div><h3>本地项目文件夹</h3><p>创建空白项目，或打开已有 AgentCanvas 项目。当前临时工作区会保留。</p></div></div>
            <div className="project-folder-form"><label>项目名称<input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} maxLength={100} /></label>
              <label>项目文件夹绝对路径<input value={path} disabled={busy} onChange={(event) => setPath(event.target.value)} placeholder="例如 D:\AgentCanvasProjects\我的项目" /></label>
              <p>新建时留空，使用“文档 / AgentCanvas Projects”下的新文件夹。自选路径须为空文件夹，父目录须已存在。打开项目时填写包含 agentcanvas.project.json 的目录。</p>
              <div className="data-browser-actions"><button className="primary" disabled={busy || !canEdit || !name.trim()} onClick={() => { void act(() => open(true)); }}>新建本地项目</button><button disabled={busy || !path.trim()} onClick={() => { void act(() => open(false)); }}>打开已有项目</button>{project.session && <button disabled={busy} onClick={() => { if (preview && !window.confirm("退出项目将放弃尚未确认的看板预览，正式看板保持不变。继续吗？")) return; void act(async () => { await project.select(null); onClose(); }); }}>退出到临时工作区</button>}</div></div>
            <h4>最近项目</h4><div className="project-recent-list">{recent.map((entry) => <button key={entry.handle} disabled={busy} onClick={() => { void act(() => open(false, entry.path)); }}><b>{entry.name}</b><span>{entry.path}</span><i>打开 →</i></button>)}{!recent.length && <p className="data-browser-empty">还没有本地项目。从一个空白项目开始。</p>}</div>
          </> : !project.session ? <div className="data-browser-empty"><h3>先为数据选择一个家</h3><p>创建或打开本地项目后，文件和模型不再依赖浏览器缓存。</p><button onClick={() => setCategory("projects")}>选择项目文件夹 →</button></div>
          : category === "models" ? <><div className="data-browser-section-title"><div><h3>语义模型</h3><p>定义维度、指标和统计口径，与项目一起保存。</p></div><button className="primary" disabled={!canEdit || busy || !(manifest?.tables.some((table) => !table.deletedAt))} onClick={() => { onModel(); onClose(); }}>＋ 新建语义模型</button></div>
            <div className="project-model-grid">{models.map((model) => <button key={model.id} disabled={busy} onClick={() => { onModel(model.id); onClose(); }}><span>◇</span><b>{model.name}</b><p>{model.description || "暂无描述"}</p><small>v{model.version} · {model.dimensions.length} 个维度 · {model.measures.length} 个指标</small><em>编辑 / 删除 →</em></button>)}</div>{!models.length && <p className="data-browser-empty">导入数据表后，为常用分析建立统一口径。</p>}</>
          : category === "files" ? <><div className="data-browser-section-title"><div><h3>原始文件</h3><p>保留导入的 CSV / Excel 原件，不被分析步骤覆盖。</p></div><button className="primary" disabled={busy || !canEdit} onClick={() => { onClose(); onImport(); }}>＋ 导入文件</button></div>
            <div className="project-file-list">{manifest?.files.map((file) => <article key={file.id}><span className="project-file-type">{file.name.toLowerCase().endsWith(".xlsx") ? "XLSX" : "CSV"}</span><div><b>{file.name}</b><p>{Math.round(file.bytes / 1024)} KB · 关联 {file.datasetIds.length} 张表 · {new Date(file.savedAt).toLocaleString("zh-CN")}</p></div><button disabled={busy} onClick={() => { void act(() => downloadProjectFile(file.id, file.name)); }}>下载原件</button></article>)}</div>{!manifest?.files.length && <p className="data-browser-empty">在此项目中导入文件后，原件会出现在这里。</p>}</>
          : <><div className="data-browser-section-title"><div><h3>{category === "trash" ? "回收站" : category === "results" ? "已保存结果" : "项目数据表"}</h3><p>{category === "trash" ? "恢复时保留原有数据 ID。第一版不提供永久清空。" : category === "results" ? "Notebook 生成的看板结果快照，保存后可继续分析。" : "同一份数据可用于不同的工作界面、Notebook 和看板。"}</p></div>{category !== "trash" && <button className="primary" disabled={busy || !canEdit} onClick={() => { onClose(); onImport(); }}>＋ 导入表格</button>}</div>
            <input className="data-browser-search" aria-label="搜索数据表" placeholder="搜索表名或原始文件…" value={search} onChange={(event) => setSearch(event.target.value)} />
            {selected ? <div className="data-browser-table-layout"><div className="data-browser-table-list">{tables.map((table) => <button key={table.descriptor.datasetId} className={selected === table ? "selected" : ""} onClick={() => { setSelectedId(table.descriptor.datasetId); setRename(""); }}><span>▦</span><b>{table.descriptor.source.name}</b><small>{table.descriptor.source.rowCount.toLocaleString()} 行 · {table.descriptor.source.columnCount} 列</small></button>)}</div>
              <section className="data-browser-table-detail"><small>PROJECT DATASET</small><h3>{selected.descriptor.source.name}</h3><p className="data-browser-source">来源：{selected.descriptor.originalFileName}</p><div className="data-browser-metrics"><div><b>{selected.descriptor.source.rowCount.toLocaleString()}</b><span>数据行</span></div><div><b>{selected.descriptor.source.columnCount}</b><span>字段</span></div><div><b>{selected.descriptor.source.qualityScore}%</b><span>数据质量</span></div></div>
                <p className="project-retained">✓ 已保存到项目 · 不按临时保留期过期{selected.descriptor.aiAccessPolicy === "pending" ? " · AI 敏感数据授权待确认" : ""}</p>
                <div className="data-browser-actions">{category === "trash" ? <button className="primary" disabled={busy || !canEdit} onClick={() => { void act(async () => { await projectRequest({ action: "restoreTable", datasetId: selected.descriptor.datasetId }); onUse(await loadUploadedDataset(selected.descriptor.datasetId), "preview"); onClose(); }); }}>恢复数据表</button>
                  : <><button className="primary" disabled={busy} onClick={() => { void act(() => use("preview")); }}>预览数据 / 字段</button><button disabled={busy} onClick={() => { void act(() => use("notebook")); }}>用于 Notebook</button><button disabled={busy} onClick={() => { void act(() => use("agent")); }}>加入 AI 上下文</button></>}</div>
                <div className="data-browser-fields"><h4>字段目录</h4>{selected.descriptor.source.fields.map((field) => <div key={field.name}><span>{field.label}<small>{field.name}</small></span><code>{field.type}</code></div>)}</div>
                {category !== "trash" && <><label className="project-rename">重命名数据表<input aria-label="数据表新名称" placeholder={selected.descriptor.source.name} value={rename} maxLength={160} onChange={(event) => setRename(event.target.value)} /></label><div className="data-browser-actions"><button disabled={busy || !canEdit || !rename.trim()} onClick={() => { void act(async () => { await project.flush(); await projectRequest({ action: "renameTable", datasetId: selected.descriptor.datasetId, name: rename }); onUse(await loadUploadedDataset(selected.descriptor.datasetId), "preview"); onClose(); }); }}>保存名称</button><button className="danger" disabled={busy || !canEdit || uses.length > 0} onClick={() => { void act(remove); }}>移入回收站</button></div><p className="data-browser-reference-note">{uses.length ? `正在被引用：${uses.join("；")}。解除引用后才能删除。` : "没有发现已保存的分析引用；删除时服务端会再次检查。"}</p></>}
              </section></div> : <div className="data-browser-empty"><span>▦</span><h3>{category === "trash" ? "回收站为空" : "这里还没有数据"}</h3><p>{category === "results" ? "在 Notebook 生成看板预览后，结果快照会自动保存到这里。" : category === "trash" ? "移入回收站的数据可以恢复。" : "导入 CSV 或 Excel，让这个项目开始回答问题。"}</p></div>}
          </>}
        </main></div><footer className="data-browser-footer"><span>本地文件夹是真实存储 · 数据 ID 不随重命名变化</span><span>请定期备份整个项目 · 密钥不随项目保存</span></footer>
    </section></div>;
}
