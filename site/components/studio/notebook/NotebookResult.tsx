"use client";

import { Button } from "@/components/ui/button";
import { useState } from "react";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookTable } from "@/core/notebook/contracts";
import { notebookResultAvailability, type NotebookResultAvailability } from "@/core/notebook/result-availability";
import { NotebookChart } from "./NotebookChart";
import { NotebookResultTable } from "./NotebookResultTable";
import { NotebookMaterializedChart } from "./NotebookMaterializedChart";
import type { MaterializedVisualization, VisualizationIdentity } from "@/core/visualization/result";

export function NotebookResult({ cell, table, availability, visualization, identity, visualizationNotice }: { cell: NotebookCell; table: NotebookTable; availability?: NotebookResultAvailability;
  visualization?: MaterializedVisualization; identity?: VisualizationIdentity; visualizationNotice?: string }) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const scope = availability ?? notebookResultAvailability(cell, { cellId: cell.id, status: "success", durationMs: 0, table });
  if (cell.kind !== "chart") return <div className="notebook-result"><NotebookResultTable title={cell.title} table={table} availability={scope} /></div>;
  if (visualization && identity) return <NotebookMaterializedChart cell={cell} result={visualization} identity={identity} table={table} scope={scope} />;
  return <div className="notebook-result">
    {cell.kind === "chart" && <div className="notebook-result-view" role="group" aria-label={`${cell.title}结果视图`}>
      <Button variant="ghost" type="button" aria-pressed={view === "chart"} onClick={() => setView("chart")}>图表</Button>
      <Button variant="ghost" type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>{cell.graphicWalker ? "输入数据" : "数据"}</Button>
      <span>{scope.completeness === "complete" && !scope.previewOnly ? `完整结果 ${scope.knownRowCount} 行` : `当前预览 ${scope.previewRowCount} 行 · ${scope.completeness === "incomplete" ? "结果不完整" : scope.completeness === "inconsistent" ? "结果元数据不一致" : scope.completeness === "unknown" ? "完整性未知" : `完整结果 ${scope.knownRowCount} 行`}`}</span>
    </div>}
    <p className="notebook-config-hint">{visualizationNotice ?? "当前为兼容预览；运行本单元后，支持的图表将显示完整上游计算结果。"}</p>
    {cell.graphicWalker && <p className="notebook-config-hint">此预览由 Graphic Walker 基于本次返回的输入计算；输入表和 Dataset 不代表聚合结果。</p>}
    {cell.kind === "chart" && <div hidden={view !== "chart"}><NotebookChart cell={cell} table={table} /></div>}
    <div hidden={view !== "table"} className="notebook-result"><NotebookResultTable title={cell.title} table={table} availability={scope} /></div>
  </div>;
}
