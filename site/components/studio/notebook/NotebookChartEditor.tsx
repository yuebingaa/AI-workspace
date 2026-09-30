"use client";

import { useCallback, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, SelectItem } from "@/components/ui/fields";
import { ChartEditorBoundary, NativeChartEditorBoundary } from "@/components/chart-editor/ChartEditorBoundary";
import { useChartExitGuard } from "@/components/chart-editor/useChartExitGuard";
import type { NotebookCell } from "@/core/notebook/definition";
import { notebookOutputCells } from "@/core/notebook/client-state";
import { notebookChartConfig, notebookChartDataset, supportsNotebookGraphicWalker, validateNotebookChartConfig } from "@/core/notebook/graphic-walker";
import { LegacyNotebookChartEditor, type NotebookInputCatalog } from "./LegacyNotebookChartEditor";
import type { ChartConfig } from "@/core/chart-editor/config";
import { authorNotebookChart } from "@/core/notebook/chart-authoring";
import "./notebook-graphic-walker.css";

export type { NotebookInputCatalog } from "./LegacyNotebookChartEditor";
type ChartCell = Extract<NotebookCell, { kind: "chart" }>;
type Props = { cell: ChartCell; availableInputs: NotebookCell[]; inputCatalog?: NotebookInputCatalog;
  disabled: boolean; onSave(cell: NotebookCell): void; onCancel(): void;
  layout?: "data-style" | "native"; persistent?: boolean; onDirtyChange?(dirty: boolean): void };
const noFields: NotebookInputCatalog[string]["fields"] = [];

export function NotebookChartEditor(props: Props) {
  if (!supportsNotebookGraphicWalker(props.cell)) return <><p className="notebook-config-hint">此图包含多个数值序列或饼 / 环形图，继续使用兼容编辑器，不自动删减序列。</p><LegacyNotebookChartEditor {...props} /></>;
  return <InlineChartEditor {...props} />;
}

function InlineChartEditor({ cell, availableInputs, inputCatalog = {}, disabled, onSave, onCancel, layout = "native", persistent = false, onDirtyChange }: Props) {
  const [inputId, setInputId] = useState(cell.inputCellId);
  const [chartDirty, setChartDirty] = useState(false);
  const { onDirtyChange: setDirty, requestClose, confirmation } = useChartExitGuard(onCancel);
  const selected = inputCatalog[inputId];
  const fields = selected?.fields ?? noFields;
  const table = selected?.table;
  const current: ChartCell = inputId === cell.inputCellId ? cell : { ...cell, inputCellId: inputId, graphicWalker: undefined,
    categoryField: fields.find(field => field.type !== "number")?.name ?? fields[0]?.name ?? "",
    valueFields: fields.filter(field => field.type === "number").slice(0, 1).map(field => field.name) };
  const dataset = useMemo(() => notebookChartDataset({ ...cell, inputCellId: inputId }, table ?? { fields, rows: [], truncated: true }), [cell, inputId, table, fields]);
  const initialKey = JSON.stringify(current);
  const initial = useMemo(() => notebookChartConfig(JSON.parse(initialKey) as ChartCell, dataset), [initialKey, dataset]);
  const dirtyChanged = useCallback((dirty: boolean) => {
    setChartDirty(dirty); setDirty(dirty || inputId !== cell.inputCellId); onDirtyChange?.(dirty || inputId !== cell.inputCellId);
  }, [inputId, cell.inputCellId, setDirty, onDirtyChange]);
  function save(config: ChartConfig) {
    if (disabled) throw Error("当前 Notebook 不可编辑。");
    if (!selected?.table) throw Error("请先运行上游单元，再保存图表；未使用过期结果。");
    const valid = validateNotebookChartConfig(config, dataset);
    onSave(authorNotebookChart({ id: current.id, inputCellId: current.inputCellId, title: valid.title,
      mark: valid.mark as "bar" | "line" | "area", channels: { ...valid.channels, x: valid.channels.x!, y: valid.channels.y! }, filters: valid.filters, style: valid.style }, current));
  }
  return <div className="notebook-editor notebook-gw-editor">
    <div className="notebook-gw-source"><label>上游输出<SelectField aria-label="上游输出" value={inputId} disabled={disabled || chartDirty}
      onValueChange={id => { setInputId(id); setDirty(id !== cell.inputCellId); onDirtyChange?.(id !== cell.inputCellId); }}>
      {notebookOutputCells(availableInputs).map(input => <SelectItem key={input.id} value={input.id}>{input.outputName} · {input.title}</SelectItem>)}
    </SelectField></label><Button disabled={disabled} onClick={requestClose}>{persistent ? "放弃修改" : "取消编辑"}</Button></div>
    <p className="notebook-config-hint">编辑预览仅使用已返回的上游数据。保存后点击本单元“运行”，支持的配置将使用完整上游重新计算；{persistent ? "可在下方展开已保存配置的完整运行结果。" : "正式结果可切换“图表 / 图表数据 / 输入数据”。"}{chartDirty ? "切换上游前请先保存或恢复配置。" : ""}
      {!cell.graphicWalker && " 当前为新版预览：相同 X 轴和分组按所选方式聚合；取消不会改变原图。"}</p>
    {!selected?.table && <p role="status" className="gw-notice">等待上游数据。{disabled ? "当前只读或执行中，取得有效上游结果后会自动更新。" : persistent ? "请运行本单元或全部运行，字段区会自动载入本次数据；若已有未保存修改，请先放弃修改。" : "请取消编辑并运行上游步骤，再回来配置；"}不会拿旧结果冒充当前数据。</p>}
    <fieldset disabled={disabled} inert={disabled} className={layout === "native" ? "notebook-native-gw-host" : "notebook-gw-host"}>
      {layout === "native" ? <NativeChartEditorBoundary key={dataset.id} dataset={dataset} config={initial} onSave={save} onDirtyChange={dirtyChanged} />
        : <ChartEditorBoundary key={dataset.id} dataset={dataset} owner={{ config: initial, onSave: save }} allowedMarks={["bar", "line", "area"]} onDirtyChange={dirtyChanged}
          dataUnavailable={!table ? "配置已保留；取得本次有效上游结果后显示图表，不使用旧数据。" : undefined} />}
    </fieldset>
    {confirmation}
  </div>;
}
