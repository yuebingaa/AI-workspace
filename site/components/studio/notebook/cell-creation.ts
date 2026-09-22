import type { DataSourceDefinition } from "@/core/models";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookTable } from "@/core/notebook/contracts";
import type { SemanticModel } from "@/core/semantic/contracts";
import type { ConnectionDescriptor } from "@/core/connections/contracts";
import { notebookOutputCells } from "@/core/notebook/client-state";
import { notebookCellPresentation } from "./cell-presentation";

export type NotebookCellCreationContext = {
  id: string;
  suffix: string;
  cells: NotebookCell[];
  sources: readonly DataSourceDefinition[];
  models: readonly SemanticModel[];
  connections: readonly ConnectionDescriptor[];
  fieldsFor: (cell: NotebookCell) => readonly NotebookTable["fields"][number][];
  connectionId?: string;
  sql?: string;
  sourceId?: string;
};

// Manual-editor defaults, not Agent creation policy. The caller owns identity,
// fresh-field selection, document validation/persistence and opening the editor.
export function createNotebookCell(kind: NotebookCell["kind"], context: NotebookCellCreationContext): NotebookCell {
  const { id, suffix, cells, sources, models, connections, fieldsFor, connectionId, sql, sourceId } = context;
  const outputName = `${kind}_${cells.length + 1}_${suffix.slice(0, 3)}`;
  const common = { id, title: kind === "sql" ? "SQL 数据分析" : `${notebookCellPresentation[kind].label}单元` };
  const outputs = notebookOutputCells(cells);
  const last = outputs.at(-1);
  if (kind === "text") return { ...common, kind, markdown: "在这里记录分析问题、结论和口径说明。" };
  if (kind === "parameter") return { ...common, kind, outputName, parameter: { type: "text", value: "" } };
  if (kind === "warehouseSql") {
    const connection = connections.find((item) => item.id === connectionId) ?? connections[0];
    if (!connection) throw new Error("请先配置当前项目的数据库连接，并刷新连接列表");
    return { ...common, kind, title: `${connection.name} 查询`.slice(0, 120), connectionId: connection.id, outputName, sql: sql ?? "SELECT 1 AS value" };
  }
  if (kind === "data") {
    const source = sources.find((item) => item.id === sourceId) ?? sources[0];
    if (!source) throw new Error("请先导入 CSV / Excel 表格，再添加 Data 单元");
    return { ...common, kind, title: source.name.slice(0, 120), sourceDataSourceId: source.id, outputName };
  }
  if (kind === "python") return { ...common, kind, inputCellIds: last ? [last.id] : [], fileNames: [], outputName,
    code: last ? `${outputName} = ${last.outputName}.copy()\nprint(${outputName}.shape)` : `${outputName} = pd.DataFrame({"value": [1, 2, 3]})\nprint(${outputName}.shape)` };
  if (!last) throw new Error("请先添加 Data 单元作为输入");
  if (kind === "sql") return { ...common, kind, inputCellIds: [last.id], outputName, sql: `SELECT *\nFROM ${last.outputName}\nLIMIT 100` };
  if (kind === "transform") {
    const fields = fieldsFor(last).map((field) => field.name);
    return { ...common, kind, inputCellId: last.id, outputName,
      steps: [{ id: `step_${suffix}`, type: "selectFields", fields: fields.length ? fields : ["field"] }] };
  }
  if (kind === "semanticQuery") {
    const model = models[0];
    const source = outputs.find((item) => item.kind === "data" && item.sourceDataSourceId === model?.sourceDatasetId);
    if (!model || !source) throw new Error("请先创建语义模型，并添加其数据源的 Data 单元");
    return { ...common, kind, inputCellId: source.id, modelId: model.id, modelVersion: model.version,
      dimensions: model.dimensions.slice(0, 1).map((item) => item.key), measures: model.measures.slice(0, 1).map((item) => item.key), limit: 100, outputName };
  }
  if (kind === "table" || kind === "chart") {
    const fields = fieldsFor(last);
    if (!fields.length) throw new Error("请先运行上游 SQL / 语义查询，再创建表格或图表");
    if (kind === "table") return { ...common, kind, inputCellId: last.id, columns: fields.slice(0, 30).map((field) => field.name) };
    const value = fields.find((field) => field.type === "number");
    if (!value) throw new Error("上游没有数值字段，请先在 SQL 中生成数值指标");
    return { ...common, kind, inputCellId: last.id, chartType: "bar", categoryField: (fields.find((field) => field.name !== value.name) ?? value).name, valueFields: [value.name] };
  }
  const unsupportedKind: never = kind;
  throw new Error(`不支持的 Notebook 单元类型：${unsupportedKind}`);
}
