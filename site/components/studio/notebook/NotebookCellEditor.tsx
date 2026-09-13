import { useState, type FormEvent } from "react";
import type { DataSourceDefinition } from "@/core/models";
import type { SemanticModel } from "@/core/semantic/contracts";
import { harnessNotebookCellSchema, type HarnessNotebookCell } from "@/core/harness/notebook-contracts";
import { notebookOutputCells } from "@/core/notebook/client-state";
import { RecipeStepsEditor } from "./RecipeStepsEditor";
import type { ConnectionDescriptor } from "@/core/connections/contracts";

export function NotebookCellEditor({ cell, previous, sources, models, connections = [], disabled, onSave, onCancel }: {
  cell: HarnessNotebookCell; previous: HarnessNotebookCell[]; sources: DataSourceDefinition[]; models: SemanticModel[];
  disabled: boolean; onSave: (cell: HarnessNotebookCell) => void; onCancel: () => void;
  connections?: ConnectionDescriptor[];
}) {
  const [draft, setDraft] = useState(cell);
  const [error, setError] = useState("");
  const [lists, setLists] = useState({ dimensions: cell.kind === "semanticQuery" ? cell.dimensions.join(", ") : "",
    measures: cell.kind === "semanticQuery" ? cell.measures.join(", ") : "", columns: cell.kind === "table" ? cell.columns.join(", ") : "",
    valueFields: cell.kind === "chart" ? cell.valueFields.join(", ") : "" });
  const outputs = notebookOutputCells(previous);
  const patch = (value: Partial<HarnessNotebookCell>) => setDraft({ ...draft, ...value } as HarnessNotebookCell);
  const list = (value: string) => value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean);
  function submit(event: FormEvent) {
    event.preventDefault();
    const value = draft.kind === "semanticQuery" ? { ...draft, dimensions: list(lists.dimensions), measures: list(lists.measures) }
      : draft.kind === "table" ? { ...draft, columns: list(lists.columns) }
        : draft.kind === "chart" ? { ...draft, valueFields: list(lists.valueFields) } : draft;
    try { onSave(harnessNotebookCellSchema.parse(value)); } catch (caught) { setError(caught instanceof Error ? caught.message : "单元格式无效"); }
  }
  const model = draft.kind === "semanticQuery" ? models.find((item) => item.id === draft.modelId) : undefined;
  return <form className="notebook-editor" onSubmit={submit}>
    <fieldset disabled={disabled}>
      <label>单元名称<input value={draft.title} maxLength={120} required onChange={(event) => patch({ title: event.target.value })} /></label>
      {"outputName" in draft && <label>输出表名（SQL 中使用）<input value={draft.outputName} required pattern="[A-Za-z][A-Za-z0-9_]*" maxLength={120} onChange={(event) => patch({ outputName: event.target.value })} /></label>}
      {draft.kind === "data" && <label>数据源<select aria-label="数据源" value={draft.sourceDataSourceId} onChange={(event) => patch({ sourceDataSourceId: event.target.value })}>
        {!sources.some((item) => item.id === draft.sourceDataSourceId) && <option value={draft.sourceDataSourceId}>原数据已移除，请重新选择</option>}
        {sources.map((source) => <option key={source.id} value={source.id}>{source.name} · {source.rowCount} 行</option>)}
      </select></label>}
      {draft.kind === "sql" && <>
        <div className="notebook-input-list"><b>输入表（勾选后才能在 SQL 中查询）</b>{outputs.map((item) => <label key={item.id}>
          <input type="checkbox" checked={draft.inputCellIds.includes(item.id)} onChange={(event) => patch({ inputCellIds: event.target.checked ? [...draft.inputCellIds, item.id] : draft.inputCellIds.filter((id) => id !== item.id) })} />
          <code>{item.outputName}</code><span>{item.title}</span>
        </label>)}</div>
        <label className="notebook-wide">SQL<textarea aria-label="SQL" className="notebook-code" spellCheck={false} value={draft.sql} maxLength={10_000} required rows={8} onChange={(event) => patch({ sql: event.target.value })} /></label>
        <small className="notebook-wide">本地 DuckDB · 只读查询 · 单条 SELECT / WITH · 8 秒超时 · 最多 1000 行。字段名使用双引号。</small>
      </>}
      {draft.kind === "warehouseSql" && <>
        <label>数据库连接<select aria-label="数据库连接" value={draft.connectionId} onChange={(event) => patch({ connectionId: event.target.value })}>
          {!connections.some((item) => item.id === draft.connectionId) && <option value={draft.connectionId}>连接不可用，请重新选择</option>}
          {connections.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.kind}</option>)}
        </select></label>
        <label className="notebook-wide">SQL<textarea aria-label="SQL" className="notebook-code" value={draft.sql} rows={8} maxLength={10_000} required spellCheck={false} onChange={(event) => patch({ sql: event.target.value })} /></label>
        <small className="notebook-wide">查询所选数据库的表；最多返回 1000 行。需要继续处理时，请先在数据库完成大表筛选和聚合。</small>
      </>}
      {"inputCellId" in draft && <label>上游输出<select aria-label="上游输出" value={draft.inputCellId} onChange={(event) => patch({ inputCellId: event.target.value })}>
        {outputs.filter((item) => draft.kind !== "semanticQuery" || item.kind === "data").map((item) => <option key={item.id} value={item.id}>{item.outputName} · {item.title}</option>)}
      </select></label>}
      {draft.kind === "semanticQuery" && <>
        <label>语义模型<select aria-label="语义模型" value={draft.modelId} onChange={(event) => {
          const next = models.find((item) => item.id === event.target.value);
          if (next) { patch({ modelId: next.id, modelVersion: next.version }); setLists({ ...lists, dimensions: next.dimensions.slice(0, 1).map((item) => item.key).join(", "), measures: next.measures.slice(0, 1).map((item) => item.key).join(", ") }); }
        }}>{!model && <option value={draft.modelId}>模型已移除</option>}{models.map((item) => <option value={item.id} key={item.id}>{item.name} · v{item.version}</option>)}</select></label>
        <label>维度标识（逗号分隔）<input value={lists.dimensions} onChange={(event) => setLists({ ...lists, dimensions: event.target.value })} /></label>
        <label>指标标识（逗号分隔）<input value={lists.measures} required onChange={(event) => setLists({ ...lists, measures: event.target.value })} /></label>
        {model && <small className="notebook-wide">可用维度：{model.dimensions.map((item) => item.key).join(", ") || "无"}；指标：{model.measures.map((item) => item.key).join(", ")}。保存时使用模型 v{draft.modelVersion}，来源必须匹配。</small>}
        <label>结果上限<input type="number" value={draft.limit} min={1} max={100} onChange={(event) => patch({ limit: Number(event.target.value) })} /></label>
      </>}
      {draft.kind === "table" && <label className="notebook-wide">展示字段（逗号分隔，使用结果中的字段名）<input value={lists.columns} required onChange={(event) => setLists({ ...lists, columns: event.target.value })} /></label>}
      {draft.kind === "transform" && <RecipeStepsEditor steps={draft.steps} onChange={(steps) => patch({ steps })} />}
      {draft.kind === "chart" && <>
        <label>图表类型<select aria-label="图表类型" value={draft.chartType} onChange={(event) => patch({ chartType: event.target.value as typeof draft.chartType })}>{[["bar", "柱状图"], ["line", "折线图"], ["area", "面积图"], ["pie", "饼图"], ["donut", "环形图"]].map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>
        <label>分类字段<input value={draft.categoryField} required onChange={(event) => patch({ categoryField: event.target.value })} /></label>
        <label>数值字段（逗号分隔，最多 4 个）<input value={lists.valueFields} required onChange={(event) => setLists({ ...lists, valueFields: event.target.value })} /></label>
      </>}
      {draft.kind === "text" && <label className="notebook-wide">分析说明<textarea aria-label="分析说明" value={draft.markdown} maxLength={4_000} required rows={6} onChange={(event) => patch({ markdown: event.target.value })} /></label>}
    </fieldset>
    {error && <p role="alert">{error}</p>}
    <footer><button type="button" onClick={onCancel}>取消编辑</button><button type="submit" className="notebook-primary" disabled={disabled}>保存单元</button></footer>
  </form>;
}
