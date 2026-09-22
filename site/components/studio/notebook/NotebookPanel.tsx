"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { z } from "zod";
import type { DataSourceDefinition } from "@/core/models";
import { datasetUploadResponseSchema, type DatasetUploadResponse } from "@/core/datasets/contracts";
import type { SemanticModel } from "@/core/semantic/contracts";
import type { NotebookArtifact, NotebookCell } from "@/core/notebook/definition";
import { notebookRunSchema, type NotebookDocument } from "@/core/notebook/contracts";
import { isNotebookCellCapabilityEnabled, notebookCapabilityMutationIssue, notebookCapabilityReason } from "@/core/notebook/capabilities";
import { notebookResultAvailability } from "@/core/notebook/result-availability";
import { cacheNotebookRun, invalidateNotebookCachedResults, isNotebookCachedResultFresh, type NotebookResultCache } from "@/core/notebook/result-cache";
import { selectParameterRecompute } from "@/core/notebook/parameter-recompute";
import {
  prepareNotebookCellDeletion, isNotebookCellDeletionStale, confirmNotebookCellDeletion,
  type NotebookCellDeletionReview as DeletionReview,
} from "@/core/notebook/cell-deletion";
import { affectedCells, cellDependencies, cellsToRun, notebookDependencyCandidates, updateNotebook } from "@/core/notebook/graph";
import { adoptNotebookDraft, moveNotebookCell, notebookFingerprint, notebookSemanticModelIssue } from "@/core/notebook/client-state";
import { NotebookCellEditor } from "./NotebookCellEditor";
import { NotebookParameterSummary } from "./NotebookParameterEditor";
import { NotebookTextResult } from "./NotebookTextResult";
import { NotebookResult } from "./NotebookResult";
import { activeProjectHandle, projectHeaders } from "@/core/projects/client";
import type { ConnectionDescriptor } from "@/core/connections/contracts";
import { ConnectionBrowser } from "./ConnectionBrowser";
import { DatasetProvenance } from "../datasets/DatasetProvenance";
import { NotebookFields, NotebookIcon, NotebookInsertToolbar, NotebookStart, NotebookTitle } from "./NotebookChrome";
import { NotebookSource } from "./NotebookSource";
import { cellSource } from "./cell-source";
import { NotebookDraftReview } from "./NotebookDraftReview";
import { NotebookRunTiming } from "./NotebookRunTiming";
import { notebookCellPresentation, notebookToolbarOrder } from "./cell-presentation";
import { createNotebookCell } from "./cell-creation";
import { NotebookOutputRenameConfirmation } from "./NotebookOutputRenameReview";
import { NotebookCellDeletionReview } from "./NotebookCellDeletionReview";
import { confirmNotebookCellSave, isNotebookCellSaveStale, prepareNotebookCellSave, type NotebookCellSaveReview } from "./output-rename-review";
import { useNotebookAutoRun } from "./useNotebookAutoRun";
import { createNotebookRunControl } from "./run-control";
import { useNotebookCapabilities, type NotebookPythonCapabilitySnapshot } from "./useNotebookCapabilities";

const VIEW_KEY = "datacanvas-ai:notebook-view:v1";
export function NotebookPanel({ document, pageId, sources, models, files = [], draft, canEdit, externalBusy, hidden, instruction, pythonCapability, onInstructionChange, onBrowseData, onChange, onImport, onAskAi, onSnapshot, onDataset, onInteractionChange }: {
  document: NotebookDocument; pageId: string; sources: DataSourceDefinition[]; models: SemanticModel[];
  files?: File[];
  pythonCapability?: NotebookPythonCapabilitySnapshot;
  draft?: NotebookArtifact; canEdit: boolean; externalBusy: boolean; hidden: boolean;
  onChange: (next: NotebookDocument, adopted?: NotebookArtifact) => void;
  onImport: () => void; onAskAi: () => void;
  instruction: string; onInstructionChange: (value: string) => void; onBrowseData: () => void;
  onSnapshot: (snapshot: DatasetUploadResponse, cell: NotebookCell) => void;
  onDataset?: (snapshot: DatasetUploadResponse) => void;
  onInteractionChange: (busy: boolean) => void;
}) {
  const [results, setResults] = useState<NotebookResultCache>({});
  const [connections, setConnections] = useState<ConnectionDescriptor[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [saveReview, setSaveReview] = useState<NotebookCellSaveReview | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [runningCellIds, setRunningCellIds] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [savedDataset, setSavedDataset] = useState<DatasetUploadResponse["dataset"] | null>(null);
  const [error, setError] = useState("");
  const [deleteReview, setDeleteReview] = useState<DeletionReview | null>(null);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [view, setView] = useState<"steps" | "code">("steps");
  const [sourceVisibility, setSourceVisibility] = useState<Record<string, boolean>>({});
  const [runControl] = useState(createNotebookRunControl);
  const projectHandle = activeProjectHandle();
  const capabilitySnapshot = useNotebookCapabilities(pythonCapability, projectHandle);
  const pythonEnabled = isNotebookCellCapabilityEnabled(capabilitySnapshot.capabilities, "python");
  const pythonUsable = pythonEnabled && capabilitySnapshot.available;
  const pythonReason = capabilitySnapshot.reason ?? notebookCapabilityReason(capabilitySnapshot.capabilities, "python");
  const pythonNotice = capabilitySnapshot.resolved === false
    ? `正在确认 Python 能力，定义已保留。${pythonReason ? ` ${pythonReason}` : ""}`
    : pythonEnabled
    ? `Python 运行环境不可用，定义已保留。${pythonReason ? ` ${pythonReason}` : ""}`
    : `Python 能力已关闭，定义已保留。${pythonReason ? ` ${pythonReason}` : ""}`;
  const disabledPythonIds = pythonUsable ? [] : document.cells.filter((cell) => cell.kind === "python").map((cell) => cell.id);
  const capabilityBlockedCellIds = affectedCells(document.cells, disabledPythonIds);
  const fullRunCapabilityBlocked = disabledPythonIds.length > 0;
  const availableToolbarKinds = pythonUsable ? notebookToolbarOrder : notebookToolbarOrder.filter((kind) => kind !== "python");
  const activeEditing = document.cells.find((cell) => cell.id === editing)?.kind === "python" && !pythonUsable ? null : editing;
  const mountedRef = useRef(true);
  const newCellEditingRef = useRef<string | null>(null);
  const contextKey = JSON.stringify({ pageId, sources, models, files: files.map((file) => [file.name, file.size, file.lastModified]),
    project: projectHandle, python: { enabled: pythonEnabled, available: capabilitySnapshot.available } });
  const inputKey = JSON.stringify({ document, contextKey });
  const inputKeyRef = useRef(inputKey);
  useLayoutEffect(() => {
    if (inputKeyRef.current !== inputKey) runControl.cancel();
    inputKeyRef.current = inputKey;
  }, [inputKey, runControl]);
  useLayoutEffect(() => {
    if (hidden || !canEdit || externalBusy) runControl.cancel("auto");
  }, [hidden, canEdit, externalBusy, runControl]);
  const autoRun = useNotebookAutoRun({ document, contextKey, editing: Boolean(activeEditing || deleteReview), busy: Boolean(busy), hidden, canEdit, externalBusy,
    onRun: (ids) => attempt(() => { void run(undefined, false, false, selectParameterRecompute(document, ids)); }),
    onCancelAutomatic: () => { runControl.cancel("auto"); },
  });
  const connectionRef = useRef<HTMLDivElement | null>(null);
  const cellsRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    let cancelled = false;
    try {
      const saved = localStorage.getItem(VIEW_KEY);
      if (saved === "steps" || saved === "code") queueMicrotask(() => { if (!cancelled) setView(saved); });
    } catch { /* A display preference must not prevent opening a notebook. */ }
    return () => { cancelled = true; };
  }, []);
  function changeView(value: "steps" | "code") {
    setView(value); setSourceVisibility({});
    try { localStorage.setItem(VIEW_KEY, value); } catch { /* The current window still switches normally. */ }
  }
  useEffect(() => { onInteractionChange(Boolean(busy || activeEditing || deleteReview || autoRun.pendingCount)); return () => onInteractionChange(false); }, [busy, activeEditing, deleteReview, autoRun.pendingCount, onInteractionChange]);
  useEffect(() => {
    if (activeEditing && !hidden) {
      const editor = cellsRef.current?.querySelector<HTMLFormElement>(".notebook-editor");
      editor?.closest("article")?.scrollIntoView({ block: "start" });
      editor?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    }
  }, [activeEditing, hidden]);
  useEffect(() => {
    mountedRef.current = true;
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 10_000); queueMicrotask(tick);
    return () => { mountedRef.current = false; clearInterval(timer); runControl.cancel(); };
  }, [runControl]);
  const locked = !canEdit || Boolean(busy) || externalBusy;
  const pendingDraft = draft && draft.id !== document.lastDraftId && draft.id !== dismissedDraft ? draft : undefined;
  const pendingDraftCapabilityIssue = pendingDraft
    ? notebookCapabilityMutationIssue(capabilitySnapshot.capabilities, document.cells, pendingDraft.cells)
      ?? notebookSemanticModelIssue(pendingDraft.cells, models)
    : undefined;
  const staleSaveReview = saveReview ? isNotebookCellSaveStale(document, saveReview) : false;
  const staleDeleteReview = deleteReview ? isNotebookCellDeletionStale(document, deleteReview) : false;
  function attempt(action: () => void) {
    try { setError(""); action(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Notebook 操作失败"); }
  }
  function fresh(cellId: string) {
    return isNotebookCachedResultFresh(cellId, results, { fingerprint: (id) => fingerprint(document, id),
      isExpired: (id) => cellsToRun(document, id).some((cell) => cell.kind === "data" && sources.some((source) => source.id === cell.sourceDataSourceId && source.expiresAt && Date.parse(source.expiresAt) <= now)),
    });
  }
  function fingerprint(doc: NotebookDocument, cellId: string) {
    const names = new Set(cellsToRun(doc, cellId).flatMap((cell) => cell.kind === "python" ? cell.fileNames : []));
    return notebookFingerprint(doc, cellId, sources, models) + JSON.stringify(files.filter((file) => names.has(file.name)).map((file) => [file.name, file.size, file.lastModified]));
  }
  function fieldsFor(cell: NotebookCell) {
    if (cell.kind === "data") return sources.find((source) => source.id === cell.sourceDataSourceId)?.fields ?? [];
    return fresh(cell.id) ? results[cell.id]?.result.table?.fields ?? [] : [];
  }
  function openConnections() {
    const panel = connectionRef.current?.querySelector("details");
    if (panel) { panel.open = true; panel.scrollIntoView({ block: "nearest" }); panel.querySelector("summary")?.focus(); }
  }
  function addCell(kind: NotebookCell["kind"], connectionId?: string, sql?: string, sourceId?: string) {
    attempt(() => {
      if (kind === "python" && !pythonUsable) throw new Error(pythonNotice);
      if (document.cells.length >= 30) throw new Error("第一版每个 Notebook 最多 30 个单元");
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
      const cell = createNotebookCell(kind, { id: `cell_${suffix}`, suffix, cells: document.cells,
        sources, models, connections, fieldsFor, connectionId, sql, sourceId });
      onChange(updateNotebook(document, [...document.cells, cell])); newCellEditingRef.current = cell.id; setEditing(cell.id);
    });
  }
  function saveCell(cell: NotebookCell) {
    const review = prepareNotebookCellSave(document, cell);
    const capabilityIssue = notebookCapabilityMutationIssue(capabilitySnapshot.capabilities, document.cells, review.candidate.cells);
    if (capabilityIssue) { setError(capabilityIssue); return; }
    if (review.renames.length) { setSaveReview(review); return; }
    onChange(review.candidate);
    if (newCellEditingRef.current !== cell.id) autoRun.approvedSave(document, review.candidate);
    newCellEditingRef.current = null; setEditing(null);
  }
  function closeSaveReview() {
    setSaveReview(null);
    if (staleSaveReview) { newCellEditingRef.current = null; setEditing(null); }
    else window.requestAnimationFrame(() => cellsRef.current?.querySelector<HTMLInputElement>(".notebook-editor input")?.focus());
  }
  function confirmSaveReview() {
    if (!saveReview || locked) return;
    attempt(() => {
      const candidate = confirmNotebookCellSave(document, saveReview);
      const capabilityIssue = notebookCapabilityMutationIssue(capabilitySnapshot.capabilities, document.cells, candidate.cells);
      if (capabilityIssue) throw new Error(capabilityIssue);
      onChange(candidate);
      setSaveReview(null); newCellEditingRef.current = null; setEditing(null);
      setNotice("已保存输出变量改名。请核对提示中的代码，并手动重新运行受影响单元。");
    });
  }
  function closeDeleteReview() {
    const targetId = deleteReview?.targetId;
    setDeleteReview(null);
    window.requestAnimationFrame(() => {
      const buttons = Array.from(cellsRef.current?.querySelectorAll<HTMLButtonElement>("button[data-delete-cell-id]:not(:disabled)") ?? []);
      const target = buttons.find((button) => button.dataset.deleteCellId === targetId) ?? buttons[0];
      (target ?? cellsRef.current)?.focus({ preventScroll: true });
    });
  }
  function confirmDeletion() {
    if (!deleteReview || locked || activeEditing || hidden) return;
    attempt(() => {
      const next = confirmNotebookCellDeletion(document, deleteReview);
      onChange(next);
      const retained = new Set(next.cells.map((cell) => cell.id));
      setResults((current) => Object.fromEntries(Object.entries(current).filter(([id]) => retained.has(id))));
      autoRun.clearPending();
      setNotice(`已删除 ${document.cells.length - next.cells.length} 个步骤；原始数据和已保存看板保持不变。`);
      closeDeleteReview();
    });
  }
  async function run(targetCellId?: string, snapshot = false, saveDataset = false, automatic?: ReturnType<typeof selectParameterRecompute>) {
    if (busy || activeEditing || externalBusy || (automatic && (hidden || !canEdit || !autoRun.enabled))) return;
    const submitted = structuredClone(document);
    const executionDocument = automatic?.document ?? submitted;
    let executionCells: NotebookCell[];
    try { executionCells = cellsToRun(executionDocument, targetCellId); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "Notebook 运行配置无效"); return; }
    if (!pythonUsable && executionCells.some((cell) => cell.kind === "python")) {
      setError(`${pythonNotice} 当前运行范围包含 Python，请恢复能力或改为运行不依赖 Python 的步骤。`);
      setNotice("");
      return;
    }
    const lease = runControl.start(automatic ? "auto" : "manual");
    if (!lease) return;
    if (!automatic) autoRun.clearPending();
    const controller = lease.controller;
    const timeout = window.setTimeout(() => controller.abort(), 40_000);
    const submittedKey = inputKey, submittedProject = activeProjectHandle();
    const ownsContext = () => mountedRef.current && runControl.owns(lease) && inputKeyRef.current === submittedKey && activeProjectHandle() === submittedProject;
    const affected = automatic?.affectedCellIds ?? [...affectedCells(submitted.cells, executionCells.map((cell) => cell.id))];
    setResults((current) => invalidateNotebookCachedResults(current, affected));
    setRunningCellIds(executionCells.map((cell) => cell.id));
    setBusy(targetCellId ?? "all"); setError(""); setNotice(automatic ? `正在自动重算 ${executionCells.length} 个单元；仅更新 Notebook 结果。` : snapshot ? "重新计算当前结果，生成待确认的看板快照…" : "正在本地运行依赖步骤；未完成的单元不会显示为成功。");
    try {
      const payload = JSON.stringify({ pageId, document: executionDocument, semanticModels: models, targetCellId, action: saveDataset ? "dataset" : snapshot ? "snapshot" : "run" });
      const requestedNames = new Set(executionCells.flatMap((cell) => cell.kind === "python" ? cell.fileNames : []));
      const selectedFiles = [...new Map(files.filter((file) => requestedNames.has(file.name)).map((file) => [file.name, file])).values()];
      const form = selectedFiles.length ? new FormData() : undefined;
      if (form) { form.append("payload", payload); selectedFiles.forEach((file) => form.append("file", file)); }
      const response = await fetch("/api/notebook/run", { method: "POST", headers: projectHeaders(form ? {} : { "content-type": "application/json" }), signal: controller.signal,
        body: form ?? payload });
      const body = z.object({ run: z.unknown().optional(), snapshot: z.unknown().optional(), error: z.object({ message: z.string() }).optional() }).parse(await response.json());
      if (!response.ok) throw new Error(body.error?.message ?? "Notebook 运行失败");
      const result = notebookRunSchema.parse(body.run);
      const nextResults = cacheNotebookRun(executionDocument, result, (id) => fingerprint(submitted, id), targetCellId);
      if (!ownsContext()) return;
      if (!runControl.isCurrent(lease)) throw new Error("运行已取消");
      setResults((current) => ({ ...Object.fromEntries(Object.entries(current).filter(([id]) => submitted.cells.some((cell) => cell.id === id))), ...nextResults }));
      setNotice(`${automatic ? "自动重算" : "运行"}${result.status === "success" ? "完成" : "部分步骤失败"} · ${result.cells.filter((item) => item.status === "success").length} / ${result.cells.length} 个单元成功。${result.notice}${automatic && result.status !== "success" ? " 不会自动重试，请修正后再次运行。" : ""}`);
      if (snapshot) {
        const cell = submitted.cells.find((item) => item.id === targetCellId)!;
        onSnapshot(datasetUploadResponseSchema.parse(body.snapshot), cell);
      }
      if (saveDataset) { const saved = datasetUploadResponseSchema.parse(body.snapshot); onDataset?.(saved); setSavedDataset(saved.dataset); setNotice("已保存为数据集，并保留本次查询步骤和来源记录，可继续用于分析。"); }
    } catch (caught) {
      if (!ownsContext()) return;
      if (controller.signal.aborted) setError("运行已取消或超过 40 秒。结果未更新，请重新运行。");
      else setError(caught instanceof Error ? caught.message : "Notebook 运行失败");
      // HTTP/expiry failures also invalidate previously successful outputs.
      const unavailableIds = automatic ? new Set(affected) : new Set(executionCells.map((cell) => cell.id));
      setResults((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !unavailableIds.has(id))));
      setNotice("");
    } finally {
      clearTimeout(timeout);
      if (runControl.finish(lease) && mountedRef.current) {
        setBusy(null); setRunningCellIds([]);
        if (inputKeyRef.current !== submittedKey) setNotice("Notebook 已变化，旧运行结果未采用；请重新运行当前步骤。");
      }
    }
  }
  return <section className={`notebook-panel notebook-view-${view}${document.cells.length ? " has-cells" : " is-empty"}`} hidden={hidden} aria-label="Notebook 分析文档">
    <header className="notebook-heading">
      <div className="notebook-document-meta"><span>Notebook</span><span>{document.cells.length} 个步骤</span>
        <details className="notebook-persistence"><summary>保存说明</summary><p>{activeProjectHandle() ? "分析步骤、项目数据与已保存结果存放在本地文件夹，不按临时保留期过期。" : "分析步骤随工作区保存；原始数据按上传保留期保存，过期后需重新导入。"}运行结果刷新后需重算；看板采用独立结果快照。</p></details>
      </div>
      <div className="notebook-heading-actions"><div className="notebook-view-switch" role="group" aria-label="Notebook 显示模式"><button type="button" aria-pressed={view === "steps"} onClick={() => changeView("steps")}>步骤</button><button type="button" aria-pressed={view === "code"} onClick={() => changeView("code")}>代码</button></div><button type="button" onClick={onImport} disabled={locked}>导入数据</button><button type="button" onClick={onAskAi} disabled={locked}>✧ AI 编写步骤</button>
        {busy ? <button type="button" onClick={() => { autoRun.clearPending(); runControl.cancel(); }}>停止运行</button> : <button type="button" className="notebook-primary"
          disabled={!document.cells.length || Boolean(activeEditing) || externalBusy || fullRunCapabilityBlocked}
          title={fullRunCapabilityBlocked ? `${pythonNotice} 全部运行会包含 Python；不依赖 Python 的步骤仍可单独运行。` : undefined}
          onClick={() => void run()}>▶ 全部运行</button>}
      </div>
      <div className="notebook-auto-run" aria-label="参数重算设置"><label><input type="checkbox" aria-label="参数自动重算" checked={autoRun.enabled} disabled={!canEdit || externalBusy || hidden} onChange={(event) => autoRun.setEnabled(event.target.checked)} />参数自动重算</label>
        <span>{autoRun.pendingCount ? autoRun.paused ? `已保存 ${autoRun.pendingCount} 个参数变更，结束编辑后自动重算。` : `等待自动重算 · ${autoRun.pendingCount} 个参数变更` : autoRun.enabled ? "本窗口开启；仅保存参数值变更后重算相关步骤。必要上游 SQL/Python 也会重跑；共享输入变化可能使其他旧分支失效。不自动保存数据集或看板。" : "默认手动运行；开启本身不会执行分析。"}</span>
      </div>
      <div className="notebook-document-title"><NotebookTitle name={document.name} disabled={locked || Boolean(activeEditing)} onRename={(name) => attempt(() => onChange(updateNotebook(document, document.cells, name)))} />
        <button type="button" className="notebook-description-entry" disabled={locked || Boolean(activeEditing) || document.cells.length >= 30} onClick={() => addCell("text")}>＋ 添加分析说明</button>
      </div>
    </header>
    <div ref={connectionRef} className="notebook-connection-area"><ConnectionBrowser key={projectHandle ?? "local"} onConnections={setConnections} onQuery={(id, sql) => addCell("warehouseSql", id, sql)} disabled={locked || Boolean(activeEditing)} /></div>
    <div className="notebook-feedback" aria-live="polite">{notice && <p>{notice}</p>}{error && <p className="notebook-error" role="alert">{error}</p>}</div>
    {saveReview && !document.cells.some((cell) => cell.id === saveReview.cellId) && <NotebookOutputRenameConfirmation renames={saveReview.renames} disabled={locked} stale onConfirm={confirmSaveReview} onBack={closeSaveReview} />}
    {deleteReview && !document.cells.some((cell) => cell.id === deleteReview.targetId) && <NotebookCellDeletionReview review={deleteReview} disabled={locked || Boolean(activeEditing)} stale onConfirm={confirmDeletion} onKeep={closeDeleteReview} />}
    {savedDataset && <section aria-label="最近保存的数据集"><p>{savedDataset.source.name}</p><DatasetProvenance provenance={savedDataset.provenance} /></section>}
    {pendingDraft && <NotebookDraftReview document={document} draft={pendingDraft} disabled={locked || Boolean(activeEditing)} blockedReason={pendingDraftCapabilityIssue}
      onDismiss={() => setDismissedDraft(pendingDraft.id)} onAdopt={() => attempt(() => {
        const candidate = adoptNotebookDraft(document, pendingDraft);
        const semanticIssue = notebookSemanticModelIssue(candidate.cells, models);
        if (semanticIssue) throw new Error(semanticIssue);
        const capabilityIssue = notebookCapabilityMutationIssue(capabilitySnapshot.capabilities, document.cells, candidate.cells);
        if (capabilityIssue) throw new Error(capabilityIssue);
        onChange(candidate, pendingDraft); setResults({}); setNotice("已采用草稿，请运行 Notebook 查看自己的数据结果。");
      })} />}
    {!document.cells.length && <NotebookStart sources={sources} connectionCount={connections.length} disabled={locked}
      instruction={instruction} onInstructionChange={onInstructionChange} onAskAi={onAskAi} onImport={onImport}
      onBrowseData={onBrowseData} onConnections={openConnections} onAddSource={(id) => addCell("data", undefined, undefined, id)} />}
    <div className="notebook-cells" ref={cellsRef} tabIndex={-1}>{document.cells.map((cell, index) => {
      const cellCapabilityBlocked = capabilityBlockedCellIds.has(cell.id);
      const pythonDefinitionDisabled = !pythonUsable && cell.kind === "python";
      const upstreamCapabilityBlocked = cellCapabilityBlocked && !pythonDefinitionDisabled;
      const cached = results[cell.id]; const isFresh = fresh(cell.id); const result = isFresh && !cellCapabilityBlocked ? cached?.result : undefined;
      const isCellRunning = runningCellIds.includes(cell.id);
      const availability = result ? notebookResultAvailability(cell, result, cached.identity) : undefined;
      const dependencies = cellDependencies(cell);
      const source = cellSource(cell);
      const sourceOpen = Boolean(activeEditing === cell.id || (sourceVisibility[cell.id] ?? view === "code"));
      const { label, sourceLabel } = notebookCellPresentation[cell.kind];
      const inputFields = cell.kind === "data" ? fieldsFor(cell) : document.cells.filter((item) => dependencies.includes(item.id)).flatMap(fieldsFor);
      return <article className={`notebook-cell${activeEditing === cell.id ? " is-editing" : ""}`} key={cell.id} aria-label={`${label}单元 ${cell.title}`}>
        <header><span className="notebook-cell-number">{String(index + 1).padStart(2, "0")}</span><span className="notebook-kind">{label}</span><h2>{cell.title}</h2><span className={`notebook-cell-status ${result?.status ?? ""}`}>{isCellRunning ? "运行中…" : pythonDefinitionDisabled ? "能力已关闭" : upstreamCapabilityBlocked ? "上游能力阻塞" : result ? result.status === "success" ? `✓ ${result.durationMs} ms` : result.status === "blocked" ? "上游失败" : "执行失败" : cached ? "已失效 · 需重算" : "待运行"}</span></header>
        <div className="notebook-cell-tools"><span>{"outputName" in cell ? <code>{cell.outputName}</code> : dependencies.map((id) => document.cells.find((item) => item.id === id)?.title ?? id).join(" → ")}</span>
          <button type="button" disabled={locked || Boolean(activeEditing) || pythonDefinitionDisabled}
            title={pythonDefinitionDisabled ? pythonNotice : undefined}
            onClick={() => { newCellEditingRef.current = null; setEditing(cell.id); }}>编辑</button>
          {cell.kind !== "text" && <button type="button" aria-expanded={sourceOpen} aria-controls={`notebook-source-${cell.id}`} disabled={activeEditing === cell.id} onClick={() => setSourceVisibility((current) => ({ ...current, [cell.id]: !sourceOpen }))}>{sourceOpen ? "收起" : "查看"}{sourceLabel}</button>}
          <button type="button" aria-label={`上移 ${cell.title}`} disabled={locked || Boolean(activeEditing) || index === 0} onClick={() => attempt(() => onChange(moveNotebookCell(document, cell.id, -1)))}>↑</button>
          <button type="button" aria-label={`下移 ${cell.title}`} disabled={locked || Boolean(activeEditing) || index === document.cells.length - 1} onClick={() => attempt(() => onChange(moveNotebookCell(document, cell.id, 1)))}>↓</button>
          <button type="button" data-delete-cell-id={cell.id} disabled={locked || Boolean(activeEditing)} onClick={() => {
            if (locked || activeEditing || hidden) return;
            attempt(() => setDeleteReview(prepareNotebookCellDeletion(document, cell.id)));
          }}>删除</button>
          <button type="button" disabled={Boolean(busy) || Boolean(activeEditing) || externalBusy || cellCapabilityBlocked}
            title={cellCapabilityBlocked ? pythonDefinitionDisabled ? pythonNotice : "上游 Python 能力已关闭，本步骤暂不能运行。" : undefined}
            onClick={() => void run(cell.id)}>▶ 运行</button>
        </div>
        <div className={`notebook-cell-body${activeEditing === cell.id ? " notebook-workbench" : ""}`}>
        {activeEditing === cell.id && cell.kind !== "text" && cell.kind !== "parameter" && <NotebookFields fields={inputFields} />}
        <div className="notebook-cell-definition">
        {activeEditing === cell.id ? <><NotebookCellEditor cell={cell} availableInputs={notebookDependencyCandidates(document.cells, cell.id)} sources={sources} models={models} connections={connections} disabled={locked || Boolean(saveReview)} codeMode={view === "code"} onCancel={() => { setSaveReview(null); newCellEditingRef.current = null; setEditing(null); }} onSave={saveCell} />
          {saveReview?.cellId === cell.id && <NotebookOutputRenameConfirmation renames={saveReview.renames} disabled={locked} stale={staleSaveReview} onConfirm={confirmSaveReview} onBack={closeSaveReview} />}
        </> : <>
          {pythonDefinitionDisabled && <p className="notebook-cell-description" role="status">{pythonNotice} 可继续查看源码或删除此单元；恢复能力后可再次编辑和运行。</p>}
          {upstreamCapabilityBlocked && <p className="notebook-cell-description" role="status">上游 Python 能力已关闭，本步骤已阻塞；定义已保留。恢复能力并重新运行上游后可继续。</p>}
          {cell.kind === "parameter" && <NotebookParameterSummary parameter={cell.parameter} automatic={autoRun.enabled} />}
          {cell.kind === "warehouseSql" && <p className="notebook-cell-description">连接：{connections.find((item) => item.id === cell.connectionId)?.name ?? "连接不可用"} · 结果来自本次查询，数据库变化后请重新运行</p>}
          {cell.kind === "transform" && <p className="notebook-cell-description">DataRecipe · {cell.steps.length} 个处理步骤 · 输入 {document.cells.find((item) => item.id === cell.inputCellId)?.title}</p>}
          {cell.kind === "text" && <NotebookTextResult cell={cell} cells={document.cells} result={result} stale={Boolean(cached) && !isFresh} running={isCellRunning} />}
          {cell.kind === "data" && <p className="notebook-cell-description">来源：{sources.find((source) => source.id === cell.sourceDataSourceId)?.name ?? "数据已移除，请重新导入并编辑来源"}</p>}
          {cell.kind === "semanticQuery" && <p className="notebook-cell-description">模型 v{cell.modelVersion} · {cell.dimensions.join(" / ") || "全局"} → {cell.measures.join(", ")}</p>}
          {(cell.kind === "sql" || cell.kind === "table" || cell.kind === "chart") && <p className="notebook-cell-description">{cell.kind === "sql" ? "查询" : cell.kind === "table" ? "展示表格" : "生成图表"} · {dependencies.map((id) => document.cells.find((item) => item.id === id)?.title ?? id).join("、")}</p>}
          {cell.kind !== "text" && <div id={`notebook-source-${cell.id}`} hidden={!sourceOpen}><NotebookSource value={source.value} language={source.language} label={`${cell.title} ${sourceLabel}`} /></div>}
        </>}
        </div>
        <div className="notebook-cell-output">
        {activeEditing === cell.id && result?.table && <p className="notebook-output-label">已保存步骤的运行结果</p>}
        {result?.table && !hidden && <NotebookResult key={cached.identity.runId + ":" + cell.id} cell={cell} table={result.table} availability={availability} />}
        {view === "code" && activeEditing !== cell.id && !result?.table && cell.kind !== "text" && <p className="notebook-cell-result-pending">{isCellRunning ? "正在运行…" : result?.error ? "本次运行没有可用结果。" : cached ? "步骤已变更，请重新运行以更新结果。" : "运行这个步骤，结果将显示在这里。"}</p>}
        {activeEditing === cell.id && !result?.table && cell.kind !== "text" && <div className="notebook-output-placeholder"><NotebookIcon kind={cell.kind === "chart" ? "chart" : "table"} /><b>在这里查看分析结果</b><p>保存步骤后点击运行，查看数据与图表。</p></div>}
        </div>
        </div>
        {deleteReview?.targetId === cell.id && <NotebookCellDeletionReview review={deleteReview} disabled={locked || Boolean(activeEditing)} stale={staleDeleteReview} onConfirm={confirmDeletion} onKeep={closeDeleteReview} />}
        {result?.error && <p className="notebook-error" role="alert">{result.error}</p>}
        <NotebookRunTiming timing={result?.timing} />
        {(result?.stdout || result?.stderr) && <details className="notebook-cell-description"><summary>Python 输出与诊断</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{result.stdout}{result.stderr ? `\n${result.stderr}` : ""}</pre><small>日志最多各保留 2,000 字。</small></details>}
        {result?.resultRef && <details className="notebook-cell-description"><summary>结果来源</summary><p>运行：{result.resultRef.runId} · 文档 v{result.resultRef.revision} · {result.resultRef.accessMode === "ai" ? "AI 授权结果" : "手动运行结果"}</p><p>结果：{result.resultRef.resultId}</p><p>上游：{result.resultRef.inputResultIds.join(", ") || "源数据"} · {availability?.knownRowCount != null ? `${availability.knownRowCount} 行${availability.completeness === "complete" ? "（完整结果）" : "（结果已截断）"}` : "结果完整性未确认"}</p></details>}
        {result?.table && <div className="notebook-cell-footer"><small>{result.queryId ? `查询记录 ${result.queryId.slice(-8)}` : "当前运行结果"}</small><div>
          {onDataset && <button type="button" disabled={locked || Boolean(activeEditing) || !availability?.canSaveDataset} title="重新计算完整结果后保存；受行数与大小限制" onClick={() => void run(cell.id, false, true)}>保存为 Dataset</button>}
          <button type="button" disabled={locked || Boolean(activeEditing) || !availability?.canSnapshot} title="重新运行后生成固定快照；完整结果最多 500 行，表格最多 30 列；可先选择列，或保存为数据集；先预览再确认" onClick={() => void run(cell.id, true)}>生成看板预览 ↗</button></div></div>}
      </article>;
    })}</div>
    <NotebookInsertToolbar disabled={locked || Boolean(activeEditing) || document.cells.length >= 30} availableKinds={availableToolbarKinds} onAdd={(kind) => addCell(kind)} />
  </section>;
}
