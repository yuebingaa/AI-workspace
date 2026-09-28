"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { TextInput } from "@/components/ui/fields";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { deleteUploadedDataset, loadUploadedDataset } from "@/core/datasets/client";
import type { DatasetUploadResponse } from "@/core/datasets/contracts";
import { downloadProjectFile, loadProject, projectRequest, setProjectFileArchived } from "@/core/projects/client";
import { projectSessionSchema, type ProjectFile, type ProjectManifest } from "@/core/projects/contracts";
import { projectDatasetReferences } from "@/core/projects/references";
import type { SemanticModel } from "@/core/semantic/contracts";
import type { AppSpec, DataProduct } from "@/core/models";
import { notebookFileReferences } from "@/core/notebook/file-references";
import { useLocalProjects } from "./LocalProjectsProvider";
import { DatasetProvenance } from "../datasets/DatasetProvenance";
import { fileSize } from "../files/file-list";
import { FileDeleteDialog } from "../files/FileDeleteDialog";
import { projectCompatibilityFromError, type ProjectCompatibility } from "@/core/projects/compatibility";
import { PROJECT_COMPATIBILITY_SAVE_LABEL, ProjectCompatibilityNotice } from "./ProjectCompatibilityNotice";
import { ProjectInspectionPanel } from "./ProjectInspectionPanel";

type Category = "tables" | "files" | "models" | "results" | "trash" | "projects";
const categories: Array<[Category, string, string]> = [["tables", "数据表", "▦"], ["files", "原始文件", "▤"], ["models", "语义模型", "◇"], ["results", "已保存结果", "◫"], ["trash", "回收站", "♧"], ["projects", "项目文件夹", "▱"]];
const recentSchema = z.object({ projects: z.array(z.object({ handle: z.string(), path: z.string(), name: z.string() })) });
export function DataBrowser({ onClose, onImport, onUse, onRemoved, onFileRemoved, onModel, models, notebooks, canEdit, preview, initialCategory }: {
  onClose: () => void; onImport: () => void;
  onUse: (result: DatasetUploadResponse, destination: "preview" | "notebook" | "agent") => void;
  onRemoved: (id: string) => void; onModel: (id?: string) => void;
  onFileRemoved?: (datasetIds: string[]) => void;
  models: SemanticModel[]; canEdit: boolean;
  notebooks: DataProduct["notebooks"];
  preview?: AppSpec;
  initialCategory?: Category;
}) {
  const project = useLocalProjects();
  const [category, setCategory] = useState<Category>(initialCategory ?? (project.session ? "tables" : "projects"));
  const [manifest, setManifest] = useState<ProjectManifest | null>(project.session?.manifest ?? null);
  const [recent, setRecent] = useState<Array<{ handle: string; name: string; path: string }>>([]);
  const [path, setPath] = useState(""); const [name, setName] = useState("我的数据项目");
  const [search, setSearch] = useState(""); const [selectedId, setSelectedId] = useState("");
  const [rename, setRename] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [compatibility, setCompatibility] = useState<ProjectCompatibility | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ProjectFile | null>(null);
  const [inspectionPath, setInspectionPath] = useState<string | null>(null);
  const inspectionButtonRef = useRef<HTMLButtonElement>(null);
  const returnFromInspection = () => {
    setInspectionPath(null);
    requestAnimationFrame(() => inspectionButtonRef.current?.focus());
  };
  const dialogRef = useRef<HTMLDivElement>(null);
  async function refresh() {
    if (project.session) setManifest((await loadProject(project.session.handle)).manifest);
    setRecent(recentSchema.parse(await projectRequest(undefined, null)).projects);
  }
  useEffect(() => { let cancelled = false;
    void Promise.all([project.session ? loadProject(project.session.handle) : Promise.resolve(null), projectRequest(undefined, null)]).then(([loaded, list]) => {
      if (!cancelled) { if (loaded) setManifest(loaded.manifest); setRecent(recentSchema.parse(list).projects); }
    }).catch((caught) => { if (!cancelled) { setError(caught instanceof Error ? caught.message : "项目列表读取失败"); setCompatibility(projectCompatibilityFromError(caught)); } });
    const focused = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { cancelled = true; focused?.focus(); };
  }, [project.session]);
  async function act(operation: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(""); setCompatibility(null);
    try { await operation(); } catch (caught) { setError(caught instanceof Error ? caught.message : "操作失败"); setCompatibility(projectCompatibilityFromError(caught)); } finally { setBusy(false); }
  }
  async function retrySave() {
    if (!canEdit) return;
    setNotice("");
    await project.retrySave();
    setNotice("保存完成，修改已写入本地项目。");
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
  const files = (manifest?.files ?? []).filter((file) => Boolean(file.deletedAt) === (category === "trash") && file.name.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  async function changeFile(file: ProjectFile, archived: boolean) {
    if (!canEdit || !project.session) throw new Error("当前无法修改原件，请重新打开项目后重试。");
    setNotice("");
    await project.flush();
    const next = await setProjectFileArchived(project.session.handle, file.id, archived);
    setManifest(next.manifest);
    if (archived) onFileRemoved?.(file.datasetIds);
    setNotice(archived ? "文件已移入回收站，已导入的数据表仍可使用。" : "文件已恢复，可在原始文件栏查看和下载。依赖原件的步骤需手动重新运行。");
  }
  async function confirmFileRemoval(file: ProjectFile) {
    if (busy) throw new Error("请等待当前操作结束后重试。");
    setBusy(true); setError("");
    try { await changeFile(file, true); } finally { setBusy(false); }
  }
  const fileList = <div className="project-file-list">{files.map((file) => <article key={file.id} aria-label={`原始文件 ${file.name}`}><span className="project-file-type">{file.name.toLowerCase().endsWith(".xlsx") ? "XLSX" : "CSV"}</span><div><b>{file.name}</b><p>{fileSize(file.bytes)} · 关联 {file.datasetIds.length} 张表 · {new Date(file.deletedAt ?? file.savedAt).toLocaleString("zh-CN")}</p></div>
    {category === "trash" ? <Button variant="secondary" disabled={busy || !canEdit} aria-label={`恢复文件 ${file.name}`} onClick={() => void act(() => changeFile(file, false))}>恢复文件</Button> : <><Button variant="secondary" disabled={busy} onClick={() => void act(() => downloadProjectFile(file.id, file.name))}>下载原件</Button><Button variant="danger" className="danger" disabled={busy || !canEdit} aria-label={`删除文件 ${file.name}`} onClick={() => { setError(""); setPendingDelete(file); }}>移入回收站</Button></>}
  </article>)}</div>;
  const count = (key: Category) => key === "models" ? models.length : key === "files" ? (manifest?.files.filter((file) => !file.deletedAt).length ?? 0) : key === "projects" ? recent.length
    : (manifest?.tables ?? []).filter((table) => key === "trash" ? table.deletedAt : !table.deletedAt && table.kind === (key === "results" ? "result" : "table")).length + (key === "trash" ? manifest?.files.filter((file) => file.deletedAt).length ?? 0 : 0);
  const visibleCompatibility = error ? compatibility : project.status.state === "error" ? project.status.compatibility : null;
  return <Dialog open onOpenChange={open => { if (!open && !busy && !pendingDelete) onClose(); }}>
    <DialogContent maxWidth="1200px" className="data-browser" ref={dialogRef} aria-label="Data Browser 数据浏览器" aria-describedby={undefined}
      onEscapeKeyDown={event => { if (busy || pendingDelete) event.preventDefault(); }} onPointerDownOutside={event => { if (busy || pendingDelete) event.preventDefault(); }}>
      <header className="data-browser-header"><div><span className="data-browser-mark">▦</span><div><small>LOCAL DATA WORKSPACE</small><DialogTitle>Data Browser <span>数据浏览器</span></DialogTitle></div></div>
        <div className="data-browser-actions">{!inspectionPath && <Button variant="secondary" disabled={busy} onClick={() => { void act(refresh); }}>刷新</Button>}<Button variant="secondary" aria-label="关闭数据浏览器" disabled={busy} onClick={onClose}>×</Button></div></header>
      <div className="data-browser-project"><div><b>{project.session?.manifest.name ?? "尚未打开本地项目"}</b><p title={project.session?.path}>{project.session?.path ?? "把数据、语义模型和分析步骤保存在一个本地文件夹中"}</p></div><span className={`project-save-status ${project.status.state}`}>{project.session ? project.status.compatibility ? PROJECT_COMPATIBILITY_SAVE_LABEL : project.status.message : "本地单用户"}</span></div>
      {!inspectionPath && (visibleCompatibility ? <ProjectCompatibilityNotice issue={visibleCompatibility} />
        : (error || project.status.state === "error") && <div className="data-browser-error" role="alert">{error || project.status.message}</div>)}
      {!inspectionPath && notice && <p className="data-browser-reference-note" role="status">{notice}</p>}
      {!inspectionPath && project.status.state === "error" && <div className="data-browser-error">
        <p>自动保存已暂停，当前修改仍保留在此窗口。可先重试保存；如果磁盘版本已更新，将保留当前修改并提示冲突。需要重新打开时，请先关闭此面板，在左上角菜单的“设置与备份”中导出未保存定义，再放弃修改并读取磁盘版本。重新打开不会删除数据文件。</p>
        <div className="data-browser-actions"><Button variant="secondary" disabled={busy || !canEdit} onClick={() => void act(retrySave)}>重试保存</Button><Button variant="secondary" disabled={busy} onClick={() => { if (window.confirm("放弃当前窗口尚未保存的工作台定义，重新读取磁盘版本？如需保留当前修改，请先取消并导出备份。")) void act(async () => { await project.reloadDiscardingChanges(); onClose(); }); }}>放弃未保存修改并重新打开</Button></div>
      </div>}
      <div className={`data-browser-body${inspectionPath ? " is-project-inspection" : ""}`}>{!inspectionPath && <nav aria-label="数据资源分类">{categories.map(([key, label, icon]) => <Button variant="ghost" key={key} aria-current={category === key ? "page" : undefined} onClick={() => { setCategory(key); setSearch(""); setSelectedId(""); }}><span>{icon}</span>{label}<small>{count(key)}</small></Button>)}
        <p>文件在本机保存。<br />AI 只按所选数据和授权方式读取。</p></nav>}
        <main className="data-browser-content">
          {inspectionPath ? <ProjectInspectionPanel key={inspectionPath} path={inspectionPath} onBack={returnFromInspection} />
          : category === "projects" ? <><div className="data-browser-section-title"><div><h3>本地项目文件夹</h3><p>创建空白项目，或打开已有 AgentCanvas 项目。当前临时工作区会保留。</p></div></div>
            <div className="project-folder-form"><label>项目名称<TextInput value={name} disabled={busy} onChange={(event) => setName(event.target.value)} maxLength={100} /></label>
              <label>项目文件夹绝对路径<TextInput value={path} disabled={busy} onChange={(event) => setPath(event.target.value)} placeholder="例如 D:\AgentCanvasProjects\我的项目" /></label>
              <p>新建时留空，使用“文档 / AgentCanvas Projects”下的新文件夹。自选路径须为空文件夹，父目录须已存在。打开项目时填写包含 agentcanvas.project.json 的目录。</p>
              <div className="data-browser-actions"><Button variant="primary" className="primary" disabled={busy || !canEdit || !name.trim()} onClick={() => { void act(() => open(true)); }}>新建本地项目</Button><Button variant="secondary" disabled={busy || !path.trim()} onClick={() => { void act(() => open(false)); }}>打开已有项目</Button><Button variant="secondary" ref={inspectionButtonRef} disabled={busy || !path.trim()} onClick={() => setInspectionPath(path.trim())}>只读查看步骤</Button>{project.session && <Button variant="secondary" disabled={busy} onClick={() => { if (preview && !window.confirm("退出项目将放弃尚未确认的看板预览，正式看板保持不变。继续吗？")) return; void act(async () => { await project.select(null); onClose(); }); }}>退出到临时工作区</Button>}</div></div>
            <h4>最近项目</h4><div className="project-recent-list">{recent.map((entry) => <Button variant="secondary" key={entry.handle} disabled={busy} onClick={() => { void act(() => open(false, entry.path)); }}><b>{entry.name}</b><span>{entry.path}</span><i>打开 →</i></Button>)}{!recent.length && <p className="data-browser-empty">还没有本地项目。从一个空白项目开始。</p>}</div>
          </> : !project.session ? <div className="data-browser-empty"><h3>先为数据选择一个家</h3><p>创建或打开本地项目后，文件和模型不再依赖浏览器缓存。</p><Button variant="secondary" onClick={() => setCategory("projects")}>选择项目文件夹 →</Button></div>
          : category === "models" ? <><div className="data-browser-section-title"><div><h3>语义模型</h3><p>定义维度、指标和统计口径，与项目一起保存。</p></div><Button variant="primary" className="primary" disabled={!canEdit || busy || !(manifest?.tables.some((table) => !table.deletedAt))} onClick={() => { onModel(); onClose(); }}>＋ 新建语义模型</Button></div>
            <div className="project-model-grid">{models.map((model) => <Button variant="secondary" key={model.id} disabled={busy} onClick={() => { onModel(model.id); onClose(); }}><span>◇</span><b>{model.name}</b><p>{model.description || "暂无描述"}</p><small>v{model.version} · {model.dimensions.length} 个维度 · {model.measures.length} 个指标</small><em>编辑 / 删除 →</em></Button>)}</div>{!models.length && <p className="data-browser-empty">导入数据表后，为常用分析建立统一口径。</p>}</>
          : category === "files" ? <><div className="data-browser-section-title"><div><h3>原始文件</h3><p>保留导入的 CSV / Excel 原件，不被分析步骤覆盖。</p></div><Button variant="primary" className="primary" disabled={busy || !canEdit} onClick={() => { onClose(); onImport(); }}>＋ 导入文件</Button></div>
            {fileList}{!files.length && <p className="data-browser-empty">在此项目中导入文件后，原件会出现在这里。</p>}</>
          : <><div className="data-browser-section-title"><div><h3>{category === "trash" ? "回收站" : category === "results" ? "已保存结果" : "项目数据表"}</h3><p>{category === "trash" ? "恢复时保留原有数据 ID。第一版不提供永久清空。" : category === "results" ? "Notebook 生成的看板结果快照，保存后可继续分析。" : "同一份数据可用于不同的工作界面、Notebook 和看板。"}</p></div>{category !== "trash" && <Button variant="primary" className="primary" disabled={busy || !canEdit} onClick={() => { onClose(); onImport(); }}>＋ 导入表格</Button>}</div>
            <TextInput className="data-browser-search" aria-label="搜索数据表" placeholder="搜索表名或原始文件…" value={search} onChange={(event) => setSearch(event.target.value)} />
            {category === "trash" && files.length > 0 && <><h4>原始文件</h4>{fileList}{selected && <h4>数据表</h4>}</>}
            {selected ? <div className="data-browser-table-layout"><div className="data-browser-table-list">{tables.map((table) => <Button variant="secondary" key={table.descriptor.datasetId} className={selected === table ? "selected" : ""} onClick={() => { setSelectedId(table.descriptor.datasetId); setRename(""); }}><span>▦</span><b>{table.descriptor.source.name}</b><small>{table.descriptor.source.rowCount.toLocaleString()} 行 · {table.descriptor.source.columnCount} 列</small></Button>)}</div>
              <section className="data-browser-table-detail"><small>PROJECT DATASET</small><h3>{selected.descriptor.source.name}</h3><p className="data-browser-source">来源：{selected.descriptor.originalFileName}</p><div className="data-browser-metrics"><div><b>{selected.descriptor.source.rowCount.toLocaleString()}</b><span>数据行</span></div><div><b>{selected.descriptor.source.columnCount}</b><span>字段</span></div><div><b>{selected.descriptor.source.qualityScore}%</b><span>数据质量</span></div></div>
                <p className="project-retained">项目持久数据 · 读取时校验文件 · 不按临时保留期过期{selected.descriptor.aiAccessPolicy === "pending" ? " · AI 敏感数据授权待确认" : ""}</p>
                <DatasetProvenance provenance={selected.descriptor.provenance} />
                <div className="data-browser-actions">{category === "trash" ? <Button variant="primary" className="primary" disabled={busy || !canEdit} onClick={() => { void act(async () => { await projectRequest({ action: "restoreTable", datasetId: selected.descriptor.datasetId }); onUse(await loadUploadedDataset(selected.descriptor.datasetId), "preview"); onClose(); }); }}>恢复数据表</Button>
                  : <><Button variant="primary" className="primary" disabled={busy} onClick={() => { void act(() => use("preview")); }}>预览数据 / 字段</Button><Button variant="secondary" disabled={busy} onClick={() => { void act(() => use("notebook")); }}>用于 Notebook</Button><Button variant="secondary" disabled={busy} onClick={() => { void act(() => use("agent")); }}>加入 AI 上下文</Button></>}</div>
                <div className="data-browser-fields"><h4>字段目录</h4>{selected.descriptor.source.fields.map((field) => <div key={field.name}><span>{field.label}<small>{field.name}</small></span><code>{field.type}</code></div>)}</div>
                {category !== "trash" && <><label className="project-rename">重命名数据表<TextInput aria-label="数据表新名称" placeholder={selected.descriptor.source.name} value={rename} maxLength={160} onChange={(event) => setRename(event.target.value)} /></label><div className="data-browser-actions"><Button variant="secondary" disabled={busy || !canEdit || !rename.trim()} onClick={() => { void act(async () => { await project.flush(); await projectRequest({ action: "renameTable", datasetId: selected.descriptor.datasetId, name: rename }); onUse(await loadUploadedDataset(selected.descriptor.datasetId), "preview"); onClose(); }); }}>保存名称</Button><Button variant="danger" className="danger" disabled={busy || !canEdit || uses.length > 0} onClick={() => { void act(remove); }}>移入回收站</Button></div><p className="data-browser-reference-note">{uses.length ? `正在被引用：${uses.join("；")}。解除引用后才能删除。` : "没有发现已保存的分析引用；删除时服务端会再次检查。"}</p></>}
              </section></div> : (category !== "trash" || !files.length) && <div className="data-browser-empty"><span>▦</span><h3>{category === "trash" ? "回收站为空" : "这里还没有数据"}</h3><p>{category === "results" ? "在 Notebook 生成看板预览后，结果快照会自动保存到这里。" : category === "trash" ? "移入回收站的数据和文件可以恢复。" : "导入 CSV 或 Excel，让这个项目开始回答问题。"}</p></div>}
          </>}
        </main></div><footer className="data-browser-footer"><span>本地文件夹是真实存储 · 数据 ID 不随重命名变化</span><span>请定期备份整个项目 · 密钥不随项目保存</span></footer>
    </DialogContent>
    {pendingDelete && <FileDeleteDialog key={pendingDelete.id} name={pendingDelete.name} recoverable disabled={busy || !canEdit}
      references={notebookFileReferences(notebooks, pendingDelete.name)}
      fallbackFocusRef={dialogRef} onConfirm={() => confirmFileRemoval(pendingDelete)} onClose={() => setPendingDelete(null)} />}
    </Dialog>;
}
