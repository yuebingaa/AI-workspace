"use client";

import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { MaterializedChartCanvasBoundary } from "@/components/chart-editor/ChartEditorBoundary";
import { notebookVisualization } from "@/core/notebook/visualization";
import { parseMaterializedVisualization, type MaterializedVisualization, type VisualizationIdentity } from "@/core/visualization/result";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookTable } from "@/core/notebook/contracts";
import type { NotebookResultAvailability } from "@/core/notebook/result-availability";
import { NotebookResultTable } from "./NotebookResultTable";
import "./notebook-graphic-walker.css";

export function NotebookMaterializedChart({ cell, result, identity, table, scope }: {
  cell: Extract<NotebookCell, { kind: "chart" }>; result: MaterializedVisualization; identity: VisualizationIdentity;
  table: NotebookTable; scope: NotebookResultAvailability;
}) {
  const [view, setView] = useState<"chart" | "result" | "input">("chart");
  const candidate = useMemo(() => notebookVisualization(cell), [cell]);
  const [verified, setVerified] = useState<{ key: string; result?: MaterializedVisualization; error?: string }>();
  const key = JSON.stringify([candidate, result, identity, scope.knownRowCount, scope.completeness]);
  useEffect(() => {
    let active = true;
    const verify = async () => {
      if (!candidate.definition) throw Error(candidate.reason);
      if (scope.completeness !== "complete" || scope.knownRowCount === null) throw Error("缺少本次完整上游的运行证据。");
      return parseMaterializedVisualization(result, candidate.definition, { ...identity,
        inputResultId: `${identity.runId}:${cell.inputCellId}`, inputRowCount: scope.knownRowCount });
    };
    void verify().then(value => { if (active) setVerified({ key, result: value }); }, error => {
      if (active) setVerified({ key, error: error instanceof Error ? error.message : "图表结果无法验证。" });
    });
    return () => { active = false; };
  }, [candidate, result, identity, cell.inputCellId, key, scope.knownRowCount, scope.completeness]);
  const current = verified?.key === key ? verified : undefined;
  if (!current) return <p role="status">正在核对本次图表计算结果…</p>;
  if (!current.result || !candidate.definition) return <p role="alert">{current.error ?? "图表定义不支持"} 请重新运行本单元。</p>;
  const computed = current.result, rows = computed.table.rows.length;
  const computedScope: NotebookResultAvailability = { previewRowCount: rows, knownRowCount: rows, completeness: "complete", previewOnly: false, canSaveDataset: false, canSnapshot: false };
  return <div className="notebook-result notebook-materialized-result">
    <div className="notebook-result-view" role="group" aria-label={`${cell.title}结果视图`}>
      <Button variant="ghost" aria-pressed={view === "chart"} onClick={() => setView("chart")}>图表</Button>
      <Button variant="ghost" aria-pressed={view === "result"} onClick={() => setView("result")}>图表数据</Button>
      <Button variant="ghost" aria-pressed={view === "input"} onClick={() => setView("input")}>输入数据</Button>
      <span>已计算 · {rows} 行结果</span>
    </div>
    <div hidden={view !== "chart"} className="notebook-gw-output"><MaterializedChartCanvasBoundary definition={candidate.definition} result={computed} styleConfig={cell.graphicWalker} /></div>
    {view === "result" && <NotebookResultTable title={`${cell.title} · 图表计算结果`} table={computed.table} availability={computedScope} />}
    {view === "input" && <><p className="notebook-config-hint">以下是输入预览；保存为 Dataset 和下游引用仍使用输入表，不是图表聚合结果。</p><NotebookResultTable title={cell.title} table={table} availability={scope} /></>}
  </div>;
}
