import type { DataTable } from "@/core/datasets/table-contracts";
import type { ChartDefinitionV2 } from "./definition";
import { visualizationHash } from "./result";
import type { VisualizationExecutionInput } from "./server/execute";

/** Synthetic sales only; never read a user's project or dataset. */
export const sales: DataTable = { fields: [
  { name: "季度", label: "季度", type: "date" }, { name: "客户类型", label: "客户类型", type: "string" },
  { name: "成交金额", label: "成交金额", type: "number" },
], rows: [
  { 季度: "2024-01-15", 客户类型: "企业", 成交金额: 100 }, { 季度: "2024-02-15", 客户类型: "企业", 成交金额: 50 },
  { 季度: "2024-03-15", 客户类型: "个人", 成交金额: 80 }, { 季度: "2024-04-15", 客户类型: "企业", 成交金额: 300 },
  { 季度: "2024-05-15", 客户类型: "个人", 成交金额: 100 }, { 季度: "2024-06-15", 客户类型: "个人", 成交金额: 60 },
], truncated: false };
export function definition(): ChartDefinitionV2 {
  return { schemaVersion: 2, mark: "area", data: { mode: "aggregate", timezone: "UTC",
    dimensions: [{ field: "季度", as: "quarter", timeUnit: "quarter" }, { field: "客户类型", as: "segment", timeUnit: "none" }],
    measures: [{ field: "成交金额", as: "amount", aggregate: "sum" }], filters: [], orderBy: [] },
  encoding: { x: "quarter", y: "amount", color: "segment", tooltip: ["quarter", "segment", "amount"] },
  presentation: { title: "季度成交金额（模拟数据）", palette: "muted", stack: "stack", numberFormat: ",.0f", axes: true, grid: true, legend: true } };
}
export function singleDimension(): ChartDefinitionV2 {
  const def = definition(); def.data.dimensions = [{ field: "客户类型", as: "segment", timeUnit: "none" }];
  def.encoding = { x: "segment", y: "amount", tooltip: ["segment", "amount"] };
  def.mark = "bar"; def.presentation.stack = "none"; return def;
}
export async function inputFor(def: ChartDefinitionV2 = definition(), table: DataTable = sales): Promise<VisualizationExecutionInput> {
  return { definition: def, table, expected: { runId: "synthetic-run", revision: 7, accessMode: "user", inputCellId: "sales" },
    reference: { runId: "synthetic-run", revision: 7, accessMode: "user", cellId: "sales", resultId: "synthetic-run:sales", complete: true,
      rowCount: table.rows.length, dataSignature: await visualizationHash(JSON.stringify(table)) } };
}
