"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DataProduct, DataSourceDefinition } from "@/core/models";
import { notebookFileReferences } from "@/core/notebook/file-references";
import type { DatasetUploadResponse } from "@/core/datasets/contracts";
import { loadUploadedDataset } from "@/core/datasets/client";
import { downloadProjectFile, loadProject, setProjectFileArchived } from "@/core/projects/client";
import type { ProjectSession } from "@/core/projects/contracts";
import { StudioIcon } from "../StudioIcon";
import { FileDeleteDialog } from "./FileDeleteDialog";
import { buildFileList, fileSize, sortFileList, type FileListEntry, type SessionImportedFile, type SessionWorkbook } from "./file-list";

export function FilesPanel({ project, sources, notebooks, files, workbooks, removedDatasetIds, refreshVersion, canImport, interactionBusy, onClose, onImport, onPreview, onWorkbook, onBrowseData, onConnections, onRemoved, onTrash, beforeRemove }: {
  project: ProjectSession | null; sources: DataSourceDefinition[]; files: SessionImportedFile[]; workbooks: SessionWorkbook[];
  notebooks: DataProduct["notebooks"];
  refreshVersion: number; canImport: boolean; interactionBusy: boolean;
  removedDatasetIds: string[]; onRemoved: (datasetIds: string[], file?: File) => void; onTrash: () => void;
  beforeRemove: () => Promise<void>;
  onClose: () => void; onImport: (files?: File[]) => void; onPreview: (result: DatasetUploadResponse) => void;
  onWorkbook: (id: string) => void; onBrowseData: () => void; onConnections: () => void;
}) {
  const [manifest, setManifest] = useState(project?.manifest ?? null);
  const [loading, setLoading] = useState(Boolean(project));
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [pendingDelete, setPendingDelete] = useState<FileListEntry | null>(null);
  const [search, setSearch] = useState(""); const [order, setOrder] = useState<"recent" | "name">("recent");
  const [expanded, setExpanded] = useState<string | null>(null), [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null), closeRef = useRef<HTMLButtonElement>(null);
  const manifestRequestRef = useRef(0);
  const handle = project?.handle;
  useEffect(() => {
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!handle) return;
    let active = true;
    const version = ++manifestRequestRef.current;
    void loadProject(handle).then((next) => { if (active && version === manifestRequestRef.current) { setManifest(next.manifest); setError(""); setNotice(""); } })
      .catch((caught) => { if (active && version === manifestRequestRef.current) setError(caught instanceof Error ? caught.message : "文件列表读取失败"); })
      .finally(() => { if (active && version === manifestRequestRef.current) setLoading(false); });
    return () => { active = false; };
  }, [handle, refreshVersion]);
  const entries = useMemo(() => buildFileList({ manifest, sources, files, workbooks, removedDatasetIds }), [manifest, sources, files, workbooks, removedDatasetIds]);
  const visible = sortFileList(entries, search, order), originals = entries.filter((entry) => entry.origin !== "data");
  async function act(action: () => Promise<void>) {
    if (busy) return; setBusy(true); setError("");
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : "文件操作失败"); } finally { setBusy(false); }
  }
  async function download(entry: FileListEntry) {
    if (entry.origin === "project") return downloadProjectFile(entry.id, entry.name);
    if (!entry.file) return;
    const url = URL.createObjectURL(entry.file), anchor = document.createElement("a");
    anchor.href = url; anchor.download = entry.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  async function remove(entry: FileListEntry) {
    if (!canImport || interactionBusy || busy || loading || entry.origin === "data") throw new Error("当前无法删除文件，请等待操作结束后重试。");
    setBusy(true); setError("");
    try {
      setNotice("");
      const ids = manifest?.files.find((file) => file.id === entry.id)?.datasetIds ?? entry.tables.map((table) => table.id);
      if (entry.origin === "project") {
        if (!handle) throw new Error("请先打开文件所属的项目");
        await beforeRemove();
        const next = await setProjectFileArchived(handle, entry.id, true);
        ++manifestRequestRef.current; // An older list response must not undo a successful archive.
        setManifest(next.manifest);
      }
      onRemoved(ids, entry.file);
      setExpanded(null);
      setNotice(entry.origin === "project" ? `“${entry.name}”已移入回收站，已导入的数据表仍可使用。` : `“${entry.name}”的会话原件已移除，已导入的数据表仍可使用。`);
    } finally { setBusy(false); }
  }
  const importFiles = (selected: File[]) => { setDragging(false); if (canImport && !busy && selected.length) onImport(selected); };
  return <aside id="studio-files-panel" className="studio-files-panel" aria-label="原始文件面板" onKeyDown={(event) => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <header className="studio-files-header"><h2>原始文件</h2><button type="button" ref={closeRef} aria-label="收起原始文件面板" title="收起文件面板" onClick={onClose}>×</button></header>
    <div className="studio-files-scroll">
      <p className="studio-files-intro">导入 CSV 或 Excel，用于当前分析。</p>
      <div className={`studio-files-drop${dragging ? " dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); if (canImport && !busy) setDragging(true); }}
        onDragLeave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false); }}
        onDrop={(event) => { event.preventDefault(); importFiles(Array.from(event.dataTransfer.files)); }}>
        <button type="button" disabled={!canImport || busy} onClick={() => inputRef.current?.click()}><StudioIcon name="upload" /><span>拖放文件到这里，或 <b>浏览文件</b></span><small>CSV / XLSX</small></button>
        <input ref={inputRef} type="file" hidden multiple accept=".csv,.xlsx" aria-label="选择原始文件" onChange={(event) => { importFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      </div>
      <div className="studio-files-listbar"><span>{!originals.length && entries.length ? `${entries.length} 份已导入数据` : `${originals.length} 个文件`}</span><select aria-label="文件排序" value={order} onChange={(event) => setOrder(event.target.value as typeof order)}><option value="recent">最近导入</option><option value="name">文件名称</option></select>
        {handle && <button type="button" aria-label="刷新文件列表" title="刷新文件列表" disabled={busy || loading} onClick={() => void act(async () => { ++manifestRequestRef.current; setManifest((await loadProject(handle)).manifest); setNotice(""); })}>↻</button>}</div>
      {entries.length > 0 && <label className="studio-files-search"><StudioIcon name="search" /><input aria-label="搜索原始文件" placeholder="搜索文件…" value={search} onChange={(event) => setSearch(event.target.value)} /></label>}
      {loading && <p className="studio-files-empty" role="status">正在读取文件…</p>}
      {error && <p className="studio-files-error" role="alert">{error}</p>}
      {notice && <p className="studio-files-status" role="status">{notice}</p>}
      <div className="studio-files-list">{visible.map((entry) => <article key={entry.id} className={expanded === entry.id ? "selected" : undefined} aria-label={`文件 ${entry.name}`}>
        <div className="studio-file-main"><button type="button" className="studio-file-name" title={entry.name} aria-expanded={expanded === entry.id} aria-controls={`file-details-${entry.id}`} onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}>{entry.name}</button>
          {entry.origin !== "data" && <button type="button" className="studio-file-action" disabled={busy} aria-label={`下载原件 ${entry.name}`} title="下载原件" onClick={() => void act(() => download(entry))}><StudioIcon name="backup" /></button>}
          {entry.origin !== "data" && <button type="button" className="studio-file-action studio-file-delete" disabled={!canImport || interactionBusy || busy || loading} aria-label={`删除文件 ${entry.name}`} title={entry.origin === "project" ? "移入回收站" : "移除会话原件"} onClick={() => { setError(""); setPendingDelete(entry); }}><StudioIcon name="trash" /></button>}
          <button type="button" className="studio-file-action" aria-label={`${entry.name} 的文件操作`} aria-expanded={expanded === entry.id} aria-controls={`file-details-${entry.id}`} title="文件操作" onClick={() => setExpanded(expanded === entry.id ? null : entry.id)}>···</button></div>
        <div className="studio-file-meta"><StudioIcon name="files" /><span>{entry.origin === "project" ? "本地项目" : entry.origin === "session" ? "本次会话" : "已导入数据"}</span>{entry.bytes !== undefined && <span>{fileSize(entry.bytes)}</span>}
          {entry.addedAt && <time dateTime={entry.addedAt} title={new Date(entry.addedAt).toLocaleString("zh-CN")}>{new Date(entry.addedAt).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" })}</time>}</div>
        <div id={`file-details-${entry.id}`} hidden={expanded !== entry.id} className="studio-file-details">
          {entry.origin === "data" && <p>原件未保留，可查看已导入的数据。</p>}
          {entry.workbookId && <button type="button" disabled={interactionBusy || busy} onClick={() => onWorkbook(entry.workbookId!)}>查看原始工作簿 ↗</button>}
          {entry.tables.map((table) => <button type="button" key={table.id} disabled={interactionBusy || busy} onClick={() => void act(async () => onPreview(await loadUploadedDataset(table.id)))}><StudioIcon name="data" /><span>{table.name}<small>{table.rows.toLocaleString()} 行 · 查看数据</small></span><span>↗</span></button>)}
          {!entry.tables.length && <p>原件已保存，关联数据表当前不可用。</p>}
        </div>
      </article>)}</div>
      {!loading && !visible.length && <div className="studio-files-empty">{search ? "没有找到匹配文件。" : <><StudioIcon name="files" /><b>还没有导入文件</b><p>上传一份表格，即可开始分析。</p></>}</div>}
      <section className="studio-files-connections"><h3>数据库连接</h3><p>也可以从已连接的数据库中查询数据。</p><button type="button" disabled={interactionBusy} onClick={onConnections}><StudioIcon name="connections" />查看连接<span>↗</span></button></section>
    </div>
    <footer><p>{project ? "原始文件已保存在本地项目。" : "本次会话的原件可下载；刷新后需重新选择文件。"}</p>{project && <button type="button" disabled={interactionBusy || busy} onClick={onTrash}>回收站 <span>↗</span></button>}<button type="button" disabled={interactionBusy || busy} onClick={onBrowseData}>管理项目与数据 <span>↗</span></button></footer>
    {pendingDelete && <FileDeleteDialog key={pendingDelete.id} name={pendingDelete.name} recoverable={pendingDelete.origin === "project"}
      references={notebookFileReferences(notebooks, pendingDelete.name)}
      disabled={!canImport || interactionBusy || busy || loading} fallbackFocusRef={closeRef}
      onConfirm={() => remove(pendingDelete)} onClose={() => setPendingDelete(null)} />}
  </aside>;
}
