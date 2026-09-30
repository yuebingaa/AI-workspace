import { describe, expect, it, vi } from "vitest";
import { notebookCellSchema } from "./definition";
import { notebookDocumentSchema, type NotebookTable } from "./contracts";
import { notebookChartConfig, notebookChartDataset, notebookChartFields, supportsNotebookGraphicWalker, validateNotebookChartConfig, type NotebookChartCell } from "./graphic-walker";
import { projectPresentationTable } from "./presentation-table";
import { notebookDashboardSnapshotIssue } from "./dashboard-policy";
import { executeNotebook } from "./server/execution";

const legacy: NotebookChartCell = { id: "chart", kind: "chart", title: "季度成交金额", inputCellId: "sql", chartType: "area", categoryField: "quarter", valueFields: ["amount"] };
const table: NotebookTable = { fields: [
  { name: "quarter", label: "季度", type: "date" }, { name: "amount", label: "成交金额", type: "number" },
  { name: "segment", label: "客户类型", type: "string" }, { name: "region", label: "地区", type: "string" },
  { name: "active", label: "有效", type: "boolean" }, { name: "extra", label: "不使用", type: "string" },
], rows: [{ quarter: "2024-01-01", amount: 100, segment: "企业客户", region: "北区", active: true, extra: "未使用" },
  { quarter: "2024-01-01", amount: 50, segment: "企业客户", region: "北区", active: false, extra: "未使用" }], truncated: false };
const dataset = notebookChartDataset(legacy, table);
function fixture(): NotebookChartCell {
  const config = notebookChartConfig(legacy, dataset);
  config.channels.color = { field: "segment", aggregate: "sum", timeUnit: "none" };
  config.channels.facetX = { field: "region", aggregate: "sum", timeUnit: "none" };
  config.channels.tooltip = [{ field: "segment", aggregate: "sum", timeUnit: "none" }];
  config.filters = [{ field: "active", kind: "oneOf", values: [true] }];
  config.style.stack = "stack";
  return { ...legacy, graphicWalker: { ...config, mark: "area" } };
}

describe("Notebook-owned Graphic Walker chart", () => {
  it("keeps old definitions unchanged and preserves unsupported charts", () => {
    expect(notebookCellSchema.parse(legacy)).toEqual(legacy);
    expect(supportsNotebookGraphicWalker(legacy)).toBe(true);
    expect(supportsNotebookGraphicWalker({ ...legacy, chartType: "pie" })).toBe(false);
    expect(supportsNotebookGraphicWalker({ ...legacy, chartType: "donut" })).toBe(false);
    expect(supportsNotebookGraphicWalker({ ...legacy, valueFields: ["amount", "cost"] })).toBe(false);
    const config = notebookChartConfig(legacy, dataset);
    expect(config.channels.color).toBeNull();
    expect(config.style.stack).toBe("none");
    expect(legacy.graphicWalker).toBeUndefined();
  });
  it("round-trips configuration in Notebook JSON, retaining filters/style/channels without rows", () => {
    const document = { name: "合成图", revision: 3, cells: [fixture()] };
    expect(notebookDocumentSchema.parse(JSON.parse(JSON.stringify(document)))).toEqual(document);
    expect(JSON.stringify(document)).not.toContain("未使用");
  });
  it.each(["dataset", "type", "x", "y", "title"])("rejects conflicting %s instead of having two chart truths", kind => {
    const cell = fixture();
    if (kind === "dataset") cell.graphicWalker!.datasetId = "other";
    if (kind === "type") cell.chartType = "line";
    if (kind === "x") cell.categoryField = "region";
    if (kind === "y") cell.valueFields = ["amount", "cost"];
    if (kind === "title") cell.graphicWalker!.title = "不一致";
    expect(notebookCellSchema.safeParse(cell).success).toBe(false);
  });
  it("projects all referenced input fields, without reaggregating or discarding rows", () => {
    const cell = fixture(), before = structuredClone(table), output = projectPresentationTable(cell, table);
    expect(notebookChartFields(cell.graphicWalker!)).toEqual(["quarter", "amount", "segment", "region", "active"]);
    expect(output.fields.map(field => field.name)).toEqual(["quarter", "amount", "segment", "region", "active"]);
    expect(output.rows).toHaveLength(2);
    expect(output.rows.map(row => row.amount)).toEqual([100, 50]);
    expect(output.rows[0]).not.toHaveProperty("extra");
    expect(table).toEqual(before);
    expect(notebookChartDataset(cell, { ...output, truncated: true }).truncated).toBe(true);
  });
  it("validates missing axes, types, filters and unsupported imported marks", () => {
    const config = fixture().graphicWalker!;
    expect(() => validateNotebookChartConfig({ ...config, channels: { ...config.channels, y: null } }, dataset)).toThrow("Y 轴");
    expect(() => validateNotebookChartConfig({ ...config, mark: "point" }, dataset)).toThrow("散点图");
    expect(() => validateNotebookChartConfig({ ...config, title: " " }, dataset)).toThrow("标题");
    expect(() => projectPresentationTable(fixture(), { ...table, fields: table.fields.filter(field => field.name !== "active") })).toThrow("筛选字段");
    expect(() => projectPresentationTable(fixture(), { ...table, fields: table.fields.map(field => field.name === "amount" ? { ...field, type: "string" } : field) })).toThrow("类型不兼容");
  });
  it("blocks old dashboard conversion rather than silently losing grouping/style", () => {
    expect(notebookDashboardSnapshotIssue(fixture(), table)).toBe("graphicWalker");
  });
  it("runs through existing execution ports, preserving source receipt scope", async () => {
    const run = await executeNotebook({ document: { name: "合成验收", revision: 1, cells: [
      { id: "sql", kind: "warehouseSql", title: "查询", connectionId: "test", sql: "SELECT 1", outputName: "source" }, fixture(),
    ] }, sources: [], connectionQuery: vi.fn().mockResolvedValue(table) }, { query: vi.fn(), log: vi.fn() });
    expect(run.status).toBe("success");
    expect(run.cells.find(cell => cell.cellId === "chart")?.table?.rows).toHaveLength(2);
    expect(run.cells.find(cell => cell.cellId === "chart")?.resultRef).toMatchObject({ rowCount: 2, complete: true });
  });
  it("does not bypass missing connection capability with chart configuration", async () => {
    const run = await executeNotebook({ document: { name: "合成验收", revision: 1, cells: [
      { id: "sql", kind: "warehouseSql", title: "查询", connectionId: "test", sql: "SELECT 1", outputName: "source" }, fixture(),
    ] }, sources: [] }, { query: vi.fn(), log: vi.fn() });
    expect(run.cells.find(cell => cell.cellId === "chart")?.status).toBe("blocked");
  });
});
