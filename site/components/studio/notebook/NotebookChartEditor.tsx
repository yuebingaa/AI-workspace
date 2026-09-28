"use client";

import { Button } from "@/components/ui/button";
import { SelectField, SelectItem, TextInput } from "@/components/ui/fields";
import { useId, useState, type FormEvent } from "react";
import type { NotebookCell } from "@/core/notebook/definition";
import { notebookCellSchema } from "@/core/notebook/definition";
import type { NotebookTable } from "@/core/notebook/contracts";
import { notebookOutputCells } from "@/core/notebook/client-state";
import { projectPresentationTable } from "@/core/notebook/presentation-table";
import { SearchSelect } from "@/components/ui/search-select";
import { NotebookChart } from "./NotebookChart";

type ChartCell = Extract<NotebookCell, { kind: "chart" }>;
export type NotebookInputCatalog = Record<string, { fields: NotebookTable["fields"]; table?: NotebookTable }>;
const emptyCatalog: NotebookInputCatalog = {};
const types = [["bar", "柱状图", "▥"], ["line", "折线图", "⌁"], ["area", "面积图", "◩"], ["pie", "饼图", "◕"], ["donut", "环形图", "◎"]] as const;

/** Configuration previews use current upstream rows; they never become execution receipts. */
export function NotebookChartEditor({ cell, availableInputs, inputCatalog = emptyCatalog, disabled, onSave, onCancel }: {
  cell: ChartCell; availableInputs: NotebookCell[]; inputCatalog?: NotebookInputCatalog; disabled: boolean;
  onSave(cell: NotebookCell): void; onCancel(): void;
}) {
  const id = useId(), [draft, setDraft] = useState(cell), [error, setError] = useState("");
  const inputs = notebookOutputCells(availableInputs);
  const { fields = [], table } = inputCatalog[draft.inputCellId] ?? {};
  const options = fields.map(field => ({ value: field.name, label: field.label, detail: `${field.name} · ${field.type}` }));
  const numeric = fields.filter(field => field.type === "number");
  let preview: NotebookTable | undefined, previewError = "";
  if (fields.length && draft.categoryField && draft.valueFields.length) {
    try { preview = projectPresentationTable(draft, table ?? { fields, rows: [], truncated: false }); }
    catch (caught) { previewError = caught instanceof Error ? caught.message : "请检查图表字段"; }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled) return;
    if (!draft.categoryField || !draft.valueFields.length) { setError("请选择一个分类字段和至少一个数值字段。"); return; }
    if (previewError) { setError(previewError); return; }
    try { onSave(notebookCellSchema.parse(draft)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "请选择分类与数值字段"); }
  }
  return <form className="notebook-editor notebook-chart-editor" onSubmit={submit}>
    <div className="notebook-chart-workspace">
      <fieldset disabled={disabled} className="notebook-chart-controls">
        <div className="notebook-config-heading"><b>图表配置</b><span>选择字段，即时预览</span></div>
        <label>单元名称<TextInput value={draft.title} maxLength={120} required onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
        <label>上游输出<SelectField aria-label="上游输出" value={draft.inputCellId} onValueChange={selectedValue => {
          const inputCellId = selectedValue, next = inputCatalog[inputCellId]?.fields ?? [];
          setDraft({ ...draft, inputCellId, categoryField: next.find(field => field.type !== "number")?.name ?? next[0]?.name ?? "",
            valueFields: next.filter(field => field.type === "number").slice(0, 1).map(field => field.name) }); setError("");
        }}>{inputs.map(input => <SelectItem key={input.id} value={input.id}>{input.outputName} · {input.title}</SelectItem>)}</SelectField></label>
        <div className="notebook-chart-types" role="group" aria-label="图表类型">{types.map(([value, label, icon]) =>
          <Button variant="secondary" key={value} type="button" aria-pressed={draft.chartType === value} onClick={() => { setDraft({ ...draft, chartType: value }); setError(""); }}>
            <span aria-hidden="true">{icon}</span>{label}</Button>)}</div>
        <div className="notebook-axis-field"><label htmlFor={`${id}-category`}>X 轴 · 分类字段</label>
          <SearchSelect id={`${id}-category`} label="分类字段" value={draft.categoryField} options={options} disabled={disabled || !fields.length}
            invalid={Boolean(fields.length && !fields.some(field => field.name === draft.categoryField))} placeholder="选择分类字段"
            onValueChange={categoryField => { setDraft({ ...draft, categoryField }); setError(""); }} /></div>
        <div className="notebook-axis-field"><label>Y 轴 · 数值字段 <small>{draft.valueFields.length} / 4</small></label>
          <div className="notebook-selected-fields">{draft.valueFields.map(name => <div key={name}>
            <span><b>#</b> {fields.find(field => field.name === name)?.label ?? name}</span>
            <Button variant="secondary" type="button" aria-label={`移除数值字段 ${name}`} onClick={() => setDraft({ ...draft, valueFields: draft.valueFields.filter(field => field !== name) })}>×</Button>
          </div>)}</div>
          <SearchSelect id={`${id}-value`} label="添加数值字段" value="" placeholder={draft.valueFields.length >= 4 ? "已添加 4 个数值字段" : "＋ 添加数值字段"} disabled={disabled || !numeric.some(field => !draft.valueFields.includes(field.name)) || draft.valueFields.length >= 4}
            options={numeric.filter(field => !draft.valueFields.includes(field.name)).map(field => ({ value: field.name, label: field.label, detail: field.name }))}
            onValueChange={name => { setDraft({ ...draft, valueFields: [...draft.valueFields, name] }); setError(""); }} />
        </div>
        {!fields.length && <p className="notebook-config-hint">先运行上游步骤，即可搜索和选择数据字段。</p>}
        {!!fields.length && !numeric.length && <p className="notebook-config-hint">上游没有数值字段，请先在 SQL 中整理需要绘图的数值。</p>}
        {!fields.length && <details className="notebook-chart-manual"><summary>手动设置字段</summary>
          <label>分类字段名<TextInput value={draft.categoryField} onChange={event => setDraft({ ...draft, categoryField: event.target.value })} /></label>
          <label>数值字段名（逗号分隔）<TextInput value={draft.valueFields.join(", ")} onChange={event => setDraft({ ...draft, valueFields: event.target.value.split(/[,，]/u).map(name => name.trim()).filter(Boolean) })} /></label>
        </details>}
      </fieldset>
      <section className="notebook-chart-preview" aria-label="图表配置预览">
        <header><div><span>图表预览</span><h3>{draft.title || "未命名图表"}</h3></div><span>未保存</span></header>
        {previewError ? <p role="alert" className="notebook-error">{previewError}</p>
          : table && preview && draft.valueFields.length ? <NotebookChart cell={draft} table={preview} />
            : <div className="notebook-chart-empty"><span aria-hidden="true">▥</span><b>{table ? "选择分类和数值字段" : "等待上游数据"}</b><p>{table ? "选择后，图表会显示在这里。" : "运行上游步骤后，再打开图表配置查看预览。"}</p></div>}
        <p className="notebook-config-hint">{table ? `基于上游当前返回的 ${table.rows.length} 行预览；图表最多绘制前 100 行。保存后运行，生成正式结果。` : "字段配置可以先保存；正式结果由运行生成。"}</p>
      </section>
    </div>
    {error && <p role="alert">{error}</p>}
    <footer><Button variant="secondary" type="button" onClick={onCancel}>取消编辑</Button><Button variant="primary" type="submit" className="notebook-primary" disabled={disabled}>保存单元</Button></footer>
  </form>;
}
