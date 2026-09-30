"use client";

import { useRef } from "react";
import { Button } from "@/components/ui/button";
import type { NotebookLiveState } from "@/core/notebook/live-state";
import { notebookResultAvailability } from "@/core/notebook/result-availability";
import { NotebookResult } from "./NotebookResult";
import { NotebookSource } from "./NotebookSource";
import { NotebookTextResult } from "./NotebookTextResult";
import { NotebookOutline } from "./NotebookOutline";
import { cellSource } from "./cell-source";
import { notebookCellPresentation } from "./cell-presentation";
import { NotebookChartWorkspace } from "./NotebookChartWorkspace";
import { supportsNotebookGraphicWalker } from "@/core/notebook/graphic-walker";
import { notebookDependencyCandidates } from "@/core/notebook/graph";

const statusLabels = { pending: "待运行", stale: "已失效 · 等待重算", queued: "排队中", running: "运行中",
  success: "已完成", failure: "执行失败", blocked: "上游失败 · 已阻断" };
const readOnlyDirty = () => {};
const refuseLiveSave = () => { throw Error("AI 实时草稿只读，请先确认更改。"); };

/** Uses the existing code/table/chart renderers; no second editor, executor or save path. */
export function NotebookLivePreview({ live, onShowFormal }: { live: NotebookLiveState; onShowFormal(): void }) {
  const root = useRef<HTMLElement>(null);
  const stopped = live.phase === "cancelled" || live.phase === "failed";
  const navigate = (id: string) => {
    const element = [...(root.current?.querySelectorAll<HTMLElement>("article[data-cell-id]") ?? [])].find(item => item.dataset.cellId === id);
    element?.scrollIntoView({ block: "start" }); element?.focus({ preventScroll: true });
  };
  return <section ref={root} className="notebook-panel notebook-view-steps has-cells notebook-live-preview" aria-label="Notebook 实时草稿">
    <header className="notebook-heading"><div><h2>{live.document.name}</h2><p role="status">
      {live.phase === "cancelled" ? "任务已取消" : live.phase === "failed" ? "任务未完成" : "AI 正在处理"} · 草稿 v{live.editVersion} · 未保存</p></div>
      <Button variant="secondary" onClick={onShowFormal}>查看正式文档</Button></header>
    <div className="notebook-page-body"><NotebookOutline cells={live.document.cells} onNavigate={navigate} />
      <div className="notebook-document-content">
        <p className="notebook-live-notice">{stopped ? "保留本轮只读过程供检查，不能采用；正式 Notebook 未改动。" : "单元与结果随实际执行更新；试运行预览不是正式保存，最终核验后仍需确认更改。"}</p>
        <div className="notebook-cells">{live.document.cells.map((cell, index) => {
          const status = live.statuses[cell.id] ?? "pending", result = live.results[cell.id];
          const source = cellSource(cell), presentation = notebookCellPresentation[cell.kind];
          const inlineChart = cell.kind === "chart" && supportsNotebookGraphicWalker(cell);
          const label = stopped && ["pending", "queued", "running", "stale"].includes(status)
            ? live.phase === "cancelled" ? "已取消" : "已中止 · 未取得结果" : statusLabels[status];
          const availability = result && live.runId ? notebookResultAvailability(cell, result, { runId: live.runId,
            revision: live.baseline.revision, accessMode: "ai" }) : undefined;
          return <article key={cell.id} className="notebook-cell" data-cell-id={cell.id} data-cell-kind={cell.kind} tabIndex={-1} aria-label={`${presentation.label}单元 ${cell.title}`}>
            <header><span className="notebook-cell-number">{String(index + 1).padStart(2, "0")}</span>
              <span className="notebook-kind">{presentation.label}</span><h2>{cell.title}</h2>
              {"outputName" in cell && <code className="notebook-output-name">{cell.outputName}</code>}
              <span className={`notebook-cell-status ${status}`} data-live-status={status}>{label}</span></header>
            <div className="notebook-cell-body"><div className="notebook-cell-definition">
              {inlineChart && cell.kind === "chart" ? <NotebookChartWorkspace cell={cell} availableInputs={notebookDependencyCandidates(live.document.cells, cell.id)} disabled
                inputCatalog={Object.fromEntries(notebookDependencyCandidates(live.document.cells, cell.id).map(input => {
                  const table = live.statuses[input.id] === "success" ? live.results[input.id]?.table : undefined;
                  return [input.id, { fields: table?.fields ?? [], table }];
                }))} onDirtyChange={readOnlyDirty} onSave={refuseLiveSave} />
                : ["sql", "python", "warehouseSql"].includes(cell.kind) ? <NotebookSource value={source.value} language={source.language} label={`${cell.title} 源码`} />
                : cell.kind === "text" ? <NotebookTextResult cell={cell} cells={live.document.cells} result={result} stale={status === "stale"} running={status === "running"} />
                  : <details><summary>查看{presentation.sourceLabel}</summary><NotebookSource value={source.value} language={source.language} label={`${cell.title} 配置`} /></details>}
            </div><div className="notebook-cell-output">
              {result?.table && !inlineChart && <NotebookResult key={`${live.runId}:${cell.id}`} cell={cell} table={result.table} availability={availability} />}
              {result?.error && <p className="notebook-error" role="alert">{result.error}</p>}
              {result?.text && result.text.length >= 2000 && <small>实时文本最多展示 2,000 字；完整说明以最终预览为准。</small>}
            </div></div>
          </article>;
        })}</div>
        <p className="notebook-live-notice">实时表格最多展示 50 行且受字节上限约束；不会用这份预览继续计算或保存。新结果不会强制滚动，可用大纲定位。</p>
      </div></div>
  </section>;
}
