import { describe, expect, it, vi } from "vitest";
import { notebookDatasetProvenance } from "./provenance";
import { executeNotebook } from "./server/execution";
import type { NotebookDocument, NotebookTable } from "./contracts";
import type { CatalogReference } from "@/core/metadata/contracts";
import { notebookDatasetProvenanceSchema } from "@/core/datasets/provenance";
import { semanticFixture } from "@/core/semantic/test-fixture";

const table: NotebookTable = { fields: [{ name: "amount", label: "金额", type: "number" }], rows: [{ amount: 230 }], truncated: false };
const catalogRef: CatalogReference = { id: "catalog_sales", connectionId: "sales", revision: 3,
  schemaFingerprint: "a".repeat(64), syncedAt: "2026-09-14T00:00:00.000Z", complete: false };
const document: NotebookDocument = { name: "来源测试", revision: 7, cells: [
  { id: "remote", kind: "warehouseSql", title: "销售查询", connectionId: "sales", outputName: "sales", sql: "SELECT amount FROM orders" },
  { id: "local", kind: "sql", title: "汇总", inputCellIds: ["remote"], outputName: "totals", sql: "SELECT SUM(amount) AS amount FROM sales" },
  { id: "unrelated", kind: "warehouseSql", title: "无关查询", connectionId: "other", outputName: "unused", sql: "SELECT unrelated_private_column FROM other" },
] };
describe("Dataset query provenance", () => {
  it("stores only executed ancestors, SQL and catalog versions and remains independent of later edits", async () => {
    const log = vi.fn();
    const run = await executeNotebook({ document, sources: [], targetCellId: "local", connectionQuery: async () => ({ ...table, catalogRef }) }, { query: async () => table, log });
    const provenance = notebookDatasetProvenance(document, run, "local");
    expect(provenance.connectionIds).toEqual(["sales"]);
    expect(provenance.lineage?.steps.map((step) => step.cellId)).toEqual(["remote", "local"]);
    expect(provenance.lineage?.steps[0].catalogRef).toEqual(catalogRef);
    expect(JSON.parse(provenance.lineage!.steps[1].definition).sql).toBe("SELECT SUM(amount) AS amount FROM sales");
    expect(provenance.lineage).toMatchObject({ rowCount: 1, complete: true, accessMode: "user", sourceDatasetIds: [] });
    expect(JSON.stringify(provenance)).not.toContain("unrelated_private_column");
    expect(JSON.stringify(provenance)).not.toContain('"rows"');
    expect(log.mock.calls[0][0]).toMatchObject({ runId: run.runId, revision: 7, catalogRef, sourceIds: [] });
    const edited = structuredClone(document); edited.revision++;
    expect(() => notebookDatasetProvenance(edited, run, "local")).toThrow("版本已变化");
    expect(notebookDatasetProvenanceSchema.parse(JSON.parse(JSON.stringify(provenance)))).toEqual(provenance);
  });

  it("records declared Dataset ancestry without attributing unrelated sources to a query", async () => {
    const { source, rows } = semanticFixture(); const log = vi.fn();
    const doc: NotebookDocument = { name: "输入隔离", revision: 0, cells: [
      { id: "input", kind: "data", title: "数据", sourceDataSourceId: source.id, outputName: "sales" },
      { id: "unused", kind: "data", title: "无关数据", sourceDataSourceId: "unused", outputName: "unused" },
      { id: "local", kind: "sql", title: "汇总", inputCellIds: ["input"], outputName: "totals", sql: "SELECT SUM(amount) AS amount FROM sales" },
    ] };
    const run = await executeNotebook({ document: doc, sources: [{ source, rows }, { source: { ...source, id: "unused" }, rows }] }, { query: async () => table, log });
    expect(log.mock.calls[0][0].sourceIds).toEqual([source.id]);
    const provenance = notebookDatasetProvenance(doc, run, "local");
    expect(provenance.lineage?.sourceDatasetIds).toEqual([source.id]);
    expect(provenance.lineage?.steps.map((step) => step.cellId)).toEqual(["input", "local"]);
  });

  it("rejects partial and failed results without inventing historical detail", async () => {
    const run = await executeNotebook({ document, sources: [], targetCellId: "remote", connectionQuery: async () => ({ ...table, truncated: true }) }, { query: async () => table, log: vi.fn() });
    expect(() => notebookDatasetProvenance(document, run, "remote")).toThrow("不完整");
    const failed = structuredClone(run); failed.cells[0].status = "failure";
    expect(() => notebookDatasetProvenance(document, failed, "remote")).toThrow();
    const legacy = { kind: "notebook", runId: "old-run", resultId: "old-result", cellId: "old-cell", revision: 1, connectionIds: [] };
    expect(notebookDatasetProvenanceSchema.parse(legacy)).toEqual(legacy);
  });
});
