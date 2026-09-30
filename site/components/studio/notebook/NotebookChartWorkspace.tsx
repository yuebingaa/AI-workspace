"use client";

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import type { NotebookCell } from "@/core/notebook/definition";
import { NotebookChartEditor, type NotebookInputCatalog } from "./NotebookChartEditor";

type Props = {
  cell: Extract<NotebookCell, { kind: "chart" }>; availableInputs: NotebookCell[]; inputCatalog: NotebookInputCatalog;
  disabled: boolean; onSave(cell: NotebookCell): void; onDirtyChange(id: string, dirty: boolean): void;
};

/** A chart is an always-open authoring surface, not a read-only output that needs
 * an Edit click. The two existing layouts share the same saved Notebook contract. */
export function NotebookChartWorkspace({ cell, onDirtyChange, ...props }: Props) {
  const [layout, setLayout] = useState<"data-style" | "native">("data-style");
  const [dirty, setDirty] = useState(false);
  const [reset, setReset] = useState(0);
  const changed = useCallback((value: boolean) => { setDirty(value); onDirtyChange(cell.id, value); }, [cell.id, onDirtyChange]);
  const discard = () => { changed(false); setReset(value => value + 1); };
  return <section className="notebook-inline-chart-workspace" aria-label={`${cell.title} · 图表编辑区`} data-layout={layout}>
    <div className="notebook-chart-layout" role="group" aria-label="图表编辑布局">
      <Button size="small" variant="ghost" aria-pressed={layout === "data-style"} disabled={dirty || props.disabled} onClick={() => setLayout("data-style")}>Data / Style 布局</Button>
      <Button size="small" variant="ghost" aria-pressed={layout === "native"} disabled={dirty || props.disabled} onClick={() => setLayout("native")}>官方原生布局</Button>
      <span>{dirty ? "未保存 · 保存或放弃后可切换布局" : "字段与配置默认展开 · 保存后保持可见"}</span>
    </div>
    <NotebookChartEditor key={`${JSON.stringify(cell)}:${layout}:${reset}`} {...props} cell={cell} layout={layout} persistent onDirtyChange={changed} onCancel={discard} />
  </section>;
}
