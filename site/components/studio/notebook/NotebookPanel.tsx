"use client";

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { DataSourceDefinition } from "@/core/models";
import { datasetUploadResponseSchema, type DatasetUploadResponse } from "@/core/datasets/contracts";
import type { SemanticModel } from "@/core/semantic/contracts";
import type { HarnessNotebookArtifact, HarnessNotebookCell } from "@/core/harness/notebook-contracts";
import { notebookRunSchema, type NotebookCellRun, type NotebookDocument } from "@/core/notebook/contracts";
import { affectedCells, cellDependencies, cellsToRun, updateNotebook } from "@/core/notebook/graph";
import { adoptNotebookDraft, moveNotebookCell, notebookDiff, notebookFingerprint, notebookOutputCells } from "@/core/notebook/client-state";
import { NotebookCellEditor } from "./NotebookCellEditor";
import { NotebookResult } from "./NotebookResult";
import { activeProjectHandle, projectHeaders } from "@/core/projects/client";
import type { ConnectionDescriptor } from "@/core/connections/contracts";
import { ConnectionBrowser } from "./ConnectionBrowser";

const labels: Record<HarnessNotebookCell["kind"], string> = { data: "Data", warehouseSql: "数据库 SQL", sql: "SQL", transform: "DataRecipe", semanticQuery: "语义查询", table: "表格", chart: "图表", text: "说明" };
type CachedResult = { result: NotebookCellRun; fingerprint: string };
export function NotebookPanel({ document, pageId, sources, models, draft, canEdit, externalBusy, hidden, onChange, onImport, onAskAi, onSnapshot, onDataset, onInteractionChange }: {
  document: NotebookDocument; pageId: string; sources: DataSourceDefinition[]; models: SemanticModel[];
  draft?: HarnessNotebookArtifact; canEdit: boolean; externalBusy: boolean; hidden: boolean;
  onChange: (next: NotebookDocument, adopted?: HarnessNotebookArtifact) => void;
  onImport: () => void; onAskAi: () => void;
  onSnapshot: (snapshot: DatasetUploadResponse, cell: HarnessNotebookCell) => void;
  onDataset?: (snapshot: DatasetUploadResponse) => void;
  onInteractionChange: (busy: boolean) => void;
}) {
  const [results, setResults] = useState<Record<string, CachedResult>>({});
  const [connections, setConnections] = useState<ConnectionDescriptor[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [dismissedDraft, setDismissedDraft] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => { onInteractionChange(Boolean(busy || editing)); return () => onInteractionChange(false); }, [busy, editing, onInteractionChange]);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 10_000); queueMicrotask(tick);
    return () => { clearInterval(timer); abortRef.current?.abort(); };
  }, []);
  const locked = !canEdit || Boolean(busy) || externalBusy;
  const pendingDraft = draft && draft.id !== document.lastDraftId && draft.id !== dismissedDraft ? draft : undefined;
  const diff = pendingDraft ? notebookDiff(document, pendingDraft) : null;
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
      return cached.fingerprint === notebookFingerprint(document, cellId, sources, models);
    } catch { return false; }
  }
  function fieldsFor(cell: HarnessNotebookCell) {
    if (cell.kind === "data") return sources.find((source) => source.id === cell.sourceDataSourceId)?.fields ?? [];
    return fresh(cell.id) ? results[cell.id]?.result.table?.fields ?? [] : [];
  }
  function addCell(kind: HarnessNotebookCell["kind"], connectionId?: string, sql?: string) {
    attempt(() => {
      if (document.cells.length >= 30) throw new Error("第一版每个 Notebook 最多 30 个单元");
      const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
      const outputName = `${kind}_${document.cells.length + 1}_${suffix.slice(0, 3)}`;
      const common = { id: `cell_${suffix}`, title: kind === "sql" ? "SQL 数据分析" : `${labels[kind]}单元` };
      const outputs = notebookOutputCells(document.cells);
      const last = outputs.at(-1);
      let cell: HarnessNotebookCell;
      if (kind === "text") cell = { ...common, kind, markdown: "在这里记录分析问题、结论和口径说明。" };
      else if (kind === "warehouseSql") {
        const connection = connections.find((item) => item.id === connectionId) ?? connections[0];
        if (!connection) throw new Error("请先配置当前项目的数据库连接，并刷新连接列表");
        cell = { ...common, kind, title: `${connection.name} 查询`.slice(0, 120), connectionId: connection.id, outputName, sql: sql ?? "SELECT 1 AS value" };
      }
      else if (kind === "data") {
        if (!sources[0]) throw new Error("请先导入 CSV / Excel 表格，再添加 Data 单元");
        cell = { ...common, kind, title: sources[0].name.slice(0, 120), sourceDataSourceId: sources[0].id, outputName };
      } else if (!last) throw new Error("请先添加 Data 单元作为输入");
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
      const response = await fetch("/api/notebook/run", { method: "POST", headers: projectHeaders({ "content-type": "application/json" }), signal: controller.signal,
        body: JSON.stringify({ pageId, document: submitted, semanticModels: models, targetCellId, action: saveDataset ? "dataset" : snapshot ? "snapshot" : "run" }) });
      const body = z.object({ run: z.unknown().optional(), snapshot: z.unknown().optional(), error: z.object({ message: z.string() }).optional() }).parse(await response.json());
      if (!response.ok) throw new Error(body.error?.message ?? "Notebook 运行失败");
      const result = notebookRunSchema.parse(body.run);
      if (controller.signal.aborted) return;
      setResults((current) => ({ ...current, ...Object.fromEntries(result.cells.map((item) => [item.cellId, {
        result: item, fingerprint: notebookFingerprint(submitted, item.cellId, sources, models),
      }])) }));
      setNotice(`${result.status === "success" ? "运行完成" : "部分步骤失败"} · ${result.cells.filter((item) => item.status === "success").length} / ${result.cells.length} 个单元成功。${result.notice}`);
      if (snapshot) {
        const cell = submitted.cells.find((item) => item.id === targetCellId)!;
        onSnapshot(datasetUploadResponseSchema.parse(body.snapshot), cell);
      }
      if (saveDataset) { onDataset?.(datasetUploadResponseSchema.parse(body.snapshot)); setNotice("已保存为数据集，可在当前项目继续使用；原 Notebook 单元与依赖关系保留。"); }
    } catch (caught) {
      if (controller.signal.aborted) setError("运行已取消或超过 40 秒。结果未更新，请重新运行。");
      else setError(caught instanceof Error ? caught.message : "Notebook 运行失败");
      // HTTP/expiry failures also invalidate previously successful outputs.
      setResults((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !cellsToRun(submitted, targetCellId).some((cell) => cell.id === id))));
      setNotice("");
    } finally { clearTimeout(timeout); if (abortRef.current === controller) abortRef.current = null; setBusy(null); }
  }
  return <section className="notebook-panel" hidden={hidden} aria-label="Notebook 分析文档">
    <header className="notebook-heading"><div><span>ANALYSIS NOTEBOOK</span><h1>{document.name}</h1><p>{document.cells.length} 个单元 · v{document.revision} · SQL / DataRecipe</p></div>
      <div className="notebook-heading-actions"><button type="button" onClick={onImport} disabled={locked}>导入数据</button><button type="button" onClick={onAskAi} disabled={locked}>✧ AI 编写步骤</button>
        {busy ? <button type="button" onClick={() => abortRef.current?.abort()}>停止运行</button> : <button type="button" className="notebook-primary" disabled={!document.cells.length || Boolean(editing) || externalBusy} onClick={() => void run()}>▶ 全部运行</button>}
      </div>
    </header>
    <div className="notebook-persistence"><b>分析步骤随项目保存</b><span>{activeProjectHandle() ? "项目数据与已保存结果存放在本地文件夹，不按临时保留期过期。运行缓存刷新后需重算；看板仍采用独立结果快照。" : "原始数据仍按上传保留期保存，过期后需重新导入并重选 Data 来源。结果刷新后需重算；看板采用独立结果快照。"}</span></div>
    <ConnectionBrowser onConnections={setConnections} onQuery={(id, sql) => addCell("warehouseSql", id, sql)} disabled={locked || Boolean(editing)} />
    <div className="notebook-feedback" aria-live="polite">{notice && <p>{notice}</p>}{error && <p className="notebook-error" role="alert">{error}</p>}</div>
    {pendingDraft && diff && <section className="notebook-draft" aria-label="AI Notebook 草稿"><header><b>✧ AI 草稿待采用</b><span>{pendingDraft.executionEvidence?.status === "success" ? "已通过数据试运行" : "仅结构校验"}</span></header><p>{pendingDraft.name} · 新增 {diff.added.length}、修改 {diff.changed.length}、移除 {diff.removed.length} 个单元</p>
      <details><summary>查看变更和步骤</summary>{[["新增", diff.added], ["修改", diff.changed], ["移除", diff.removed]].map(([label, values]) => <p key={String(label)}>{label}：{(values as string[]).join("、") || "无"}</p>)}<ol>{pendingDraft.cells.map((cell) => <li key={cell.id}><b>{labels[cell.kind]} · {cell.title}</b>{cell.kind === "sql" && <pre>{cell.sql}</pre>}{cell.kind === "text" && <p>{cell.markdown}</p>}</li>)}</ol></details>
      <footer><small>采用只修改 Notebook；确认看板预览才会修改正式看板。</small><button type="button" onClick={() => setDismissedDraft(pendingDraft.id)}>暂不采用</button><button type="button" className="notebook-primary" disabled={locked || Boolean(editing)} onClick={() => attempt(() => { onChange(adoptNotebookDraft(document, pendingDraft), pendingDraft); setResults({}); setNotice("已采用草稿，请运行 Notebook 查看自己的数据结果。"); })}>采用草稿</button></footer>
    </section>}
    {!document.cells.length && <div className="notebook-empty"><span aria-hidden="true">▤</span><h2>把一次提问，变成可重复的分析</h2><p>从一份表格开始，添加 SQL、图表与说明。<br />每个步骤都有输入、结果和明确的运行状态。</p><button type="button" className="notebook-primary" disabled={locked} onClick={() => sources.length ? addCell("data") : onImport()}>{sources.length ? "添加第一个 Data 单元" : "导入第一份表格"}</button><small>Data → SQL / 语义查询 → 表格 / 图表 → 看板预览</small></div>}
    <div className="notebook-cells">{document.cells.map((cell, index) => {
      const cached = results[cell.id]; const isFresh = fresh(cell.id); const result = isFresh ? cached?.result : undefined;
      const dependencies = cellDependencies(cell);
      const removed = deleteId === cell.id ? affectedCells(document.cells, [cell.id]) : null;
      return <article className={`notebook-cell${editing === cell.id ? " is-editing" : ""}`} key={cell.id} aria-label={`${labels[cell.kind]}单元 ${cell.title}`}>
        <header><span className="notebook-cell-number">{String(index + 1).padStart(2, "0")}</span><span className="notebook-kind">{labels[cell.kind]}</span><h2>{cell.title}</h2><span className={`notebook-cell-status ${result?.status ?? ""}`}>{busy === cell.id || busy === "all" ? "运行中…" : result ? result.status === "success" ? `✓ ${result.durationMs} ms` : result.status === "blocked" ? "上游失败" : "执行失败" : cached ? "已失效 · 需重算" : "待运行"}</span></header>
        <div className="notebook-cell-tools"><span>{"outputName" in cell ? <code>{cell.outputName}</code> : dependencies.map((id) => document.cells.find((item) => item.id === id)?.title ?? id).join(" → ")}</span>
          <button type="button" disabled={locked || Boolean(editing)} onClick={() => setEditing(cell.id)}>编辑</button>
          <button type="button" aria-label={`上移 ${cell.title}`} disabled={locked || Boolean(editing) || index === 0} onClick={() => attempt(() => onChange(moveNotebookCell(document, cell.id, -1)))}>↑</button>
          <button type="button" aria-label={`下移 ${cell.title}`} disabled={locked || Boolean(editing) || index === document.cells.length - 1} onClick={() => attempt(() => onChange(moveNotebookCell(document, cell.id, 1)))}>↓</button>
          <button type="button" disabled={locked || Boolean(editing)} onClick={() => setDeleteId(cell.id)}>删除</button>
          <button type="button" disabled={Boolean(busy) || Boolean(editing) || externalBusy} onClick={() => void run(cell.id)}>▶ 运行</button>
        </div>
        {editing === cell.id ? <NotebookCellEditor cell={cell} previous={document.cells.slice(0, index)} sources={sources} models={models} connections={connections} disabled={locked} onCancel={() => setEditing(null)} onSave={(next) => { onChange(updateNotebook(document, document.cells.map((item) => item.id === cell.id ? next : item))); setEditing(null); }} /> : <>
          {(cell.kind === "sql" || cell.kind === "warehouseSql") && <pre className="notebook-sql-preview">{cell.sql}</pre>}
          {cell.kind === "warehouseSql" && <p className="notebook-cell-description">连接：{connections.find((item) => item.id === cell.connectionId)?.name ?? "连接不可用"} · 结果来自本次查询，数据库变化后请重新运行</p>}
          {cell.kind === "transform" && <p className="notebook-cell-description">DataRecipe · {cell.steps.length} 个处理步骤 · 输入 {document.cells.find((item) => item.id === cell.inputCellId)?.title}</p>}
          {cell.kind === "text" && <p className="notebook-text">{cell.markdown}</p>}
          {cell.kind === "data" && <p className="notebook-cell-description">来源：{sources.find((source) => source.id === cell.sourceDataSourceId)?.name ?? "数据已移除，请重新导入并编辑来源"}</p>}
          {cell.kind === "semanticQuery" && <p className="notebook-cell-description">模型 v{cell.modelVersion} · {cell.dimensions.join(" / ") || "全局"} → {cell.measures.join(", ")}</p>}
        </>}
        {removed && <div className="notebook-delete" role="alert"><p>删除此单元及 {removed.size - 1} 个依赖它的下游单元？正式看板不受影响。</p><button type="button" disabled={locked} onClick={() => attempt(() => { onChange(updateNotebook(document, document.cells.filter((item) => !removed.has(item.id)))); setDeleteId(null); })}>确认删除 {removed.size} 个单元</button><button type="button" onClick={() => setDeleteId(null)}>保留</button></div>}
        {result?.error && <p className="notebook-error" role="alert">{result.error}</p>}
        {result?.resultRef && <details className="notebook-cell-description"><summary>结果来源</summary><p>运行：{result.resultRef.runId} · 文档 v{result.resultRef.revision} · {result.resultRef.accessMode === "ai" ? "AI 授权结果" : "手动运行结果"}</p><p>结果：{result.resultRef.resultId}</p><p>上游：{result.resultRef.inputResultIds.join(", ") || "源数据"} · {result.resultRef.rowCount} 行{result.resultRef.complete ? "（完整结果）" : "（结果已截断）"}</p></details>}
        {result?.table && !hidden && <NotebookResult key={cached.fingerprint + result.queryId} cell={cell} table={result.table} />}
        {result?.table && onDataset && <button type="button" disabled={locked || Boolean(editing) || result.table.truncated || !result.table.rows.length || cell.kind === "data"} onClick={() => void run(cell.id, false, true)}>保存为 Dataset</button>}
        {result?.table && <div className="notebook-cell-footer"><small>{result.queryId ? `查询记录 ${result.queryId.slice(-8)}` : "当前运行结果"}</small><button type="button" disabled={locked || Boolean(editing) || result.table.truncated || !result.table.rows.length || result.table.rows.length > 500 || cell.kind === "data"} title="重新运行后生成快照；最多 500 行；先预览再确认" onClick={() => void run(cell.id, true)}>生成看板预览 ↗</button></div>}
      </article>;
    })}</div>
    <div className="notebook-add" aria-label="添加分析单元"><span>添加单元</span>{(Object.keys(labels) as HarnessNotebookCell["kind"][]).map((kind) => <button key={kind} type="button" disabled={locked || Boolean(editing) || document.cells.length >= 30} onClick={() => addCell(kind)}>＋ {labels[kind]}</button>)}</div>
  </section>;
}
