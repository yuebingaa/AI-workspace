import { describe, it, expect } from "vitest";
import { authorNotebookChart, notebookChartAuthoringSchema } from "./chart-authoring";
import { notebookVisualization } from "./visualization";

const input = () => notebookChartAuthoringSchema.parse({ id: "sales_chart", inputCellId: "sales", title: "季度销售（模拟）", mark: "area",
  channels: { x: { field: "quarter", timeUnit: "quarter" }, y: { field: "amount", aggregate: "sum" }, color: { field: "segment" } } });
describe("shared chart authoring", () => {
  it("derives all duplicate host fields and defaults; enters full calculation", () => {
    const cell = authorNotebookChart(input());
    expect(cell).toMatchObject({ kind: "chart", categoryField: "quarter", valueFields: ["amount"],
      graphicWalker: { datasetId: "notebook:sales_chart:sales", mark: "area", channels: { x: { timeUnit: "quarter" }, color: { field: "segment" } } } });
    if (cell.kind !== "chart") throw Error("expected chart");
    expect(notebookVisualization(cell).definition?.encoding.color).toBe("viz_color");
  });
  it("preserves omitted styles and filters on same input, but replaces channels explicitly", () => {
    const initial = authorNotebookChart({ ...input(), style: { palette: "warm" }, filters: [{ kind: "oneOf", field: "segment", values: ["企业"] }] });
    const next = authorNotebookChart({ ...input(), mark: "line", channels: { ...input().channels, color: null } }, initial);
    expect(next).toMatchObject({ graphicWalker: { style: { palette: "warm" }, filters: [{ field: "segment" }], channels: { color: null } } });
    const moved = authorNotebookChart({ ...input(), inputCellId: "other" }, initial);
    expect(moved).toMatchObject({ graphicWalker: { filters: [], datasetId: "notebook:sales_chart:other" } });
  });
  it("never replaces other kinds or accepts forged generated IDs/settings", () => {
    expect(() => authorNotebookChart(input(), { kind: "text", id: "sales_chart", title: "保留", markdown: "保留" })).toThrow(/其他类型/);
    expect(() => notebookChartAuthoringSchema.parse({ ...input(), datasetId: "stolen" })).toThrow();
    expect(() => notebookChartAuthoringSchema.parse({ ...input(), channels: { ...input().channels, y: null } })).toThrow();
  });
});
