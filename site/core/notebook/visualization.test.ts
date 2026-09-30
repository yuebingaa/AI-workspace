import { describe, expect, it } from "vitest";
import { notebookChartConfig, notebookChartDataset, type NotebookChartCell } from "./graphic-walker";
import { notebookVisualization, notebookVisualizationInputIssue } from "./visualization";
import type { DataTable } from "@/core/datasets/table-contracts";

function fixture() {
  const table: DataTable = { fields: [{ name: "q", label: "季度", type: "date" }, { name: "m", label: "金额", type: "number" }, { name: "c", label: "客户", type: "string" }],
    rows: [{ q: "2024-01-01T00:00:00.000Z", m: 1, c: "企业" }], truncated: false };
  const cell: NotebookChartCell = { id: "chart", title: "合成图", kind: "chart", inputCellId: "data", chartType: "area", categoryField: "q", valueFields: ["m"] };
  cell.graphicWalker = { ...notebookChartConfig(cell, notebookChartDataset(cell, table)), mark: "area" };
  cell.graphicWalker.channels.x!.timeUnit = "quarter";
  return { cell, table };
}
describe("Notebook visualization bridge boundaries", () => {
  it.each([
    ["duplicate facet", (cell: NotebookChartCell) => { cell.graphicWalker!.channels.facetY = cell.graphicWalker!.channels.x; }],
    ["week", (cell: NotebookChartCell) => { cell.graphicWalker!.channels.x!.timeUnit = "week"; }],
    ["normalize", (cell: NotebookChartCell) => { cell.graphicWalker!.style.stack = "normalize"; }],
    ["extra tooltip dimension", (cell: NotebookChartCell) => { cell.graphicWalker!.channels.tooltip = [{ field: "c", aggregate: "sum", timeUnit: "none" }]; }],
    ["extra tooltip aggregate", (cell: NotebookChartCell) => { cell.graphicWalker!.channels.tooltip = [{ field: "m", aggregate: "mean", timeUnit: "none" }]; }],
    ["date range", (cell: NotebookChartCell) => { cell.graphicWalker!.filters = [{ field: "q", kind: "dateRange", min: 0, max: null }]; }],
    ["multiple metrics", (cell: NotebookChartCell) => { delete cell.graphicWalker; cell.valueFields.push("other"); }],
    ["pie", (cell: NotebookChartCell) => { delete cell.graphicWalker; cell.chartType = "pie"; }],
  ] as const)("does not silently change %s configuration", (_name, change) => {
    const { cell } = fixture(); change(cell); const before = structuredClone(cell);
    expect(notebookVisualization(cell)).toEqual({ reason: expect.stringContaining("兼容绘图") }); expect(cell).toEqual(before);
  });
  it("preserves shared tooltip dimensions and style without adding groups", () => {
    const { cell, table } = fixture(); cell.graphicWalker!.channels.tooltip = [cell.graphicWalker!.channels.x!, cell.graphicWalker!.channels.y!];
    const { definition } = notebookVisualization(cell);
    expect(definition?.data.dimensions).toHaveLength(1); expect(definition?.presentation.title).toBe(cell.title);
    expect(notebookVisualizationInputIssue(cell, definition!, table)).toBeUndefined();
  });
  it("maps both independent facets and their Tooltip fields without rewriting the saved cell", () => {
    const { cell } = fixture(), item = (field: string) => ({ field, aggregate: "sum" as const, timeUnit: "none" as const });
    cell.graphicWalker!.channels.color = item("c"); cell.graphicWalker!.channels.facetX = item("region"); cell.graphicWalker!.channels.facetY = item("channel");
    cell.graphicWalker!.channels.tooltip = [item("region"), item("channel")]; const before = structuredClone(cell);
    const { definition } = notebookVisualization(cell);
    expect(definition?.data.dimensions).toHaveLength(4); expect(definition?.encoding).toMatchObject({ facetX: "viz_facet_x", facetY: "viz_facet_y" });
    expect(definition?.data.orderBy).toHaveLength(4); expect(cell).toEqual(before);
  });
  it.each([null, 3, true])("keeps unsupported facet values %s on the compatibility path", value => {
    const { cell, table } = fixture(); cell.graphicWalker!.channels.facetX = { field: "c", aggregate: "sum", timeUnit: "none" }; table.rows[0].c = value;
    expect(notebookVisualizationInputIssue(cell, notebookVisualization(cell).definition!, table)).toContain("分面字段");
  });
  it.each(["2024-01-01T12:00:00.000Z", "2024-01-01T00:00:00+08:00", "2024-02-30T00:00:00.000Z", null])( "does not coerce non-DATE input %s", value => {
    const { cell, table } = fixture(); table.rows[0].q = value;
    expect(notebookVisualizationInputIssue(cell, notebookVisualization(cell).definition!, table)).toBeTruthy();
  });
});
