import type { NotebookCell } from "./definition";
import type { NotebookTable } from "./contracts";

/** Validate and project a presentation cell's input; execution owns effects and receipts. */
export function projectPresentationTable(
  cell: Extract<NotebookCell, { kind: "table" | "chart" }>,
  upstream: NotebookTable,
): NotebookTable {
  const names = cell.kind === "table" ? cell.columns : [cell.categoryField, ...cell.valueFields];
  if (names.some((name) => !upstream.fields.some((field) => field.name === name))) {
    throw new Error("上游字段已变化，请重新选择表格或图表字段");
  }
  if (cell.kind === "chart" && cell.valueFields.some((name) => upstream.fields.find((field) => field.name === name)?.type !== "number")) {
    throw new Error("图表数值列必须为数字；高精度字符串请在 SQL 中显式转换后使用");
  }
  if (cell.kind === "chart" && (cell.chartType === "pie" || cell.chartType === "donut")
    && cell.valueFields.some((name) => upstream.rows.some((row) => typeof row[name] === "number" && row[name] < 0))) {
    throw new Error("饼图或环形图不能表示负数，请选择柱状图或折线图");
  }
  // Preserve existing semantics: field metadata follows the input order, while
  // row properties follow the requested order. Do not cast values or trim rows.
  return {
    fields: upstream.fields.filter((field) => names.includes(field.name)),
    rows: upstream.rows.map((row) => Object.fromEntries(names.map((name) => [name, row[name]]))),
    truncated: upstream.truncated,
  };
}
