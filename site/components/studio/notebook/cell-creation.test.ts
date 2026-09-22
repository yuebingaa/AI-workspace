import { describe, expect, it } from "vitest";
import type { DataSourceDefinition } from "@/core/models";
import type { NotebookTable } from "@/core/notebook/contracts";
import { notebookCellSchema, type NotebookCell } from "@/core/notebook/definition";
import type { SemanticModel } from "@/core/semantic/contracts";
import type { ConnectionDescriptor } from "@/core/connections/contracts";
import { createNotebookCell, type NotebookCellCreationContext } from "./cell-creation";

const source: DataSourceDefinition = { id: "sales", name: "销售数据", rowCount: 2, columnCount: 2, qualityScore: 100,
  updatedAt: "2026-09-16T00:00:00.000Z", sourceType: "csv", fields: [
    { name: "region", label: "地区", type: "string", aggregatable: false, supportedAggregations: ["none"] },
    { name: "amount", label: "收入", type: "number", aggregatable: true, supportedAggregations: ["none", "sum"] },
  ] };
const input: NotebookCell = { id: "data", kind: "data", title: "源数据", sourceDataSourceId: "sales", outputName: "sales_input" };
const model: SemanticModel = { id: "sales_model", version: 3, name: "销售口径", description: "合成模型", sourceDatasetId: "sales",
  dimensions: [{ key: "region_key", label: "地区", field: "region", description: "" }],
  measures: [{ key: "revenue", label: "收入", field: "amount", aggregation: "sum", description: "" }] };
const connection: ConnectionDescriptor = { id: "test_connection", name: "合成连接", kind: "postgresql", allowAi: false };
const context = (overrides: Partial<NotebookCellCreationContext> = {}): NotebookCellCreationContext => ({
  id: "cell_abc1234567", suffix: "abc1234567", cells: [input], sources: [source], models: [model],
  connections: [connection], fieldsFor: () => source.fields, ...overrides,
});
const expected: Record<NotebookCell["kind"], NotebookCell> = {
  data: { id: "cell_abc1234567", title: "销售数据", kind: "data", sourceDataSourceId: "sales", outputName: "data_2_abc" },
  sql: { id: "cell_abc1234567", title: "SQL 数据分析", kind: "sql", inputCellIds: ["data"], outputName: "sql_2_abc", sql: "SELECT *\nFROM sales_input\nLIMIT 100" },
  warehouseSql: { id: "cell_abc1234567", title: "合成连接 查询", kind: "warehouseSql", connectionId: "test_connection", outputName: "warehouseSql_2_abc", sql: "SELECT 1 AS value" },
  python: { id: "cell_abc1234567", title: "Python单元", kind: "python", inputCellIds: ["data"], fileNames: [], outputName: "python_2_abc", code: "python_2_abc = sales_input.copy()\nprint(python_2_abc.shape)" },
  transform: { id: "cell_abc1234567", title: "DataRecipe单元", kind: "transform", inputCellId: "data", outputName: "transform_2_abc", steps: [{ id: "step_abc1234567", type: "selectFields", fields: ["region", "amount"] }] },
  semanticQuery: { id: "cell_abc1234567", title: "语义查询单元", kind: "semanticQuery", inputCellId: "data", modelId: "sales_model", modelVersion: 3, dimensions: ["region_key"], measures: ["revenue"], limit: 100, outputName: "semanticQuery_2_abc" },
  table: { id: "cell_abc1234567", title: "表格单元", kind: "table", inputCellId: "data", columns: ["region", "amount"] },
  chart: { id: "cell_abc1234567", title: "图表单元", kind: "chart", inputCellId: "data", chartType: "bar", categoryField: "region", valueFields: ["amount"] },
  text: { id: "cell_abc1234567", title: "说明单元", kind: "text", markdown: "在这里记录分析问题、结论和口径说明。" },
  parameter: { id: "cell_abc1234567", title: "参数单元", kind: "parameter", outputName: "parameter_2_abc", parameter: { type: "text", value: "" } },
};

describe("manual Notebook cell creation defaults", () => {
  it("creates a parameter in an empty notebook without datasets, models or connections", () => {
    const cell = createNotebookCell("parameter", context({ cells: [], sources: [], models: [], connections: [] }));
    expect(cell).toEqual({ ...expected.parameter, outputName: "parameter_1_abc" });
    expect(notebookCellSchema.parse(cell)).toEqual(cell);
    expect(createNotebookCell("sql", context({ cells: [cell] }))).toMatchObject({ inputCellIds: [cell.id], sql: "SELECT *\nFROM parameter_1_abc\nLIMIT 100" });
  });
  it.each(notebookCellSchema.options.map((schema) => schema.shape.kind.value))("preserves the complete %s definition", (kind) => {
    const cell = createNotebookCell(kind, context());
    expect(cell).toEqual(expected[kind]);
    expect(notebookCellSchema.parse(cell)).toEqual(cell);
  });
  it("keeps the caller-provided identity and output ordinal including non-output cells", () => {
    const cell = createNotebookCell("sql", context({ id: "manual_id", suffix: "xyz9876543", cells: [input, expected.text, expected.table] }));
    expect(cell).toMatchObject({ id: "manual_id", inputCellIds: ["data"], outputName: "sql_4_xyz" });
  });
  it.each([undefined, "missing"])("falls back to the first source/connection for selection %s", (selected) => {
    expect(createNotebookCell("data", context({ sourceId: selected }))).toEqual(expected.data);
    expect(createNotebookCell("warehouseSql", context({ connectionId: selected }))).toEqual(expected.warehouseSql);
  });
  it("uses explicitly selected data and connection, retaining caller SQL unchanged", () => {
    const selectedSource = { ...source, id: "other_source", name: "第二来源" };
    const selectedConnection = { ...connection, id: "other_connection", name: "第二连接" };
    expect(createNotebookCell("data", context({ sources: [source, selectedSource], sourceId: selectedSource.id })))
      .toMatchObject({ sourceDataSourceId: "other_source", title: "第二来源" });
    expect(createNotebookCell("warehouseSql", context({ connections: [connection, selectedConnection], connectionId: selectedConnection.id, sql: " SELECT 2 AS exact_value\n" })))
      .toMatchObject({ connectionId: "other_connection", title: "第二连接 查询", sql: " SELECT 2 AS exact_value\n" });
  });
  it("truncates source/connection-derived titles at the existing 120-character boundary", () => {
    const name = "长".repeat(125);
    expect(createNotebookCell("data", context({ sources: [{ ...source, name }] }))).toMatchObject({ title: name.slice(0, 120) });
    expect(createNotebookCell("warehouseSql", context({ connections: [{ ...connection, name }] }))).toMatchObject({ title: name.slice(0, 120) });
  });
  it("can create Python without an upstream output and otherwise chooses the last named output", () => {
    expect(createNotebookCell("python", context({ cells: [] }))).toMatchObject({ inputCellIds: [], outputName: "python_1_abc",
      code: 'python_1_abc = pd.DataFrame({"value": [1, 2, 3]})\nprint(python_1_abc.shape)' });
    const later: NotebookCell = { ...input, id: "later_data", outputName: "later_input" };
    expect(createNotebookCell("python", context({ cells: [input, later, expected.text, expected.table] })))
      .toMatchObject({ inputCellIds: ["later_data"], code: "python_5_abc = later_input.copy()\nprint(python_5_abc.shape)" });
  });
  it("retains the first model and its matching Data input rather than the last output", () => {
    const later: NotebookCell = { ...input, id: "later_data", sourceDataSourceId: "other_source", outputName: "later_input" };
    expect(createNotebookCell("semanticQuery", context({ cells: [input, later], models: [model, { ...model, id: "other_model", sourceDatasetId: "other_source" }] })))
      .toMatchObject({ inputCellId: "data", modelId: "sales_model", modelVersion: 3, dimensions: ["region_key"], measures: ["revenue"] });
    expect(createNotebookCell("semanticQuery", context({ models: [{ ...model, dimensions: [] }] }))).toMatchObject({ dimensions: [] });
  });
  it("retains the unrun transform placeholder and first 30 table fields", () => {
    expect(createNotebookCell("transform", context({ fieldsFor: () => [] })))
      .toMatchObject({ steps: [{ id: "step_abc1234567", type: "selectFields", fields: ["field"] }] });
    const fields: NotebookTable["fields"] = Array.from({ length: 35 }, (_, i) => ({ name: `f${i}`, label: `F${i}`, type: "string" }));
    expect(createNotebookCell("table", context({ fieldsFor: () => fields }))).toMatchObject({ columns: fields.slice(0, 30).map((field) => field.name) });
  });
  it("uses the first numeric value and another category, or the same field when it is the only one", () => {
    const fields: NotebookTable["fields"] = [{ name: "first", label: "首值", type: "number" }, { name: "second", label: "次值", type: "number" }];
    expect(createNotebookCell("chart", context({ fieldsFor: () => fields }))).toMatchObject({ categoryField: "second", valueFields: ["first"] });
    expect(createNotebookCell("chart", context({ fieldsFor: () => fields.slice(0, 1) }))).toMatchObject({ categoryField: "first", valueFields: ["first"] });
  });
  it.each(["sql", "transform", "semanticQuery", "table", "chart"] as const)("keeps missing-input errors ahead of %s-specific validation", (kind) => {
    expect(() => createNotebookCell(kind, context({ cells: [], models: [] }))).toThrow("请先添加 Data 单元作为输入");
  });
  it("preserves each data/connection/model/field prerequisite error", () => {
    expect(() => createNotebookCell("data", context({ sources: [] }))).toThrow("请先导入 CSV / Excel 表格，再添加 Data 单元");
    expect(() => createNotebookCell("warehouseSql", context({ connections: [] }))).toThrow("请先配置当前项目的数据库连接，并刷新连接列表");
    expect(() => createNotebookCell("semanticQuery", context({ models: [] }))).toThrow("请先创建语义模型，并添加其数据源的 Data 单元");
    expect(() => createNotebookCell("semanticQuery", context({ models: [{ ...model, sourceDatasetId: "not_loaded" }] }))).toThrow("请先创建语义模型，并添加其数据源的 Data 单元");
    for (const kind of ["table", "chart"] as const) expect(() => createNotebookCell(kind, context({ fieldsFor: () => [] })))
      .toThrow("请先运行上游 SQL / 语义查询，再创建表格或图表");
    expect(() => createNotebookCell("chart", context({ fieldsFor: () => source.fields.slice(0, 1) })))
      .toThrow("上游没有数值字段，请先在 SQL 中生成数值指标");
  });
  it("does not mutate caller-owned definitions, models, connections or field snapshots", () => {
    const initial = context();
    const before = structuredClone({ ...initial, fieldsFor: undefined });
    for (const kind of notebookCellSchema.options.map((schema) => schema.shape.kind.value)) createNotebookCell(kind, initial);
    expect({ ...initial, fieldsFor: undefined }).toEqual(before);
    expect(initial.fieldsFor(input)).toEqual(source.fields);
  });
});
