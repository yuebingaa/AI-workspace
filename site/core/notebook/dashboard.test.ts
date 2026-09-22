import { describe, expect, it } from "vitest";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { notebookDashboardPreview } from "./dashboard";
import type { NotebookCell } from "./definition";

const cell: NotebookCell = { id: "sql", title: "Complete table", kind: "sql", inputCellIds: ["source"], outputName: "result", sql: "SELECT * FROM input" };
const page = semanticFixture().product.appSpec.pages[0];
const upload = (csv: string) => parseCsvUpload({ stream: new Response(csv).body!, originalFileName: "synthetic-result.csv", mimeType: "text/csv" });

describe("Notebook dashboard preview preserves selected outputs", () => {
  it("keeps every field in an accepted 30-column table", async () => {
    const fields = Array.from({ length: 30 }, (_, index) => `field_${index}`);
    const snapshot = await upload(`${fields.join(",")}\n${fields.map((_, index) => index).join(",")}`);
    const before = structuredClone(snapshot);
    const changeSet = notebookDashboardPreview(page, cell, snapshot, "test");
    const operation = changeSet.operations[0];
    if (operation.type !== "addNode" || operation.node.type !== "DataTable") throw new Error("Expected a table preview");
    expect(operation.node.props.binding.columns?.map((field) => field.field)).toEqual(fields);
    expect(snapshot).toEqual(before);
  });
  it("rejects the 31st column rather than generating a silently incomplete binding", async () => {
    const fields = Array.from({ length: 31 }, (_, index) => `field_${index}`);
    const snapshot = await upload(`${fields.join(",")}\n${fields.map((_, index) => index).join(",")}`);
    expect(() => notebookDashboardPreview(page, cell, snapshot, "test")).toThrow("最多 30 列");
  });
  it("retains the existing preview row-limit error", async () => {
    const snapshot = await upload("value\n1");
    snapshot.dataset.source.rowCount = 501;
    expect(() => notebookDashboardPreview(page, cell, snapshot, "test")).toThrow("看板最多展示 500 行；请先在 SQL 中筛选或聚合，不能静默丢弃结果");
  });
  it("checks normalized category and measure fields while preserving each selected series", async () => {
    const snapshot = await upload("Region Name,Total Amount,Unit Count\nEast,150,2\nSouth,80,1");
    const chart: NotebookCell = { id: "chart", title: "Results", kind: "chart", inputCellId: "sql", chartType: "bar", categoryField: "Region Name", valueFields: ["Total Amount", "Unit Count"] };
    const changeSet = notebookDashboardPreview(page, chart, snapshot, "test");
    expect(changeSet.operations).toHaveLength(2);
    for (const [index, operation] of changeSet.operations.entries()) {
      if (operation.type !== "addNode" || operation.node.type !== "BarChart") throw new Error("Expected chart previews");
      expect(operation.node.props.binding).toMatchObject({ aggregation: "none", groupBy: snapshot.dataset.source.fields[0].name, field: snapshot.dataset.source.fields[index + 1].name });
      expect(operation.node.props.binding.columns).toBeUndefined();
    }
    const amount = snapshot.dataset.source.fields[1].name;
    snapshot.rows[0][amount] = null;
    expect(() => notebookDashboardPreview(page, chart, snapshot, "invalid")).toThrow("当前看板图表不支持空数值，请先在 SQL 中明确处理 NULL");
  });
  it("retains the existing preview duplicate-category error", async () => {
    const snapshot = await upload("region,amount\nEast,150\nEast,80");
    const chart: NotebookCell = { id: "chart", title: "Results", kind: "chart", inputCellId: "sql", chartType: "bar", categoryField: "region", valueFields: ["amount"] };
    expect(() => notebookDashboardPreview(page, chart, snapshot, "test")).toThrow("看板图表需要唯一分类，请先在 SQL 中聚合；不会自动合并重复分类");
  });
});
