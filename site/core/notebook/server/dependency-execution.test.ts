import { afterEach, describe, expect, it, vi } from "vitest";
import type { HarnessRequest } from "@/core/harness/contracts";
import { executeHarnessTool } from "@/core/harness/tool-registry";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { NotebookDocument, NotebookRun } from "../contracts";
import type { NotebookQueryExecutor, NotebookRunInput } from "../execution-contracts";
import { notebookDatasetProvenance } from "../provenance";
import { executeNotebook } from "./execution";
import { executeNotebookSql } from "./query-engine";

function fixture() {
  const { source, rows, product } = semanticFixture();
  // Display order intentionally differs from the declared dependency order.
  const document: NotebookDocument = { name: "Explicit dependency execution", revision: 4, cells: [
    { id: "chart", kind: "chart", title: "Regional revenue", inputCellId: "recipe", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
    { id: "summary", kind: "sql", title: "Grand total", inputCellIds: ["recipe"], outputName: "grand_total", sql: "SELECT SUM(revenue) AS revenue FROM totals" },
    { id: "recipe", kind: "transform", title: "Double and aggregate", inputCellId: "query", outputName: "totals", steps: [
      { id: "double", type: "deriveField", field: "doubled", label: "Doubled", operator: "multiply", left: { kind: "field", field: "amount" }, right: { kind: "literal", value: 2 } },
      { id: "aggregate", type: "groupAggregate", groupBy: ["region"], aggregations: [{ field: "doubled", aggregation: "sum", as: "revenue", label: "Revenue" }] },
    ] },
    { id: "query", kind: "sql", title: "Sales rows", inputCellIds: ["data"], outputName: "raw_sales", sql: "SELECT region, amount FROM sales ORDER BY region, amount" },
    { id: "data", kind: "data", title: "Sales", sourceDataSourceId: source.id, outputName: "sales" },
  ] };
  return { document, source, rows, product, sources: [{ source, rows }] };
}

function result(run: NotebookRun, cellId: string) {
  const cell = run.cells.find((entry) => entry.cellId === cellId);
  if (!cell) throw new Error(`Missing synthetic result: ${cellId}`);
  return cell;
}

function actualQuery() {
  return vi.fn<NotebookQueryExecutor>(executeNotebookSql);
}

afterEach(() => vi.useRealTimers());

describe("Notebook explicit dependencies through the real local engine", () => {
  it("executes shuffled data / SQL / transform / chart cells without changing display order", async () => {
    const { document, sources, source } = fixture();
    const before = structuredClone(document);
    const query = actualQuery(), log = vi.fn();
    const run = await executeNotebook({ document, sources }, { query, log });
    expect(run.status).toBe("success");
    expect(run.cells.map((cell) => cell.cellId)).toEqual(["data", "query", "recipe", "chart", "summary"]);
    expect(document).toEqual(before);
    expect(result(run, "chart").table?.rows).toEqual([
      { region: "华东", revenue: 300 }, { region: "华南", revenue: 160 },
    ]);
    expect(result(run, "summary").table?.rows).toEqual([{ revenue: 460 }]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1].map((table) => table.name)).toEqual(["sales"]);
    expect(query.mock.calls[1][1].map((table) => table.name)).toEqual(["totals"]);
    expect(query.mock.calls[1][1][0].rows).toEqual(result(run, "recipe").table?.rows);
    for (const [cellId, inputIds] of [
      ["data", []], ["query", ["data"]], ["recipe", ["query"]],
      ["chart", ["recipe"]], ["summary", ["recipe"]],
    ] as const) {
      expect(result(run, cellId).resultRef).toMatchObject({ runId: run.runId, cellId, revision: 4,
        accessMode: "user", complete: true, sourceDatasetIds: [source.id],
        inputResultIds: inputIds.map((id) => `${run.runId}:${id}`),
      });
    }
    expect(log.mock.calls.map(([entry]) => entry.cellId)).toEqual(["query", "summary"]);
    expect(log.mock.calls[1][0]).toMatchObject({ inputResultIds: [`${run.runId}:recipe`], sourceIds: [source.id], status: "success" });
    expect(log.mock.calls[1][0]).not.toHaveProperty("rows");
  }, 20_000);

  it("runs only a target's ancestors and saves their explicit lineage, not unrelated sources", async () => {
    const { document, sources, source, rows } = fixture();
    const unrelatedSource = { ...source, id: "unrelated_source" };
    document.cells.unshift(
      { id: "unrelated_query", kind: "sql", title: "Must not run", inputCellIds: ["unrelated_data"], outputName: "unrelated_output", sql: "SELECT nonexistent_private_field FROM unrelated_rows" },
      { id: "unrelated_data", kind: "data", title: "Unrelated source", sourceDataSourceId: unrelatedSource.id, outputName: "unrelated_rows" },
    );
    const before = structuredClone(document);
    const query = actualQuery(), log = vi.fn();
    const run = await executeNotebook({ document, sources: [...sources, { source: unrelatedSource, rows }], targetCellId: "chart" }, { query, log });
    expect(run.status).toBe("success");
    expect(run.cells.map((cell) => cell.cellId)).toEqual(["data", "query", "recipe", "chart"]);
    expect(query).toHaveBeenCalledTimes(1);
    expect(document).toEqual(before);
    const provenance = notebookDatasetProvenance(document, run, "chart");
    expect(provenance.lineage?.steps.map((step) => step.cellId)).toEqual(["data", "query", "recipe", "chart"]);
    expect(provenance.lineage?.steps.map((step) => step.inputCellIds)).toEqual([[], ["data"], ["query"], ["recipe"]]);
    expect(provenance.lineage).toMatchObject({ complete: true, rowCount: 2, sourceDatasetIds: [source.id], accessMode: "user" });
    for (const step of provenance.lineage!.steps) {
      expect(step.resultId).toBe(`${run.runId}:${step.cellId}`);
      expect(JSON.parse(step.definition)).toEqual(document.cells.find((cell) => cell.id === step.cellId));
    }
    expect(JSON.stringify(provenance)).not.toContain("unrelated");
    expect(JSON.stringify(provenance)).not.toContain('"rows":');
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cellId: "query", sourceIds: [source.id] }));
  }, 20_000);

  it("binds multiple SQL inputs in their declared order even when scheduling and display differ", async () => {
    const { source, rows } = fixture();
    const rates = { ...source, id: "synthetic_rates", fields: source.fields.map((field) => field.name === "amount"
      ? { ...field, name: "multiplier", label: "Multiplier" } : field), rowCount: 2 };
    const document: NotebookDocument = { name: "Multiple explicit inputs", revision: 0, cells: [
      { id: "join", kind: "sql", title: "Join", inputCellIds: ["rates", "data"], outputName: "joined", sql: "SELECT s.region, SUM(s.amount * r.multiplier) AS revenue FROM sales s JOIN rates r ON s.region = r.region GROUP BY s.region ORDER BY s.region" },
      { id: "data", kind: "data", title: "Sales", sourceDataSourceId: source.id, outputName: "sales" },
      { id: "show", kind: "table", title: "Joined result", inputCellId: "join", columns: ["region", "revenue"] },
      { id: "rates", kind: "data", title: "Rates", sourceDataSourceId: rates.id, outputName: "rates" },
    ] };
    const query = actualQuery(), log = vi.fn();
    const run = await executeNotebook({ document, sources: [{ source, rows }, { source: rates, rows: [
      { region: "华东", multiplier: 2 }, { region: "华南", multiplier: 3 },
    ] }] }, { query, log });
    expect(run.cells.map((cell) => cell.cellId)).toEqual(["data", "rates", "join", "show"]);
    expect(run.status).toBe("success");
    expect(result(run, "show").table?.rows).toEqual([{ region: "华东", revenue: 300 }, { region: "华南", revenue: 240 }]);
    expect(query.mock.calls[0][1].map((table) => table.name)).toEqual(["rates", "sales"]);
    expect(result(run, "join").resultRef).toMatchObject({ inputResultIds: [`${run.runId}:rates`, `${run.runId}:data`], sourceDatasetIds: [rates.id, source.id] });
    expect(log.mock.calls[0][0].inputResultIds).toEqual([`${run.runId}:rates`, `${run.runId}:data`]);
  }, 20_000);

  it("blocks failed descendants, still runs an independent branch, and never reuses prior tables", async () => {
    const { document, sources, source, rows } = fixture();
    const query = actualQuery(), log = vi.fn();
    const successful = await executeNotebook({ document, sources }, { query, log });
    expect(successful.status).toBe("success");
    const failedDocument: NotebookDocument = { ...document, revision: document.revision + 1,
      cells: document.cells.map((cell) => cell.id === "query" && cell.kind === "sql"
        ? { ...cell, sql: "SELECT missing_column FROM sales" } : cell),
    };
    failedDocument.cells.unshift(
      { id: "independent_table", kind: "table", title: "Independent result", inputCellId: "independent_query", columns: ["revenue"] },
      { id: "independent_query", kind: "sql", title: "Independent query", inputCellIds: ["independent_data"], outputName: "independent_total", sql: "SELECT SUM(amount) AS revenue FROM independent_sales" },
    );
    failedDocument.cells.push({ id: "independent_data", kind: "data", title: "Independent input", sourceDataSourceId: "independent_source", outputName: "independent_sales" });
    query.mockClear(); log.mockClear();
    const failed = await executeNotebook({ document: failedDocument, sources: [...sources, { source: { ...source, id: "independent_source" }, rows }] }, { query, log });
    expect(failed.status).toBe("failure");
    expect(result(failed, "query").status).toBe("failure");
    expect(result(failed, "query").error).toContain("missing_column");
    for (const id of ["recipe", "chart", "summary"]) {
      expect(result(failed, id).status).toBe("blocked");
      expect(result(failed, id).table).toBeUndefined();
      expect(result(failed, id).resultRef).toBeUndefined();
    }
    expect(result(failed, "independent_table").table?.rows).toEqual([{ revenue: 230 }]);
    expect(result(failed, "independent_table").resultRef?.sourceDatasetIds).toEqual(["independent_source"]);
    expect(query).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.map(([entry]) => [entry.cellId, entry.status])).toEqual([["query", "failure"], ["independent_query", "success"]]);
    expect(() => notebookDatasetProvenance(failedDocument, failed, "chart")).toThrow("不完整");
    expect(result(successful, "chart").table?.rows).toEqual([{ region: "华东", revenue: 300 }, { region: "华南", revenue: 160 }]);
    expect(failed.runId).not.toBe(successful.runId);
  }, 30_000);

  it("discards a late real SQL result after cancellation and starts the next run without stale evidence", async () => {
    const { document, sources } = fixture();
    const controller = new AbortController();
    const query = vi.fn<NotebookQueryExecutor>(async (sql, tables, signal, timeoutMs) => {
      const table = await executeNotebookSql(sql, tables, signal, timeoutMs);
      controller.abort();
      return table;
    });
    const log = vi.fn();
    const cancelled = await executeNotebook({ document, sources, signal: controller.signal }, { query, log });
    expect(cancelled.status).toBe("failure");
    expect(result(cancelled, "query")).toMatchObject({ status: "failure", error: "Notebook 运行已取消或超时" });
    expect(result(cancelled, "query").table).toBeUndefined();
    expect(result(cancelled, "query").resultRef).toBeUndefined();
    for (const id of ["recipe", "chart", "summary"]) {
      expect(result(cancelled, id).status).toBe("blocked");
      expect(result(cancelled, id).table).toBeUndefined();
      expect(result(cancelled, id).resultRef).toBeUndefined();
    }
    expect(query).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ cellId: "query", status: "failure" }));
    const retried = await executeNotebook({ document, sources }, { query: actualQuery(), log: vi.fn() });
    expect(retried.status).toBe("success");
    expect(result(retried, "summary").table?.rows).toEqual([{ revenue: 460 }]);
    expect(retried.runId).not.toBe(cancelled.runId);
    expect(result(retried, "chart").resultRef?.inputResultIds).toEqual([`${retried.runId}:recipe`]);
  }, 30_000);

  it("runs the actual draft tool on shuffled cells while preserving display order and AI evidence", async () => {
    const { document, sources, source, rows, product } = fixture();
    const request: HarnessRequest = { idempotencyKey: "dependency_execution_draft", instruction: "Create a Notebook with SQL, a recipe and chart", pageId: "page_home", role: "editor",
      appSpec: product.appSpec, recipes: [], notebookContext: { document: { ...document, cells: [] }, sourceIds: [source.id] },
    };
    const query = actualQuery(), log = vi.fn();
    let executed: NotebookRun | undefined;
    const output = await executeHarnessTool("createNotebookDraft", { name: document.name, cells: document.cells }, {
      request, dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, now: Date.now, id: () => "explicit_dependency_tool",
      notebookRunner: async (artifact) => {
        executed = await executeNotebook({ document: { ...document, cells: artifact.cells }, sources, forAi: true }, { query, log });
        return executed;
      },
    });
    expect(executed?.status).toBe("success");
    expect(output.notebookArtifact?.cells).toEqual(document.cells);
    expect(output.notebookArtifact?.executionOrder).toEqual(["data", "query", "recipe", "chart", "summary"]);
    expect(output.notebookArtifact?.executionEvidence).toMatchObject({ status: "success", completedCellIds: ["data", "query", "recipe", "chart", "summary"] });
    expect(output.notebookArtifact?.lineage).toEqual([
      { cellId: "chart", dependsOn: ["recipe"] }, { cellId: "summary", dependsOn: ["recipe"] },
      { cellId: "recipe", dependsOn: ["query"] }, { cellId: "query", dependsOn: ["data"] },
      { cellId: "data", dependsOn: [] },
    ]);
    expect(executed && result(executed, "summary").table?.rows).toEqual([{ revenue: 460 }]);
    expect(executed && result(executed, "summary").resultRef?.accessMode).toBe("ai");
    expect(query).toHaveBeenCalledTimes(2);
  }, 20_000);
});

const invalidDocuments: Array<{ name: string; document: NotebookDocument; targetCellId?: string }> = [
  { name: "self dependency", document: { name: "Self", revision: 0, cells: [
    { id: "query", kind: "sql", title: "Self", inputCellIds: ["query"], outputName: "self_rows", sql: "SELECT 1 AS value" },
  ] } },
  { name: "two-cell cycle", document: { name: "Cycle", revision: 0, cells: [
    { id: "first", kind: "sql", title: "First", inputCellIds: ["second"], outputName: "first_rows", sql: "SELECT * FROM second_rows" },
    { id: "second", kind: "sql", title: "Second", inputCellIds: ["first"], outputName: "second_rows", sql: "SELECT * FROM first_rows" },
  ] } },
  { name: "missing input", document: { name: "Missing", revision: 0, cells: [
    { id: "query", kind: "sql", title: "Missing", inputCellIds: ["absent"], outputName: "rows", sql: "SELECT 1 AS value" },
  ] } },
  { name: "non-table narrative input", document: { name: "Text", revision: 0, cells: [
    { id: "query", kind: "sql", title: "Query", inputCellIds: ["note"], outputName: "rows", sql: "SELECT 1 AS value" },
    { id: "note", kind: "text", title: "Narrative", markdown: "No table output" },
  ] } },
  { name: "cycle outside a selected independent target", targetCellId: "note", document: { name: "Full validation", revision: 0, cells: [
    { id: "first", kind: "sql", title: "First", inputCellIds: ["second"], outputName: "first_rows", sql: "SELECT 1 AS value" },
    { id: "second", kind: "sql", title: "Second", inputCellIds: ["first"], outputName: "second_rows", sql: "SELECT 1 AS value" },
    { id: "note", kind: "text", title: "Independent target", markdown: "Still validate the document" },
  ] } },
];

describe("Notebook invalid explicit dependencies reject before effects", () => {
  it.each(invalidDocuments)("rejects $name before calling any execution port", async ({ document, targetCellId }) => {
    vi.useFakeTimers();
    const query = vi.fn<NotebookQueryExecutor>(), python = vi.fn(), log = vi.fn(), connectionQuery = vi.fn();
    const input: NotebookRunInput = { document, sources: [], targetCellId, connectionQuery };
    await expect(executeNotebook(input, { query, python, log })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(python).not.toHaveBeenCalled();
    expect(connectionQuery).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
