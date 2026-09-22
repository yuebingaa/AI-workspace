import { describe, expect, it, vi } from "vitest";
import type { NotebookCell } from "../definition";
import type { NotebookDocument, NotebookRun } from "../contracts";
import type { NotebookPythonSession, NotebookQueryExecutor } from "../execution-contracts";
import type { NotebookParameter } from "../parameter";
import { captureNotebookRunExpectation, parseNotebookRunReceipt } from "../run-receipt";
import { notebookDatasetProvenance } from "../provenance";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { executeNotebook } from "./execution";
import { executeNotebookSql } from "./query-engine";

function parameter(id: string, value: NotebookParameter): Extract<NotebookCell, { kind: "parameter" }> {
  return { id, kind: "parameter", title: id, outputName: id, parameter: value };
}
function document(cells: NotebookCell[]): NotebookDocument { return { name: "Synthetic parameter execution", revision: 3, cells }; }
function result(run: NotebookRun, id: string) {
  const cell = run.cells.find((item) => item.cellId === id);
  if (!cell) throw new Error(`Missing synthetic result: ${id}`);
  return cell;
}
const scalar = parameter("threshold", { type: "number", value: 5 });
const queryCell: NotebookCell = { id: "query", kind: "sql", title: "Multiply", inputCellIds: ["threshold"], outputName: "calculated", sql: "SELECT value * 2 AS value FROM threshold" };
const showCell: NotebookCell = { id: "show", kind: "table", title: "Show", inputCellId: "query", columns: ["value"] };

describe("Notebook parameter execution through existing ports", () => {
  it.each([false, true])("returns real parameter evidence without any external call (forAi=%s)", async (forAi) => {
    const doc = document([scalar]), query = vi.fn(), python = vi.fn(), log = vi.fn(), connectionQuery = vi.fn();
    const run = await executeNotebook({ document: doc, sources: [], forAi, connectionQuery }, { query, python, log });
    expect(run.status).toBe("success");
    expect(result(run, "threshold")).toMatchObject({ status: "success", table: {
      fields: [{ name: "value", label: "value", type: "number" }], rows: [{ value: 5 }], truncated: false,
    }, resultRef: { runId: run.runId, cellId: "threshold", revision: 3, inputResultIds: [],
      sourceDatasetIds: [], rowCount: 1, complete: true, accessMode: forAi ? "ai" : "user" } });
    expect(parseNotebookRunReceipt(run, captureNotebookRunExpectation(doc, forAi ? "ai" : "user"))).toEqual(run);
    for (const effect of [query, python, log, connectionQuery]) expect(effect).not.toHaveBeenCalled();
  });

  it("binds all four types as data in real SQL, retaining malicious-looking text as a literal", async () => {
    const literal = "  O'Reilly'); DROP TABLE threshold; --\n{{execute(secret)}} ";
    const parameters = [parameter("typed_text", { type: "text", value: literal }), scalar,
      parameter("day", { type: "date", value: "2024-02-29" }), parameter("region", { type: "select", value: "华东", options: ["华东", "华南"] })];
    const sql = "SELECT t.value AS literal, n.value * 2 AS amount, CAST(d.value AS DATE) AS chosen_date, r.value AS region FROM typed_text t CROSS JOIN threshold n CROSS JOIN day d CROSS JOIN region r";
    const doc = document([{ id: "show", kind: "table", title: "Show", inputCellId: "query", columns: ["literal", "amount", "chosen_date", "region"] },
      { id: "query", kind: "sql", title: "Four inputs", inputCellIds: parameters.map((cell) => cell.id), outputName: "joined", sql }, ...parameters]);
    const before = structuredClone(doc), query = vi.fn<NotebookQueryExecutor>(executeNotebookSql), log = vi.fn();
    const run = await executeNotebook({ document: doc, sources: [] }, { query, log });
    expect(run.status).toBe("success");
    expect(run.cells.map((cell) => cell.cellId)).toEqual(["typed_text", "threshold", "day", "region", "query", "show"]);
    expect(result(run, "show").table?.rows).toEqual([{ literal, amount: 10, chosen_date: "2024-02-29", region: "华东" }]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toBe(sql);
    expect(query.mock.calls[0][0]).not.toContain(literal);
    expect(query.mock.calls[0][1].map((table) => table.name)).toEqual(parameters.map((cell) => cell.outputName));
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sql, sourceIds: [], status: "success" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain(literal);
    expect(doc).toEqual(before);
    expect(parseNotebookRunReceipt(run, captureNotebookRunExpectation(doc, "user"))).toEqual(run);
  }, 20_000);

  it("filters actual Dataset rows using a declared numeric parameter and keeps source lineage", async () => {
    const { source, rows } = semanticFixture();
    const minimum = parameter("minimum", { type: "number", value: 80 });
    const doc = document([
      { id: "query", kind: "sql", title: "Filter", inputCellIds: ["data", "minimum"], outputName: "filtered",
        sql: "SELECT s.region, SUM(s.amount) AS revenue FROM sales s CROSS JOIN minimum p WHERE s.amount >= p.value GROUP BY s.region ORDER BY s.region" },
      minimum, { id: "data", kind: "data", title: "Sales", sourceDataSourceId: source.id, outputName: "sales" },
      { id: "chart", kind: "chart", title: "Revenue", inputCellId: "query", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
    ]);
    const run = await executeNotebook({ document: doc, sources: [{ source, rows }] }, { query: executeNotebookSql, log: vi.fn() });
    expect(run.status).toBe("success");
    expect(result(run, "chart").table?.rows).toEqual([{ region: "华东", revenue: 100 }, { region: "华南", revenue: 80 }]);
    expect(result(run, "chart").resultRef?.sourceDatasetIds).toEqual([source.id]);
    expect(result(run, "query").resultRef?.inputResultIds).toEqual([`${run.runId}:data`, `${run.runId}:minimum`]);
    const provenance = notebookDatasetProvenance(doc, run, "chart");
    expect(provenance.lineage?.sourceDatasetIds).toEqual([source.id]);
    expect(provenance.lineage?.steps.find((step) => step.cellId === "minimum")?.kind).toBe("parameter");
  }, 20_000);

  it("passes typed parameter DataFrames to Python without interpolating code", async () => {
    const parameters = [scalar, parameter("date_value", { type: "date", value: "2026-09-17" }), parameter("label", { type: "text", value: "'\n__import__('os')" })];
    const code = "result = threshold.copy()";
    const execute = vi.fn<NotebookPythonSession["execute"]>(async () => ({
      table: { fields: [{ name: "value", label: "value", type: "number" }], rows: [{ value: 5 }], truncated: false }, stdout: "", stderr: "",
    })), close = vi.fn(async () => {}), query = vi.fn(), log = vi.fn();
    const doc = document([...parameters, { id: "py", kind: "python", title: "Python", inputCellIds: parameters.map((cell) => cell.id), fileNames: [], outputName: "result", code }]);
    const run = await executeNotebook({ document: doc, sources: [] }, { query, log, python: async () => ({ execute, close }) });
    expect(run.status).toBe("success");
    expect(execute).toHaveBeenCalledExactlyOnceWith({ code, outputName: "result", files: [], tables: [
      { name: "threshold", fields: [{ name: "value", label: "value", type: "number" }], rows: [{ value: 5 }] },
      { name: "date_value", fields: [{ name: "value", label: "value", type: "date" }], rows: [{ value: "2026-09-17" }] },
      { name: "label", fields: [{ name: "value", label: "value", type: "string" }], rows: [{ value: "'\n__import__('os')" }] },
    ] }, expect.any(AbortSignal));
    expect(close).toHaveBeenCalledExactlyOnceWith();
    expect(query).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
    expect(result(run, "py").resultRef?.inputResultIds).toEqual(parameters.map((cell) => `${run.runId}:${cell.id}`));
  });

  it("rejects invalid stored values before calling any runtime dependency", async () => {
    const doc = document([structuredClone(scalar), queryCell]);
    Object.assign(doc.cells[0], { parameter: { type: "select", value: "missing", options: ["allowed"] } });
    const query = vi.fn(), python = vi.fn(), log = vi.fn(), connectionQuery = vi.fn();
    await expect(executeNotebook({ document: doc, sources: [], connectionQuery }, { query, python, log })).rejects.toThrow();
    for (const effect of [query, python, log, connectionQuery]) expect(effect).not.toHaveBeenCalled();
  });

  it("does not publish a parameter or run descendants after an already cancelled request", async () => {
    const signal = AbortSignal.abort(), query = vi.fn(), publishResult = vi.fn();
    const run = await executeNotebook({ document: document([scalar, queryCell, showCell]), sources: [], signal, targetCellId: "show" }, { query, log: vi.fn(), publishResult });
    expect(run.status).toBe("failure");
    expect(run.cells.map((cell) => cell.status)).toEqual(["failure", "blocked", "blocked"]);
    for (const cell of run.cells) { expect(cell.table).toBeUndefined(); expect(cell.resultRef).toBeUndefined(); }
    expect(query).not.toHaveBeenCalled(); expect(publishResult).not.toHaveBeenCalled();
  });

  it("rejects late query success after cancellation, then reruns with a fresh parameter", async () => {
    const controller = new AbortController(), publishResult = vi.fn();
    const query = vi.fn<NotebookQueryExecutor>(async () => {
      controller.abort();
      return { fields: [{ name: "value", label: "value", type: "number" }], rows: [{ value: 10 }], truncated: false };
    });
    const doc = document([scalar, queryCell, showCell]);
    const cancelled = await executeNotebook({ document: doc, sources: [], signal: controller.signal, targetCellId: "show" }, { query, log: vi.fn(), publishResult });
    expect(result(cancelled, "query").status).toBe("failure");
    expect(result(cancelled, "query").table).toBeUndefined();
    expect(result(cancelled, "show").status).toBe("blocked");
    expect(publishResult).not.toHaveBeenCalled();
    const retriedDoc = { ...doc, revision: 4, cells: [parameter("threshold", { type: "number", value: 9 }), queryCell, showCell] };
    const retried = await executeNotebook({ document: retriedDoc, sources: [], targetCellId: "show" }, { query: executeNotebookSql, log: vi.fn(), publishResult });
    expect(retried.status).toBe("success");
    expect(result(retried, "show").table?.rows).toEqual([{ value: 18 }]);
    expect(retried.runId).not.toBe(cancelled.runId);
    expect(result(retried, "threshold").resultRef?.dataSignature).not.toBe(result(cancelled, "threshold").resultRef?.dataSignature);
    expect(publishResult).toHaveBeenCalledExactlyOnceWith({ reference: result(retried, "show").resultRef, table: result(retried, "show").table });
  }, 20_000);

  it("does not bypass pending AI data access when a parameter is also present", async () => {
    const { source, rows } = semanticFixture();
    const query = vi.fn();
    const doc = document([scalar, { id: "data", kind: "data", title: "Private", sourceDataSourceId: source.id, outputName: "sales" }]);
    await expect(executeNotebook({ document: doc, sources: [{ source: { ...source, aiAccessPolicy: "pending" }, rows }], forAi: true }, { query, log: vi.fn() })).rejects.toThrow("请先确认");
    expect(query).not.toHaveBeenCalled();
  });
});
