"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { DataSourceDefinition } from "@/core/models";
import { datasetUploadResponseSchema, type DatasetUploadResponse } from "@/core/datasets/contracts";
import type { SemanticModel } from "@/core/semantic/contracts";
import type { NotebookArtifact, NotebookCell } from "@/core/notebook/definition";
import { notebookRunSchema, type NotebookCellRun, type NotebookDocument } from "@/core/notebook/contracts";
import { affectedCells, cellDependencies, cellsToRun, updateNotebook } from "@/core/notebook/graph";
import { adoptNotebookDraft, moveNotebookCell, notebookFingerprint, notebookOutputCells } from "@/core/notebook/client-state";
import { NotebookCellEditor } from "./NotebookCellEditor";
import { NotebookResult } from "./NotebookResult";
import { activeProjectHandle, projectHeaders } from "@/core/projects/client";
import type { ConnectionDescriptor } from "@/core/connections/contracts";
import { ConnectionBrowser } from "./ConnectionBrowser";
import { DatasetProvenance } from "../datasets/DatasetProvenance";
import { NotebookFields, NotebookIcon, NotebookInsertToolbar, NotebookStart, NotebookTitle, notebookCellLabels as labels } from "./NotebookChrome";
import { NotebookSource } from "./NotebookSource";
import { cellSource } from "./cell-source";
import { NotebookDraftReview } from "./NotebookDraftReview";

type CachedResult = { result: NotebookCellRun; fingerprint: string };
const VIEW_KEY = "datacanvas-ai:notebook-view:v1";
export function NotebookPanel({ document, pageId, sources, models, files = [], draft, canEdit, externalBusy, hidden, instruction, onInstructionChange, onBrowseData, onChange, onImport, onAskAi, onSnapshot, onDataset, onInteractionChange }: {
  document: NotebookDocument; pageId: string; sources: DataSourceDefinition[]; models: SemanticModel[];
  files?: File[];
  draft?: NotebookArtifact; canEdit: boolean; externalBusy: boolean; hidden: boolean;
  onChange: (next: NotebookDocument, adopted?: NotebookArtifact) => void;
  onImport: () => void; onAskAi: () => void;
  instruction: string; onInstructionChange: (value: string) => void; onBrowseData: () => void;
  onSnapshot: (snapshot: DatasetUploadResponse, cell: NotebookCell) => void;
  onDataset?: (snapshot: DatasetUploadResponse) => void;
  onInteractionChange: (busy: boolean) => void;
}) {
  const [results, setResults] = useState<Record<string, CachedResult>>({});
  const [connections, setConnections] = useState<ConnectionDescriptor[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [savedDataset, setSavedDataset] = useState<DatasetUploadResponse["dataset"] | null>(null);
  const [error, setError] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [view, setView] = useState<"steps" | "code">("steps");
  const [sourceVisibility, setSourceVisibility] = useState<Record<string, boolean>>({});
  const abortRef = useRef<AbortController | null>(null);
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
  useEffect(() => { onInteractionChange(Boolean(busy || editing)); return () => onInteractionChange(false); }, [busy, editing, onInteractionChange]);
  useEffect(() => {
    if (editing && !hidden) {
      const editor = cellsRef.current?.querySelector<HTMLFormElement>(".notebook-editor");
      editor?.closest("article")?.scrollIntoView({ block: "start" });
      editor?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    }
  }, [editing, hidden]);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 10_000); queueMicrotask(tick);
    return () => { clearInterval(timer); abortRef.current?.abort(); };
  }, []);
  const locked = !canEdit || Boolean(busy) || externalBusy;
  const pendingDraft = draft && draft.id !== document.lastDraftId && draft.id !== dismissedDraft ? draft : undefined;
  function attempt(action: () => void) {
    try { setError(""); action(); } catch (caught) { setError(caught instanceof Error ? caught.message : "Notebook 操作失败"); }
  }
  function fresh(cellId: string) {
    const cached = results[cellId];
    if (!cached) return false;
    try {
      const deps = cellsToRun(document, cellId);
      if (cached.result.resultRef && cached.result.resultRef.inputResultIds.some((id) => !Object.values(results).some((item) => item.result.resultRef?.resultId === id))) return false;
      if (deps.some((cell) => cell.kind === "data" && sources.some((source) => source.id === cell.sourceDataSourceId && source.expiresAt && Date.parse(source.expiresAt) <= now))) return false;
      return cached.fingerprint === fingerprint(document, cellId);
    } catch { return false; }
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
      if (document.cells.length >= 30) throw new Error("第一版每个 Notebook 最多 30 个单元");
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
      const outputName = `${kind}_${document.cells.length + 1}_${suffix.slice(0, 3)}`;
      const common = { id: `cell_${suffix}`, title: kind === "sql" ? "SQL 数据分析" : `${labels[kind]}单元` };
      const outputs = notebookOutputCells(document.cells);
      const last = outputs.at(-1);
      let cell: NotebookCell;
      if (kind === "text") cell = { ...common, kind, markdown: "在这里记录分析问题、结论和口径说明。" };
      else if (kind === "warehouseSql") {
        const connection = connections.find((item) => item.id === connectionId) ?? connections[0];
        if (!connection) throw new Error("请先配置当前项目的数据库连接，并刷新连接列表");
        cell = { ...common, kind, title: `${connection.name} 查询`.slice(0, 120), connectionId: connection.id, outputName, sql: sql ?? "SELECT 1 AS value" };
      }
      else if (kind === "data") {
        const source = sources.find((item) => item.id === sourceId) ?? sources[0];
        if (!source) throw new Error("请先导入 CSV / Excel 表格，再添加 Data 单元");
        cell = { ...common, kind, title: source.name.slice(0, 120), sourceDataSourceId: source.id, outputName };
      } else if (kind === "python") cell = { ...common, kind, inputCellIds: last ? [last.id] : [], fileNames: [], outputName,
        code: last ? `${outputName} = ${last.outputName}.copy()\nprint(${outputName}.shape)` : `${outputName} = pd.DataFrame({"value": [1, 2, 3]})\nprint(${outputName}.shape)` };
      else if (!last) throw new Error("请先添加 Data 单元作为输入");
      else if (kind === "sql") cell = { ...common, kind, inputCellIds: [last.id], outputName, sql: `SELECT *\nFROM ${last.outputName}\nLIMIT 100` };
      else if (kind === "transform") cell = { ...common, kind, inputCellId: last.id, outputName,
        steps: [{ id: `step_${suffix}`, type: "selectFields", fields: fieldsFor(last).map((field) => field.name).length ? fieldsFor(last).map((field) => field.name) : ["field"] }] };
      else if (kind === "semanticQuery") {
        const model = models[0];
        const source = outputs.find((item) => item.kind === "data" && item.sourceDataSourceId === model?.sourceDatasetId);
        if (!model || !source) throw new Error("请先创建语义模型，并添加其数据源的 Data 单元");
        cell = { ...common, kind, inputCellId: source.id, modelId: model.id, modelVersion: model.version,
          dimensions: model.dimensions.slice(0, 1).map((item) => item.key), measures: model.measures.slice(0, 1).map((item) => item.key), limit: 100, outputName };
      } else {
        const fields = fieldsFor(last);
        if (!fields.length) throw new Error("请先运行上游 SQL / 语义查询，再创建表格或图表");
        if (kind === "table") cell = { ...common, kind, inputCellId: last.id, columns: fields.slice(0, 30).map((field) => field.name) };
        else {
          const value = fields.find((field) => field.type === "number");
          if (!value) throw new Error("上游没有数值字段，请先在 SQL 中生成数值指标");
          cell = { ...common, kind, inputCellId: last.id, chartType: "bar", categoryField: (fields.find((field) => field.name !== value.name) ?? value).name, valueFields: [value.name] };
        }
      }
      onChange(updateNotebook(document, [...document.cells, cell])); setEditing(cell.id);
    });
  }
  async function run(targetCellId?: string, snapshot = false, saveDataset = false) {
    if (busy || editing || externalBusy) return;
    const controller = new AbortController(); abortRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 40_000);
    const submitted = structuredClone(document);
    const affected = affectedCells(submitted.cells, cellsToRun(submitted, targetCellId).map((cell) => cell.id));
    setResults((current) => Object.fromEntries(Object.entries(current).map(([id, cached]) => [id, affected.has(id) ? { ...cached, fingerprint: "invalidated" } : cached])));
    setBusy(targetCellId ?? "all"); setError(""); setNotice(snapshot ? "重新计算当前结果，生成待确认的看板快照…" : "正在本地运行依赖步骤；未完成的单元不会显示为成功。");
    try {
      const payload = JSON.stringify({ pageId, document: submitted, semanticModels: models, targetCellId, action: saveDataset ? "dataset" : snapshot ? "snapshot" : "run" });
      const requestedNames = new Set(cellsToRun(submitted, targetCellId).flatMap((cell) => cell.kind === "python" ? cell.fileNames : []));
      const selectedFiles = [...new Map(files.filter((file) => requestedNames.has(file.name)).map((file) => [file.name, file])).values()];
      const form = selectedFiles.length ? new FormData() : undefined;
      if (form) { form.append("payload", payload); selectedFiles.forEach((file) => form.append("file", file)); }
      const response = await fetch("/api/notebook/run", { method: "POST", headers: projectHeaders(form ? {} : { "content-type": "application/json" }), signal: controller.signal,
        body: form ?? payload });
      const body = z.object({ run: z.unknown().optional(), snapshot: z.unknown().optional(), error: z.object({ message: z.string() }).optional() }).parse(await response.json());
      if (!response.ok) throw new Error(body.error?.message ?? "Notebook 运行失败");
      const result = notebookRunSchema.parse(body.run);
      if (controller.signal.aborted) return;
      setResults((current) => ({ ...current, ...Object.fromEntries(result.cells.map((item) => [item.cellId, {
        result: item, fingerprint: fingerprint(submitted, item.cellId),
      }])) }));
      setNotice(`${result.status === "success" ? "运行完成" : "部分步骤失败"} · ${result.cells.filter((item) => item.status === "success").length} / ${result.cells.length} 个单元成功。${result.notice}`);
      if (snapshot) {
        const cell = submitted.cells.find((item) => item.id === targetCellId)!;
        onSnapshot(datasetUploadResponseSchema.parse(body.snapshot), cell);
      }
      if (saveDataset) { const saved = datasetUploadResponseSchema.parse(body.snapshot); onDataset?.(saved); setSavedDataset(saved.dataset); setNotice("已保存为数据集，并保留本次查询步骤和来源记录，可继续用于分析。"); }
    } catch (caught) {
      if (controller.signal.aborted) setError("运行已取消或超过 40 秒。结果未更新，请重新运行。");
      else setError(caught instanceof Error ? caught.message : "Notebook 运行失败");
      // HTTP/expiry failures also invalidate previously successful outputs.
      setResults((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !cellsToRun(submitted, targetCellId).some((cell) => cell.id === id))));
      setNotice("");
    } finally { clearTimeout(timeout); if (abortRef.current === controller) abortRef.current = null; setBusy(null); }
  }
  return <section className={`notebook-panel notebook-view-${view}${document.cells.length ? " has-cells" : " is-empty"}`} hidden={hidden} aria-label="Notebook 分析文档">
    <header className="notebook-heading">
      <div className="notebook-document-meta"><span>Notebook</span><span>{document.cells.length} 个步骤</span>
        <details className="notebook-persistence"><summary>保存说明</summary><p>{activeProjectHandle() ? "分析步骤、项目数据与已保存结果存放在本地文件夹，不按临时保留期过期。" : "分析步骤随工作区保存；原始数据按上传保留期保存，过期后需重新导入。"}运行结果刷新后需重算；看板采用独立结果快照。</p></details>
      </div>
      <div className="notebook-heading-actions"><div className="notebook-view-switch" role="group" aria-label="Notebook 显示模式"><button type="button" aria-pressed={view === "steps"} onClick={() => changeView("steps")}>步骤</button><button type="button" aria-pressed={view === "code"} onClick={() => changeView("code")}>代码</button></div><button type="button" onClick={onImport} disabled={locked}>导入数据</button><button type="button" onClick={onAskAi} disabled={locked}>✧ AI 编写步骤</button>
        {busy ? <button type="button" onClick={() => abortRef.current?.abort()}>停止运行</button> : <button type="button" className="notebook-primary" disabled={!document.cells.length || Boolean(editing) || externalBusy} onClick={() => void run()}>▶ 全部运行</button>}
      </div>
      <div className="notebook-document-title"><NotebookTitle name={document.name} disabled={locked || Boolean(editing)} onRename={(name) => attempt(() => onChange(updateNotebook(document, document.cells, name)))} />
        <button type="button" className="notebook-description-entry" disabled={locked || Boolean(editing) || document.cells.length >= 30} onClick={() => addCell("text")}>＋ 添加分析说明</button>
      </div>
    </header>
    <div ref={connectionRef} className="notebook-connection-area"><ConnectionBrowser key={activeProjectHandle() ?? "local"} onConnections={setConnections} onQuery={(id, sql) => addCell("warehouseSql", id, sql)} disabled={locked || Boolean(editing)} /></div>
    <div className="notebook-feedback" aria-live="polite">{notice && <p>{notice}</p>}{error && <p className="notebook-error" role="alert">{error}</p>}</div>
    {savedDataset && <section aria-label="最近保存的数据集"><p>{savedDataset.source.name}</p><DatasetProvenance provenance={savedDataset.provenance} /></section>}
    {pendingDraft && <NotebookDraftReview document={document} draft={pendingDraft} disabled={locked || Boolean(editing)} onDismiss={() => setDismissedDraft(pendingDraft.id)}
      onAdopt={() => attempt(() => { onChange(adoptNotebookDraft(document, pendingDraft), pendingDraft); setResults({}); setNotice("已采用草稿，请运行 Notebook 查看自己的数据结果。"); })} />}
    {!document.cells.length && <NotebookStart sources={sources} connectionCount={connections.length} disabled={locked}
      instruction={instruction} onInstructionChange={onInstructionChange} onAskAi={onAskAi} onImport={onImport}
      onBrowseData={onBrowseData} onConnections={openConnections} onAddSource={(id) => addCell("data", undefined, undefined, id)} />}
    <div className="notebook-cells" ref={cellsRef}>{document.cells.map((cell, index) => {
      const cached = results[cell.id]; const isFresh = fresh(cell.id); const result = isFresh ? cached?.result : undefined;
      const dependencies = cellDependencies(cell);
      const source = cellSource(cell);
      const sourceOpen = Boolean(editing === cell.id || (sourceVisibility[cell.id] ?? view === "code"));
      const sourceLabel = cell.kind === "sql" || cell.kind === "warehouseSql" ? "SQL" : cell.kind === "python" ? "Python" : cell.kind === "transform" ? "处理规则" : "配置";
      const inputFields = cell.kind === "data" ? fieldsFor(cell) : document.cells.filter((item) => dependencies.includes(item.id)).flatMap(fieldsFor);
      const removed = deleteId === cell.id ? affectedCells(document.cells, [cell.id]) : null;
      return <article className={`notebook-cell${editing === cell.id ? " is-editing" : ""}`} key={cell.id} aria-label={`${labels[cell.kind]}单元 ${cell.title}`}>
        <header><span className="notebook-cell-number">{String(index + 1).padStart(2, "0")}</span><span className="notebook-kind">{labels[cell.kind]}</span><h2>{cell.title}</h2><span className={`notebook-cell-status ${result?.status ?? ""}`}>{busy === cell.id || busy === "all" ? "运行中…" : result ? result.status === "success" ? `✓ ${result.durationMs} ms` : result.status === "blocked" ? "上游失败" : "执行失败" : cached ? "已失效 · 需重算" : "待运行"}</span></header>
        <div className="notebook-cell-tools"><span>{"outputName" in cell ? <code>{cell.outputName}</code> : dependencies.map((id) => document.cells.find((item) => item.id === id)?.title ?? id).join(" → ")}</span>
          <button type="button" disabled={locked || Boolean(editing)} onClick={() => setEditing(cell.id)}>编辑</button>
          {cell.kind !== "text" && <button type="button" aria-expanded={sourceOpen} aria-controls={`notebook-source-${cell.id}`} disabled={editing === cell.id} onClick={() => setSourceVisibility((current) => ({ ...current, [cell.id]: !sourceOpen }))}>{sourceOpen ? "收起" : "查看"}{sourceLabel}</button>}
          <button type="button" aria-label={`上移 ${cell.title}`} disabled={locked || Boolean(editing) || index === 0} onClick={() => attempt(() => onChange(moveNotebookCell(document, cell.id, -1)))}>↑</button>
          <button type="button" aria-label={`下移 ${cell.title}`} disabled={locked || Boolean(editing) || index === document.cells.length - 1} onClick={() => attempt(() => onChange(moveNotebookCell(document, cell.id, 1)))}>↓</button>
          <button type="button" disabled={locked || Boolean(editing)} onClick={() => setDeleteId(cell.id)}>删除</button>
          <button type="button" disabled={Boolean(busy) || Boolean(editing) || externalBusy} onClick={() => void run(cell.id)}>▶ 运行</button>
        </div>
        <div className={`notebook-cell-body${editing === cell.id ? " notebook-workbench" : ""}`}>
        {editing === cell.id && cell.kind !== "text" && <NotebookFields fields={inputFields} />}
        <div className="notebook-cell-definition">
        {editing === cell.id ? <NotebookCellEditor cell={cell} previous={document.cells.slice(0, index)} sources={sources} models={models} connections={connections} disabled={locked} codeMode={view === "code"} onCancel={() => setEditing(null)} onSave={(next) => { onChange(updateNotebook(document, document.cells.map((item) => item.id === cell.id ? next : item))); setEditing(null); }} /> : <>
          {cell.kind === "warehouseSql" && <p className="notebook-cell-description">连接：{connections.find((item) => item.id === cell.connectionId)?.name ?? "连接不可用"} · 结果来自本次查询，数据库变化后请重新运行</p>}
          {cell.kind === "transform" && <p className="notebook-cell-description">DataRecipe · {cell.steps.length} 个处理步骤 · 输入 {document.cells.find((item) => item.id === cell.inputCellId)?.title}</p>}
          {cell.kind === "text" && <p className="notebook-text">{cell.markdown}</p>}
          {cell.kind === "data" && <p className="notebook-cell-description">来源：{sources.find((source) => source.id === cell.sourceDataSourceId)?.name ?? "数据已移除，请重新导入并编辑来源"}</p>}
          {cell.kind === "semanticQuery" && <p className="notebook-cell-description">模型 v{cell.modelVersion} · {cell.dimensions.join(" / ") || "全局"} → {cell.measures.join(", ")}</p>}
          {(cell.kind === "sql" || cell.kind === "table" || cell.kind === "chart") && <p className="notebook-cell-description">{cell.kind === "sql" ? "查询" : cell.kind === "table" ? "展示表格" : "生成图表"} · {dependencies.map((id) => document.cells.find((item) => item.id === id)?.title ?? id).join("、")}</p>}
          {cell.kind !== "text" && <div id={`notebook-source-${cell.id}`} hidden={!sourceOpen}><NotebookSource value={source.value} language={source.language} label={`${cell.title} ${sourceLabel}`} /></div>}
        </>}
        </div>
        <div className="notebook-cell-output">
        {editing === cell.id && result?.table && <p className="notebook-output-label">已保存步骤的运行结果</p>}
        {result?.table && !hidden && <NotebookResult key={cached.fingerprint + result.queryId} cell={cell} table={result.table} />}
        {view === "code" && editing !== cell.id && !result?.table && cell.kind !== "text" && <p className="notebook-cell-result-pending">{busy ? "正在运行…" : result?.error ? "本次运行没有可用结果。" : cached ? "步骤已变更，请重新运行以更新结果。" : "运行这个步骤，结果将显示在这里。"}</p>}
        {editing === cell.id && !result?.table && cell.kind !== "text" && <div className="notebook-output-placeholder"><NotebookIcon kind={cell.kind === "chart" ? "chart" : "table"} /><b>在这里查看分析结果</b><p>保存步骤后点击运行，查看数据与图表。</p></div>}
        </div>
        </div>
        {removed && <div className="notebook-delete" role="alert"><p>删除此单元及 {removed.size - 1} 个依赖它的下游单元？正式看板不受影响。</p><button type="button" disabled={locked} onClick={() => attempt(() => { onChange(updateNotebook(document, document.cells.filter((item) => !removed.has(item.id)))); setDeleteId(null); })}>确认删除 {removed.size} 个单元</button><button type="button" onClick={() => setDeleteId(null)}>保留</button></div>}
        {result?.error && <p className="notebook-error" role="alert">{result.error}</p>}
        {(result?.stdout || result?.stderr) && <details className="notebook-cell-description"><summary>Python 输出与诊断</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{result.stdout}{result.stderr ? `\n${result.stderr}` : ""}</pre><small>日志最多各保留 2,000 字。</small></details>}
        {result?.resultRef && <details className="notebook-cell-description"><summary>结果来源</summary><p>运行：{result.resultRef.runId} · 文档 v{result.resultRef.revision} · {result.resultRef.accessMode === "ai" ? "AI 授权结果" : "手动运行结果"}</p><p>结果：{result.resultRef.resultId}</p><p>上游：{result.resultRef.inputResultIds.join(", ") || "源数据"} · {result.resultRef.rowCount} 行{result.resultRef.complete ? "（完整结果）" : "（结果已截断）"}</p></details>}
        {result?.table && <div className="notebook-cell-footer"><small>{result.queryId ? `查询记录 ${result.queryId.slice(-8)}` : "当前运行结果"}</small><div>
          {onDataset && <button type="button" disabled={locked || Boolean(editing) || result.table.truncated || !result.table.rows.length || cell.kind === "data"} onClick={() => void run(cell.id, false, true)}>保存为 Dataset</button>}
          <button type="button" disabled={locked || Boolean(editing) || result.table.truncated || !result.table.rows.length || result.table.rows.length > 500 || cell.kind === "data"} title="重新运行后生成快照；最多 500 行；先预览再确认" onClick={() => void run(cell.id, true)}>生成看板预览 ↗</button></div></div>}
      </article>;
    })}</div>
    <NotebookInsertToolbar disabled={locked || Boolean(editing) || document.cells.length >= 30} onAdd={(kind) => addCell(kind)} />
  </section>;
}
