import type { DataTable } from "@/core/datasets/table-contracts";

export type NotebookPreviewSort = { fieldName: string; direction: "ascending" | "descending" } | null;
export const NOTEBOOK_PREVIEW_PAGE_SIZE = 20;

/** Sorting belongs only to the already returned preview, never the execution graph. */
export function nextNotebookPreviewSort(current: NotebookPreviewSort, fieldName: string): NotebookPreviewSort {
  if (current?.fieldName !== fieldName) return { fieldName, direction: "ascending" };
  return current.direction === "ascending" ? { fieldName, direction: "descending" } : null;
}

type Value = DataTable["rows"][number][string] | undefined;
function compareValues(left: Value, right: Value, type: DataTable["fields"][number]["type"]): number {
  if (type === "number") {
    if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
    if (typeof left === "number" || typeof right === "number") return typeof left === "number" ? -1 : 1;
  }
  if (type === "boolean") {
    if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
    if (typeof left === "boolean" || typeof right === "boolean") return typeof left === "boolean" ? -1 : 1;
  }
  // Exact numeric strings and dates remain text: no Number/Date coercion or locale-dependent ordering.
  const a = String(left), b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** All already-returned rows in the selected view order; not a full-result read. */
export function notebookOrderedPreview(table: DataTable, sort: NotebookPreviewSort) {
  const field = sort ? table.fields.find((item) => item.name === sort.fieldName) : undefined;
  const activeSort = field ? sort : null;
  const ordered = activeSort && field ? table.rows.map((row, index) => ({ row, index })).sort((a, b) => {
    const left = a.row[field.name], right = b.row[field.name];
    if (left == null || right == null) return left == null && right == null ? a.index - b.index : left == null ? 1 : -1;
    const comparison = compareValues(left, right, field.type);
    return (activeSort.direction === "ascending" ? comparison : -comparison) || a.index - b.index;
  }).map(({ row }) => row) : table.rows;
  return { sort: activeSort, rows: ordered };
}

export function notebookTablePreview(table: DataTable, sort: NotebookPreviewSort, requestedPage: number) {
  const ordered = notebookOrderedPreview(table, sort);
  const pageCount = Math.max(1, Math.ceil(ordered.rows.length / NOTEBOOK_PREVIEW_PAGE_SIZE));
  const page = Math.min(pageCount - 1, Math.max(0, Number.isFinite(requestedPage) ? Math.floor(requestedPage) : 0));
  return { sort: ordered.sort, page, pageCount, rows: ordered.rows.slice(page * NOTEBOOK_PREVIEW_PAGE_SIZE, (page + 1) * NOTEBOOK_PREVIEW_PAGE_SIZE) };
}
