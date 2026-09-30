import { describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { notebookChartConfig, notebookChartDataset, type NotebookChartCell } from "../graphic-walker";
import { notebookDocumentSchema, type NotebookTable } from "../contracts";
import { notebookVisualization } from "../visualization";
import { captureNotebookRunExpectation, parseNotebookRunReceipt } from "../run-receipt";
import { notebookProgressResult } from "../live-progress";
import { parseMaterializedVisualization } from "@/core/visualization/result";
import { executeNotebook } from "./execution";
import { executeNotebookSql } from "./query-engine";

function fixture(size = 1250) {
  const { source } = semanticFixture();
  const rows: NotebookTable["rows"] = Array.from({ length: size }, (_, i) => ({ region: i % 2 ? "企业" : "个人", amount: 2 }));
  const table: NotebookTable = { fields: source.fields.map(({ name, label, type }) => ({ name, label, type })), rows, truncated: false };
  const cell: NotebookChartCell = { id: "chart", kind: "chart", title: "完整销售图（模拟）", inputCellId: "data", chartType: "bar", categoryField: "region", valueFields: ["amount"] };
  cell.graphicWalker = { ...notebookChartConfig(cell, notebookChartDataset(cell, table)), mark: "bar" };
  return { document: notebookDocumentSchema.parse({ name: "正式运行桥接测试", revision: 3, cells: [
    { id: "data", kind: "data", title: "模拟输入", outputName: "sales", sourceDataSourceId: source.id }, cell,
    { id: "show", kind: "table", title: "同源表格仍取输入", inputCellId: "data", columns: ["region", "amount"] },
  ] }), sources: [{ source, rows }], cell, table };
}
const ports = () => ({ query: executeNotebookSql, visualize: executeNotebookSql, log: vi.fn() });

describe("Notebook product bridge uses full authorized input and preserves persisted definitions", () => {
  it("uses all 1250 rows, returns 2 groups, retains input/Dataset semantics and validates receipt", async () => {
    const input = fixture(), before = structuredClone(input.document);
    const run = await executeNotebook(input, ports());
    expect(run.status).toBe("success");
    expect(run.cells[0].table?.rows).toHaveLength(100);
    expect(run.cells[1].table?.rows).toHaveLength(1000);
    expect(run.cells[2].resultRef).toMatchObject({ rowCount: 1250, complete: true });
    expect(run.cells[1].visualization?.table.rows).toEqual([{ viz_x: "个人", viz_y: 1250 }, { viz_x: "企业", viz_y: 1250 }]);
    expect(run.cells[1].visualization?.visualResult).toMatchObject({ inputRowCount: 1250, outputRowCount: 2, accessMode: "user" });
    const publishResult = vi.fn(); await executeNotebook({ ...input, targetCellId: "chart" }, { ...ports(), publishResult });
    expect(publishResult).toHaveBeenCalledWith(expect.objectContaining({ table: expect.objectContaining({ rows: input.sources[0].rows }) }));
    expect(parseNotebookRunReceipt(run, captureNotebookRunExpectation(input.document, "user"))).toEqual(run);
    const visual = run.cells[1].visualization!;
    await expect(parseMaterializedVisualization(visual, notebookVisualization(input.cell).definition!, {
      runId: run.runId, revision: 3, accessMode: "user", inputResultId: run.cells[0].resultRef!.resultId, inputRowCount: 1250,
    })).resolves.toEqual(visual);
    expect(input.document).toEqual(before); expect(notebookDocumentSchema.parse(JSON.parse(JSON.stringify(input.document)))).toEqual(before);
    expect(notebookProgressResult(run.cells[1]).visualization).toBeUndefined();
    expect(notebookProgressResult(run.cells[1]).table?.rows).toHaveLength(50);
    for (const mutate of [
      (r: typeof run) => { r.cells[1].visualization!.visualResult.revision++; },
      (r: typeof run) => { r.cells[1].visualization!.visualResult.dataDefinitionKey = "other"; },
      (r: typeof run) => { r.cells[1].visualization!.visualResult.inputRowCount = 100; },
      (r: typeof run) => { r.cells[1].visualization!.visualResult.accessMode = "ai"; },
      (r: typeof run) => { r.cells[1].visualization!.visualResult.inputResultIds = ["old:data"]; },
    ]) { const invalid = structuredClone(run); mutate(invalid); expect(() => parseNotebookRunReceipt(invalid, captureNotebookRunExpectation(input.document, "user"))).toThrow(/回执/); }
  });
  it("renders old single-measure charts as raw rows without SUM or rewriting configuration", async () => {
    const input = fixture(3), cell = input.document.cells[1] as NotebookChartCell;
    input.sources[0].rows.forEach((row, i) => { row.region = ["Z", "A", "M"][i]; });
    delete cell.graphicWalker; const before = JSON.stringify(input.document);
    const run = await executeNotebook(input, ports());
    expect(run.cells[1].visualization?.table.rows).toEqual([{ viz_x: "Z", viz_y: 2 }, { viz_x: "A", viz_y: 2 }, { viz_x: "M", viz_y: 2 }]);
    expect(run.cells[1].visualization?.visualResult.mode).toBe("rows"); expect(JSON.stringify(input.document)).toBe(before);
  });
  it("keeps duplicate-category legacy rows on their original renderer to avoid overlapping marks", async () => {
    const input = fixture(3), cell = input.document.cells[1] as NotebookChartCell; delete cell.graphicWalker;
    const visualize = vi.fn(), run = await executeNotebook(input, { ...ports(), visualize });
    expect(run.status).toBe("success"); expect(run.cells[1].visualization).toBeUndefined();
    expect(run.cells[1].visualizationNotice).toContain("重复分类"); expect(visualize).not.toHaveBeenCalled();
    expect(run.cells[1].table?.rows).toEqual(input.sources[0].rows);
  });
  it("uses the same bridge for AI, after sensitive-field masking", async () => {
    const input = fixture(3); input.sources[0].source.aiAccessPolicy = "masked";
    input.sources[0].source.fields[0].sensitiveCategories = ["email"];
    const run = await executeNotebook({ ...input, forAi: true }, ports());
    expect(run.status).toBe("success"); expect(JSON.stringify(run)).not.toContain("企业");
    expect(run.cells[1].visualization?.visualResult.accessMode).toBe("ai");
    expect(parseNotebookRunReceipt(run, captureNotebookRunExpectation(input.document, "ai"))).toEqual(run);
    expect(run.cells[1].visualization?.table.rows.map(row => row.viz_x)).toEqual(["匿名_1", "匿名_2"]);
  });
  it("computes both facets over the full source and verifies all four dimensions in the receipt", async () => {
    const input = fixture(1250), cell = input.document.cells[1] as NotebookChartCell;
    input.sources[0].source.fields.push({ name: "channel", label: "渠道", type: "string", aggregatable: false, supportedAggregations: [] },
      { name: "quarter", label: "季度", type: "date", aggregatable: false, supportedAggregations: [] });
    input.sources[0].rows.forEach((row, i) => Object.assign(row, { channel: i % 3 ? "直销" : "伙伴", quarter: i % 4 ? "2024-04-01" : "2024-01-01" }));
    cell.graphicWalker!.channels.facetX = { field: "channel", aggregate: "sum", timeUnit: "none" };
    cell.graphicWalker!.channels.facetY = { field: "quarter", aggregate: "sum", timeUnit: "quarter" };
    const run = await executeNotebook(input, ports()), result = run.cells[1].visualization!;
    expect(run.status).toBe("success"); expect(result.visualResult.inputRowCount).toBe(1250);
    for (const row of result.table.rows) {
      const matched = input.sources[0].rows.filter(source => source.region === row.viz_x && source.channel === row.viz_facet_x && source.quarter === row.viz_facet_y);
      expect(row.viz_y).toBe(matched.length * 2);
    }
    expect(result.table.rows.reduce((sum, row) => sum + Number(row.viz_y), 0)).toBe(2500);
    expect(parseNotebookRunReceipt(run, captureNotebookRunExpectation(input.document, "user"))).toEqual(run);
    const changed = structuredClone(input.document); (changed.cells[1] as NotebookChartCell).graphicWalker!.channels.facetY = null;
    expect(() => parseNotebookRunReceipt(run, captureNotebookRunExpectation(changed, "user"))).toThrow(/回执/);
  });
  it("keeps NULL aggregation semantics and duplicate facets explicitly on the compatibility path", async () => {
    const input = fixture(3), cell = input.document.cells[1] as NotebookChartCell;
    cell.graphicWalker!.channels.facetX = { field: "region", aggregate: "sum", timeUnit: "none" };
    const visualize = vi.fn(); let run = await executeNotebook(input, { ...ports(), visualize });
    expect(run.cells[1].visualization).toBeUndefined(); expect(run.cells[1].visualizationNotice).toContain("分面"); expect(visualize).not.toHaveBeenCalled();
    cell.graphicWalker!.channels.facetX = null;
    Object.assign(input.sources[0].rows[0], { amount: null });
    run = await executeNotebook(input, { ...ports(), visualize });
    expect(run.cells[1].visualizationNotice).toContain("空值"); expect(visualize).not.toHaveBeenCalled();
    cell.graphicWalker!.channels.y!.aggregate = "count";
    run = await executeNotebook(input, ports());
    expect(run.cells[1].visualization?.table.rows).toEqual([{ viz_x: "个人", viz_y: 2 }, { viz_x: "企业", viz_y: 1 }]);
  });
  it("rejects a late cancelled chart result and prevents publication", async () => {
    const input = fixture(3), controller = new AbortController(), publishResult = vi.fn();
    const run = await executeNotebook({ ...input, targetCellId: "chart", signal: controller.signal }, { ...ports(), publishResult,
      visualize: async (...args) => { const output = await executeNotebookSql(...args); controller.abort(); return output; },
    });
    expect(run.cells[1].status).toBe("failure"); expect(run.cells[1].visualization).toBeUndefined(); expect(run.cells[1].resultRef).toBeUndefined();
    expect(publishResult).not.toHaveBeenCalled();
  });
});
