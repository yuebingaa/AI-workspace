"use client";

import { useMemo } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogClose } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { DataRow, DataSourceDefinition } from "@/core/models";
import { ChartEditorBoundary } from "./ChartEditorBoundary";
import { useChartExitGuard } from "./useChartExitGuard";

export function ChartEditorDialog({ source, rows, onClose }: { source?: DataSourceDefinition; rows: DataRow[]; onClose(): void }) {
  const exit = useChartExitGuard(onClose);
  const dataset = useMemo(() => source ? { id: source.id, name: source.name, rows, totalRows: source.rowCount,
    fields: source.fields.map(field => ({ id: field.name, name: field.label, type: field.type })) } : undefined, [source, rows]);
  return <><Dialog open onOpenChange={open => { if (!open) exit.requestClose(); }}><DialogContent maxWidth="1600px" style={{ width: "96vw", padding: 16 }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}><div><DialogTitle>交互图表分析</DialogTitle><DialogDescription size="1">单图配置独立保存，不修改 Notebook、源数据或看板布局。</DialogDescription></div><DialogClose><Button aria-label="关闭图表编辑器">关闭</Button></DialogClose></div>
    <div style={{ height: "78vh", marginTop: 12 }}><ChartEditorBoundary dataset={dataset} onDirtyChange={exit.onDirtyChange} /></div>
  </DialogContent></Dialog>{exit.confirmation}</>;
}
