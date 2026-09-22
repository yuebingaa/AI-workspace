import type { DataTable } from "@/core/datasets/table-contracts";
import type { NotebookCell } from "./definition";

export const NOTEBOOK_DASHBOARD_LIMITS = { rows: 500, tableColumns: 30 } as const;

export const NOTEBOOK_DASHBOARD_MESSAGES = {
  rowLimit: "看板快照最多 500 行，请先筛选或聚合数据",
  columnLimit: "看板表格最多 30 列，请先在表格步骤选择字段或在 SQL 中筛选列；不会静默丢弃字段，仍可保存完整数据集",
  duplicateCategories: "看板图表需要唯一分类，请先聚合，不会自动合并重复分类",
  nonFiniteValues: "当前看板图表不支持空数值，请先在 SQL 中明确处理 NULL",
} as const;
export type NotebookDashboardIssue = keyof typeof NOTEBOOK_DASHBOARD_MESSAGES;

/** Size affordances are shared with the UI; they do not replace save-time validation. */
export function notebookDashboardSizeIssue(kind: NotebookCell["kind"], rowCount: number, columnCount: number): NotebookDashboardIssue | null {
  if (rowCount > NOTEBOOK_DASHBOARD_LIMITS.rows) return "rowLimit";
  if (kind !== "chart" && columnCount > NOTEBOOK_DASHBOARD_LIMITS.tableColumns) return "columnLimit";
  return null;
}

/** Snapshot representability only: authorization, completeness and emptiness stay with the caller. */
export function notebookDashboardSnapshotIssue(cell: NotebookCell, table: Pick<DataTable, "fields" | "rows">): NotebookDashboardIssue | null {
  const sizeIssue = notebookDashboardSizeIssue(cell.kind, table.rows.length, table.fields.length);
  if (sizeIssue) return sizeIssue;
  if (cell.kind !== "chart") return null;
  const categories = table.rows.map((row) => String(row[cell.categoryField]));
  if (new Set(categories).size !== categories.length) return "duplicateCategories";
  if (table.rows.some((row) => cell.valueFields.some((field) => typeof row[field] !== "number" || !Number.isFinite(row[field])))) return "nonFiniteValues";
  return null;
}
