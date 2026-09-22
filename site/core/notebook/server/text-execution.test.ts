import { describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { NotebookCell } from "../definition";
import type { NotebookDocument, NotebookRun, NotebookTable } from "../contracts";
import type { NotebookQueryExecutor } from "../execution-contracts";
import { captureNotebookRunExpectation, parseNotebookRunReceipt } from "../run-receipt";
import { executeNotebook } from "./execution";
import { executeNotebookSql } from "./query-engine";

const parameter: NotebookCell = { id: "parameter", kind: "parameter", title: "合成参数", outputName: "parameter", parameter: { type: "number", value: 5 } };
const queryCell: NotebookCell = { id: "query", kind: "sql", title: "合成查询", inputCellIds: ["parameter"], outputName: "calculated", sql: "SELECT value * 2 AS value FROM parameter" };
function narrative(cellId = "parameter", field = "value"): Extract<NotebookCell, { kind: "text" }> {
  return { id: "note", kind: "text", title: "合成说明", markdown: "当前值 {{value}}", references: [{ key: "value", cellId, field }] };
}
function document(cells: NotebookCell[]): NotebookDocument { return { name: "合成文本运行", revision: 4, cells }; }
function scalar(value: NotebookTable["rows"][number][string]): NotebookTable {
  return { fields: [{ name: "value", label: "value", type: typeof value === "number" ? "number" : "string" }], rows: [{ value }], truncated: false };
}
function result(run: NotebookRun, id = "note") {
  const item = run.cells.find((cell) => cell.cellId === id);
  if (!item) throw new Error("Missing synthetic test result");
  return item;
}

describe("controlled narrative execution", () => {
  it.each([undefined, []])("preserves legacy static runs without output or effects (references=%s)", async (references) => {
    const markdown = "{{existing.literal}} 和 {{未闭合";
    const query = vi.fn(), python = vi.fn(), log = vi.fn(), publishResult = vi.fn();
    const run = await executeNotebook({ document: document([{ id: "note", kind: "text", title: "静态", markdown, references }]), sources: [], targetCellId: "note" }, { query, python, log, publishResult });
    expect(run.status).toBe("success");
    expect(result(run)).toMatchObject({ status: "success" });
    expect(result(run).text).toBeUndefined(); expect(result(run).table).toBeUndefined(); expect(result(run).resultRef).toBeUndefined();
    for (const effect of [query, python, log, publishResult]) expect(effect).not.toHaveBeenCalled();
  });
  it.each([false, true])("executes the current parameter before its narrative, without data/model access (forAi=%s)", async (forAi) => {
    const doc = document([narrative(), parameter]); const before = structuredClone(doc);
    const query = vi.fn(), python = vi.fn(), log = vi.fn(), publishResult = vi.fn(), connectionQuery = vi.fn();
    const run = await executeNotebook({ document: doc, sources: [], forAi, targetCellId: "note", connectionQuery }, { query, python, log, publishResult });
    expect(run.status).toBe("success");
    expect(run.cells.map((cell) => cell.cellId)).toEqual(["parameter", "note"]);
    expect(result(run)).toMatchObject({ status: "success", text: "当前值 5" });
    expect(result(run).table).toBeUndefined(); expect(result(run).resultRef).toBeUndefined();
    expect(result(run, "parameter").resultRef).toMatchObject({ complete: true, accessMode: forAi ? "ai" : "user" });
    expect(parseNotebookRunReceipt(run, captureNotebookRunExpectation(doc, forAi ? "ai" : "user", "note"))).toEqual(run);
    for (const effect of [query, python, log, publishResult, connectionQuery]) expect(effect).not.toHaveBeenCalled();
    expect(doc).toEqual(before);
  });
  it("runs real SQL and resolves multiple exact scalar fields in one pass", async () => {
    const sql = "SELECT value * 2 AS value, '900719925474099312345.000001' AS exact, '2026-09-17T12:00:00+08:00' AS day, NULL::VARCHAR AS empty, TRUE AS active, '{{value}} <script>ignored</script>' AS literal FROM parameter";
    const fields = ["value", "exact", "day", "empty", "active", "literal"];
    const note = { ...narrative("query"), markdown: fields.map((field) => `{{${field}}}`).join(" | "),
      references: fields.map((field) => ({ key: field, cellId: "query", field })) };
    const doc = document([note, { ...queryCell, sql }, parameter]);
    const before = structuredClone(doc); const query = vi.fn<NotebookQueryExecutor>(executeNotebookSql), log = vi.fn(), publishResult = vi.fn();
    const run = await executeNotebook({ document: doc, sources: [], targetCellId: "note" }, { query, log, publishResult });
    expect(run.status).toBe("success");
    expect(run.cells.map((cell) => cell.cellId)).toEqual(["parameter", "query", "note"]);
    expect(result(run).text).toBe("10 | 900719925474099312345.000001 | 2026-09-17T12:00:00+08:00 | NULL | true | {{value}} <script>ignored</script>");
    expect(result(run).table).toBeUndefined(); expect(result(run).resultRef).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(1); expect(query.mock.calls[0][0]).toBe(sql);
    expect(log).toHaveBeenCalledTimes(1); expect(publishResult).not.toHaveBeenCalled();
    expect(doc).toEqual(before);
  }, 15000);
  it("resolves a Python output through the same scalar contract without changing Python code", async () => {
    const code = "calculated = parameter.copy()";
    const execute = vi.fn(async () => ({ table: scalar("00123"), stdout: "", stderr: "" })), close = vi.fn(async () => {}), query = vi.fn();
    const doc = document([narrative("python"), parameter, { id: "python", kind: "python", title: "合成 Python", inputCellIds: ["parameter"], fileNames: [], outputName: "calculated", code }]);
    const run = await executeNotebook({ document: doc, sources: [], targetCellId: "note" }, { query, log: vi.fn(), python: async () => ({ execute, close }) });
    expect(run.status).toBe("success"); expect(result(run).text).toBe("当前值 00123");
    expect(execute).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code, tables: [expect.objectContaining({ name: "parameter", rows: [{ value: 5 }] })] }), expect.any(AbortSignal));
    expect(close).toHaveBeenCalledExactlyOnceWith(); expect(query).not.toHaveBeenCalled();
  });
  it.each([
    { label: "empty", table: { ...scalar(1), rows: [] }, message: "恰好 1 行" },
    { label: "multiple", table: { ...scalar(1), rows: [{ value: 1 }, { value: 2 }] }, message: "恰好 1 行" },
    { label: "truncated", table: { ...scalar(1), truncated: true }, message: "不完整" },
    { label: "missing own field", table: { ...scalar(1), rows: [{}] }, message: "字段不存在" },
    { label: "missing metadata", table: { ...scalar(1), fields: [{ name: "other", label: "other", type: "string" as const }] }, message: "字段不存在" },
  ])("rejects $label source output instead of publishing partial narrative", async ({ table, message }) => {
    const run = await executeNotebook({ document: document([parameter, queryCell, narrative("query")]), sources: [] }, { query: vi.fn().mockResolvedValue(table), log: vi.fn() });
    expect(run.status).toBe("failure"); expect(result(run, "query").status).toBe("success");
    expect(result(run)).toMatchObject({ status: "failure", error: expect.stringContaining(message) });
    expect(result(run).text).toBeUndefined(); expect(result(run).table).toBeUndefined(); expect(result(run).resultRef).toBeUndefined();
  });
  it("refuses overlong rendered text without leaking a prefix or publishing a table", async () => {
    const value = "x".repeat(8001); const publishResult = vi.fn();
    const run = await executeNotebook({ document: document([parameter, queryCell, narrative("query")]), sources: [], targetCellId: "note" }, { query: vi.fn().mockResolvedValue(scalar(value)), log: vi.fn(), publishResult });
    expect(result(run)).toMatchObject({ status: "failure", error: expect.stringContaining("超过 8000") });
    expect(result(run).text).toBeUndefined(); expect(result(run).error).not.toContain(value.slice(0, 20)); expect(publishResult).not.toHaveBeenCalled();
  });
  it("allows an empty string result while retaining an explicit successful text field", async () => {
    const note = { ...narrative("query"), markdown: "{{value}}" };
    const run = await executeNotebook({ document: document([parameter, queryCell, note]), sources: [] }, { query: vi.fn().mockResolvedValue(scalar("")), log: vi.fn() });
    expect(result(run)).toMatchObject({ status: "success", text: "" });
    expect(Object.hasOwn(result(run), "text")).toBe(true);
  });
  it("refuses malicious stored templates before querying or allocating any execution dependency", async () => {
    const note = narrative("query"); note.markdown = "{{value.constructor()}}";
    const query = vi.fn(), python = vi.fn(), log = vi.fn(), connectionQuery = vi.fn();
    await expect(executeNotebook({ document: document([parameter, queryCell, note]), sources: [], connectionQuery }, { query, python, log })).rejects.toThrow("文本模板");
    for (const effect of [query, python, log, connectionQuery]) expect(effect).not.toHaveBeenCalled();
  });
  it("never reuses a previous run's text when the current upstream fails", async () => {
    const doc = document([parameter, queryCell, narrative("query")]); const query = vi.fn().mockResolvedValueOnce(scalar(10)).mockRejectedValueOnce(new Error("synthetic SQL failure"));
    const first = await executeNotebook({ document: doc, sources: [] }, { query, log: vi.fn() });
    expect(result(first).text).toBe("当前值 10");
    const second = await executeNotebook({ document: doc, sources: [] }, { query, log: vi.fn() });
    expect(second.runId).not.toBe(first.runId); expect(result(second)).toMatchObject({ status: "blocked", error: expect.stringContaining("未使用旧结果") });
    expect(result(second).text).toBeUndefined(); expect(query).toHaveBeenCalledTimes(2);
  });
  it.each(["before run", "during upstream"])("cancellation %s prevents text and leaves a later retry usable", async (phase) => {
    const controller = new AbortController(); if (phase === "before run") controller.abort();
    const query = vi.fn(async () => { controller.abort(); return scalar(10); }), publishResult = vi.fn();
    const doc = document([parameter, queryCell, narrative("query")]);
    const cancelled = await executeNotebook({ document: doc, sources: [], signal: controller.signal, targetCellId: "note" }, { query, log: vi.fn(), publishResult });
    expect(cancelled.status).toBe("failure"); expect(result(cancelled).status).toBe("blocked"); expect(result(cancelled).text).toBeUndefined();
    expect(query).toHaveBeenCalledTimes(phase === "before run" ? 0 : 1); expect(publishResult).not.toHaveBeenCalled();
    const retried = await executeNotebook({ document: doc, sources: [] }, { query: vi.fn().mockResolvedValue(scalar(12)), log: vi.fn() });
    expect(result(retried).text).toBe("当前值 12");
  });
  it("applies original AI masking/denial before narrative reads, without a second source pathway", async () => {
    const { source, rows } = semanticFixture();
    const sensitive = { ...source, rowCount: 1, aiAccessPolicy: "masked" as const, fields: source.fields.map((field) => field.name === "region" ? { ...field, sensitiveCategories: ["email" as const] } : field) };
    const data: NotebookCell = { id: "data", kind: "data", title: "合成数据", sourceDataSourceId: source.id, outputName: "data_rows" };
    const doc = document([data, narrative("data", "region")]); const query = vi.fn(), log = vi.fn();
    const inputRows = rows.slice(0, 1); const before = structuredClone(inputRows);
    const masked = await executeNotebook({ document: doc, sources: [{ source: sensitive, rows: inputRows }], forAi: true }, { query, log });
    expect(result(masked).text).toBe("当前值 匿名_1"); expect(JSON.stringify(masked)).not.toContain(inputRows[0].region);
    const manual = await executeNotebook({ document: doc, sources: [{ source: sensitive, rows: inputRows }] }, { query, log });
    expect(result(manual).text).toBe(`当前值 ${inputRows[0].region}`);
    await expect(executeNotebook({ document: doc, sources: [{ source: { ...sensitive, aiAccessPolicy: "pending" }, rows: inputRows }], forAi: true }, { query, log })).rejects.toThrow("请先确认");
    expect(inputRows).toEqual(before); expect(query).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  });
  it("does not run unrelated descendants when the requested target is a narrative", async () => {
    const unrelated: NotebookCell = { ...queryCell, id: "other", outputName: "other", sql: "SELECT missing FROM parameter" };
    const query = vi.fn(); const run = await executeNotebook({ document: document([narrative(), unrelated, parameter]), targetCellId: "note", sources: [] }, { query, log: vi.fn() });
    expect(run.cells.map((cell) => cell.cellId)).toEqual(["parameter", "note"]); expect(query).not.toHaveBeenCalled();
  });
});
