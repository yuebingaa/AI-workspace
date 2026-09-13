import { describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { notebookDocumentSchema, type NotebookDocument } from "./contracts";
import { adoptNotebookDraft, notebookFingerprint, moveNotebookCell } from "./client-state";
import { affectedCells, cellsToRun, updateNotebook, validateNotebook } from "./graph";
import { normalizeNotebookSql } from "./sql";
import { executeNotebookSql } from "./server/query-engine";
import { runNotebook } from "./server/runtime";
import { createHarnessNotebookArtifact } from "@/core/harness/notebook";

function fixture() {
  const { source, rows, model, product } = semanticFixture();
  const document: NotebookDocument = { name: "销售 Notebook", revision: 0, cells: [
    { id: "data", kind: "data", title: "销售", sourceDataSourceId: source.id, outputName: "sales" },
    { id: "query", kind: "sql", title: "按地区汇总", inputCellIds: ["data"], outputName: "totals", sql: 'SELECT region, SUM(amount) AS revenue FROM sales GROUP BY region ORDER BY region' },
    { id: "chart", kind: "chart", title: "区域销售额", inputCellId: "query", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
    { id: "text", kind: "text", title: "说明", markdown: "真实查询结果，不修改源数据。" },
  ] };
  return { source, rows, model, product, document, sources: [{ source, rows }] };
}
describe("Notebook dependency and adoption", () => {
  it("loads legacy empty documents, rejects duplicate/cyclic/forward dependencies", () => {
    expect(notebookDocumentSchema.parse({ name: "new", revision: 0, cells: [] }).cells).toEqual([]);
    const { document } = fixture();
    expect(() => validateNotebook({ ...document, cells: [...document.cells, document.cells[0]] })).toThrow("重复");
    expect(() => moveNotebookCell(document, "query", -1)).toThrow("排在它之前");
    expect(cellsToRun(document, "chart").map((cell) => cell.id)).toEqual(["data", "query", "chart"]);
    expect([...affectedCells(document.cells, ["data"])]).toEqual(["data", "query", "chart"]);
  });
  it("invalidates only dependent cells, preserves adoption marker and source changes", () => {
    const { document, source, model } = fixture();
    const edited = updateNotebook({ ...document, lastDraftId: "accepted" }, document.cells.map((cell) => cell.kind === "sql" ? { ...cell, sql: 'SELECT region, amount AS revenue FROM sales' } : cell));
    expect(edited.lastDraftId).toBe("accepted");
    expect(notebookFingerprint(edited, "data", [source], [model])).toBe(notebookFingerprint(document, "data", [source], [model]));
    expect(notebookFingerprint(edited, "chart", [source], [model])).not.toBe(notebookFingerprint(document, "chart", [source], [model]));
    expect(notebookFingerprint(edited, "chart", [], [model])).not.toBe(notebookFingerprint(edited, "chart", [source], [model]));
  });
  it("adopts a verified draft once and refuses concurrent revision overwrite", () => {
    const { document, source, product } = fixture();
    const artifact = createHarnessNotebookArtifact({ name: document.name, cells: document.cells }, { request: { idempotencyKey: "notebook_draft_test", instruction: "创建 Notebook", pageId: "page_home", role: "editor", appSpec: product.appSpec, recipes: [] }, allowedDataSourceIds: [source.id], now: Date.now, id: () => "test" });
    artifact.baseRevision = 0;
    expect(() => adoptNotebookDraft(document, artifact)).toThrow("试运行证据");
    artifact.executionEvidence = { runId: "test", status: "success", completedCellIds: document.cells.map((cell) => cell.id), summary: "已运行" };
    const adopted = adoptNotebookDraft(document, artifact);
    expect(adopted.revision).toBe(1);
    expect(() => adoptNotebookDraft(adopted, artifact)).toThrow("已经采用");
    expect(() => adoptNotebookDraft({ ...document, revision: 1 }, artifact)).toThrow("未覆盖");
  });
});
describe("actual isolated DuckDB", () => {
  it("runs a multi-table join and GROUP BY on full input, not previews", async () => {
    const field = (name: string, type: "string" | "number") => ({ name, label: name, type });
    const result = await executeNotebookSql('SELECT s.region, COUNT(*) AS orders, SUM(s.amount * r.rate) AS revenue FROM sales s JOIN rates r ON s.region=r.region GROUP BY s.region', [
      { name: "sales", fields: [field("region", "string"), field("amount", "number")], rows: Array.from({ length: 1324 }, () => ({ region: "East", amount: 2 })) },
      { name: "rates", fields: [field("region", "string"), field("rate", "number")], rows: [{ region: "East", rate: 3 }] },
    ]);
    expect(result.rows).toEqual([{ region: "East", orders: 1324, revenue: 7944 }]);
    expect(result.fields.map((item) => item.type)).toEqual(["string", "number", "number"]);
  }, 15_000);
  it("preserves unsafe integers and decimal precision, empty result fields, null and boolean", async () => {
    const result = await executeNotebookSql("SELECT 9007199254740993::BIGINT AS large_id, 123.4500000001::DECIMAL(20,10) AS exact, true AS enabled, NULL::VARCHAR AS empty", []);
    expect(result.rows).toEqual([{ large_id: "9007199254740993", exact: "123.4500000001", enabled: true, empty: null }]);
    const empty = await executeNotebookSql("SELECT 1 AS value WHERE false", []);
    expect(empty.rows).toEqual([]); expect(empty.fields[0].name).toBe("value");
  }, 15_000);
  it("caps returned rows and forbids chaining a truncated result", async () => {
    const { document, sources } = fixture();
    const first = { ...document.cells[1], sql: "SELECT i FROM range(2000) t(i)" } as typeof document.cells[number];
    const doc: NotebookDocument = { ...document, cells: [document.cells[0], first, { id: "next", kind: "sql", title: "不能汇总截断结果", inputCellIds: ["query"], outputName: "second", sql: "SELECT COUNT(*) FROM totals" }] };
    const run = await runNotebook({ document: doc, sources, log: () => {} });
    expect(run.cells[1].table?.rows).toHaveLength(1000); expect(run.cells[1].table?.truncated).toBe(true);
    expect(run.cells[2].status).toBe("failure"); expect(run.cells[2].error).toContain("截断");
  }, 15_000);
  it("blocks host file/network reads and autoload, has locked config", async () => {
    const settings = await executeNotebookSql("SELECT current_setting('enable_external_access') AS external_access, current_setting('lock_configuration') AS locked", []);
    expect(settings.rows[0]).toEqual({ external_access: false, locked: true });
    for (const sql of ["SELECT * FROM read_csv_auto('C:/notebook-access-must-be-denied.csv')", "SELECT * FROM read_csv_auto('http://127.0.0.1:39999/never-request')", "SELECT * FROM sqlite_scan('C:/never-open.sqlite','table')"]) {
      await expect(executeNotebookSql(sql, [])).rejects.toThrow(/disabled|not found|not exist|Permission|access|extension/iu);
    }
  }, 20_000);
  it("accepts quoted semicolons/comments but rejects scripts before execution", () => {
    expect(normalizeNotebookSql("/* comment */ SELECT ';DELETE' AS value; -- end")).toBe("/* comment */ SELECT ';DELETE' AS value");
    for (const sql of ["SELECT 1; DROP TABLE x", "WITH x AS (SELECT 1) DELETE FROM x", "CALL test()", "SELECT 1 /* unclosed"]) expect(() => normalizeNotebookSql(sql)).toThrow();
  });
  it("kills timed-out/cancelled query processes and later runs still work", async () => {
    await expect(executeNotebookSql("SELECT SUM(i) FROM range(1000000000000) t(i)", [], undefined, 100)).rejects.toThrow("超时");
    const controller = new AbortController();
    const running = executeNotebookSql("SELECT SUM(i) FROM range(1000000000000) t(i)", [], controller.signal);
    controller.abort(); await expect(running).rejects.toThrow("取消");
    expect((await executeNotebookSql("SELECT 7 AS value", [])).rows).toEqual([{ value: 7 }]);
  }, 15_000);
  it("does not share tables or results across calls", async () => {
    await executeNotebookSql("SELECT * FROM private_input", [{ name: "private_input", fields: [{ name: "value", label: "value", type: "number" }], rows: [{ value: 27 }] }]);
    await expect(executeNotebookSql("SELECT * FROM private_input", [])).rejects.toThrow(/not exist/iu);
  }, 15_000);
  it("rejects non-finite results instead of silently converting them to null", async () => {
    await expect(executeNotebookSql("SELECT 'NaN'::DOUBLE AS value", [])).rejects.toThrow("NaN");
  }, 15_000);
});
describe("Notebook execution evidence", () => {
  it("produces actual SQL/chart results and minimal user-scoped query receipts", async () => {
    const { document, sources } = fixture(); const log = vi.fn();
    const run = await runNotebook({ document, sources, log, userId: "local", taskId: "test_task" });
    expect(run.status).toBe("success");
    expect(run.cells[2].table?.rows).toHaveLength(2);
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ userId: "local", taskId: "test_task", returnedRows: 2, status: "success", bytesScanned: null }));
    expect(log.mock.calls[0][0]).not.toHaveProperty("rows");
  }, 15_000);
  it("marks failed/blocked steps; does not run downstream or reuse old results", async () => {
    const { document, sources } = fixture(); const query = vi.fn().mockRejectedValue(new Error("SQL invalid"));
    const run = await runNotebook({ document, sources, query, log: () => {} });
    expect(run.cells.map((cell) => cell.status)).toEqual(["success", "failure", "blocked", "success"]);
    expect(run.cells[2]).not.toHaveProperty("table"); expect(query).toHaveBeenCalledTimes(1);
  });
  it("executes exact semantic model versions without double aggregation", async () => {
    const { document, sources, model } = fixture();
    const doc: NotebookDocument = { ...document, cells: [document.cells[0], { id: "semantic", kind: "semanticQuery", title: "销售口径", inputCellId: "data", outputName: "metrics", modelId: model.id, modelVersion: model.version, dimensions: ["area"], measures: ["revenue"], limit: 100 }] };
    const run = await runNotebook({ document: doc, sources, semanticModels: [model] });
    expect(run.status).toBe("success"); expect(run.cells[1].table?.rows).toContainEqual({ area: "华东", revenue: 150 });
    const stale = await runNotebook({ document: doc, sources, semanticModels: [{ ...model, version: model.version + 1 }] });
    expect(stale.cells[1].error).toContain("版本");
  });
  it("sanitizes inputs before SQL, including aliases, and denies pending AI access", async () => {
    const { document, source, rows } = fixture();
    const sensitive = { ...source, aiAccessPolicy: "masked" as const, fields: source.fields.map((field) => field.name === "region" ? { ...field, sensitiveCategories: ["email" as const] } : field) };
    const run = await runNotebook({ document, sources: [{ source: sensitive, rows }], forAi: true, log: () => {} });
    expect(run.status).toBe("success"); expect(JSON.stringify(run)).not.toContain("华东"); expect(JSON.stringify(run)).not.toContain("华南");
    expect(run.cells[1].table?.rows.some((row) => row.revenue === 150)).toBe(true);
    await expect(runNotebook({ document, sources: [{ source: { ...sensitive, aiAccessPolicy: "pending" }, rows }], forAi: true })).rejects.toThrow("请先确认");
  }, 15_000);
});
