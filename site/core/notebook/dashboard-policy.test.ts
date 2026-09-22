import { describe, expect, it } from "vitest";
import type { DataTable } from "@/core/datasets/table-contracts";
import type { NotebookCell } from "./definition";
import { notebookDashboardSizeIssue, notebookDashboardSnapshotIssue } from "./dashboard-policy";

const chart: NotebookCell = { id: "chart", title: "Chart", kind: "chart", inputCellId: "source", chartType: "bar", categoryField: "region", valueFields: ["amount", "count"] };
const sql: NotebookCell = { id: "sql", title: "SQL", kind: "sql", inputCellIds: ["source"], outputName: "result", sql: "SELECT * FROM input" };
const table = (rows: DataTable["rows"]): DataTable => ({ fields: [
  { name: "region", label: "Region", type: "string" },
  { name: "amount", label: "Amount", type: "number" },
  { name: "count", label: "Count", type: "number" },
], rows, truncated: false });

describe("Notebook dashboard snapshot representability", () => {
  it.each(["sql", "transform", "python", "warehouseSql", "table", "parameter", "semanticQuery"] as const)("rejects a wide %s table instead of clipping its columns", (kind) => {
    expect(notebookDashboardSizeIssue(kind, 1, 30)).toBeNull();
    expect(notebookDashboardSizeIssue(kind, 1, 31)).toBe("columnLimit");
    expect(notebookDashboardSizeIssue(kind, 1, 100)).toBe("columnLimit");
  });
  it("preserves the 500-row limit and does not apply table-column limits to charts", () => {
    expect(notebookDashboardSizeIssue("chart", 500, 100)).toBeNull();
    expect(notebookDashboardSizeIssue("chart", 501, 3)).toBe("rowLimit");
    expect(notebookDashboardSizeIssue("table", 500, 30)).toBeNull();
    expect(notebookDashboardSizeIssue("table", 501, 31)).toBe("rowLimit");
  });
  it("keeps stringified-category collision semantics and never merges categories", () => {
    expect(notebookDashboardSnapshotIssue(chart, table([{ region: 1, amount: 2, count: 3 }, { region: "1", amount: 4, count: 5 }]))).toBe("duplicateCategories");
  });
  it.each([null, "12", Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("refuses unsupported chart measure %s without coercion", (value) => {
    expect(notebookDashboardSnapshotIssue(chart, table([{ region: "East", amount: 12, count: value }]))).toBe("nonFiniteValues");
  });
  it("preserves finite multi-series values including zero and negative numbers without mutation", () => {
    const input = table([{ region: "East", amount: 0, count: -1 }]);
    const before = structuredClone(input);
    expect(notebookDashboardSnapshotIssue(chart, input)).toBeNull();
    expect(input).toEqual(before);
  });
  it("does not apply chart value restrictions to a table snapshot", () => {
    expect(notebookDashboardSnapshotIssue(sql, table([{ region: "East", amount: null, count: "001" }]))).toBeNull();
  });
});
