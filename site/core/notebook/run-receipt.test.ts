import { describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { notebookRunSchema, type NotebookDocument, type NotebookRun, type NotebookTable } from "./contracts";
import { cellDependencies, cellsToRun } from "./graph";
import { captureNotebookRunExpectation, parseNotebookRunReceipt } from "./run-receipt";
import { executeNotebook } from "./server/execution";

const message = "执行回执与本次草稿不一致，不能作为验证证据。";
const table: NotebookTable = { fields: [{ name: "value", label: "值", type: "number" }], rows: [{ value: 1 }], truncated: false };
function document(): NotebookDocument {
  return { name: "Receipt fixture", revision: 4, cells: [
    { id: "chart", title: "Chart first", kind: "chart", inputCellId: "sql", chartType: "bar", categoryField: "value", valueFields: ["value"] },
    { id: "sql", title: "SQL", kind: "sql", inputCellIds: ["data"], outputName: "total", sql: "SELECT 1 AS value FROM sales LIMIT 1" },
    { id: "data", title: "Data last", kind: "data", sourceDataSourceId: "semantic_sales", outputName: "sales" },
    { id: "note", title: "Independent note", kind: "text", markdown: "Synthetic narrative" },
  ] };
}
function receipt(): NotebookRun {
  const doc = document(), runId = "synthetic_run";
  return { runId, revision: doc.revision, startedAt: "2026-09-16T00:00:00.000Z", status: "success",
    dataSignature: "opaque_signature", notice: "Synthetic receipt", cells: cellsToRun(doc).map((cell) => ({
      cellId: cell.id, status: "success", durationMs: 0,
      ...(cell.kind === "text" ? {} : { table: structuredClone(table), resultRef: {
        resultId: `${runId}:${cell.id}`, runId, cellId: cell.id, revision: doc.revision, mode: "table", accessMode: "ai",
        inputResultIds: cellDependencies(cell).map((id) => `${runId}:${id}`), rowCount: 1, complete: true, dataSignature: "opaque_signature",
      } as const }),
    })) };
}

describe("Notebook run receipt consistency, not identity authorization", () => {
  it("captures a copied dependency order rather than display order, with an optional target closure", () => {
    const doc = document();
    const expected = captureNotebookRunExpectation(doc, "ai");
    const target = captureNotebookRunExpectation(doc, "user", "sql");
    expect(expected).toEqual({ revision: 4, accessMode: "ai", cellIds: ["data", "sql", "chart", "note"] });
    expect(target).toEqual({ revision: 4, accessMode: "user", cellIds: ["data", "sql"] });
    doc.revision = 99; doc.cells[0].id = "runner_mutated"; doc.cells.reverse(); doc.cells.length = 0;
    expect(expected.cellIds).toEqual(["data", "sql", "chart", "note"]);
    expect(expected.revision).toBe(4);
    expect(Object.isFrozen(expected)).toBe(true); expect(Object.isFrozen(expected.cellIds)).toBe(true);
    expect(parseNotebookRunReceipt(receipt(), expected).revision).toBe(4);
  });
  it("returns schema-normalized data without mutating the supplied receipt", () => {
    const raw = receipt(), before = structuredClone(raw);
    const parsed = parseNotebookRunReceipt(raw, captureNotebookRunExpectation(document(), "ai"));
    expect(parsed).toEqual(raw); expect(parsed).not.toBe(raw); expect(raw).toEqual(before);
  });
  it.each([
    ["wrong revision", (run: NotebookRun) => { run.revision++; }],
    ["display order instead of execution order", (run: NotebookRun) => { run.cells.reverse(); }],
    ["missing cell", (run: NotebookRun) => { run.cells.pop(); }],
    ["extra cell", (run: NotebookRun) => { run.cells.push({ cellId: "extra", status: "success", durationMs: 0 }); }],
    ["duplicate cell", (run: NotebookRun) => { run.cells[1].cellId = run.cells[0].cellId; }],
    ["success despite failed cell", (run: NotebookRun) => { run.cells[1].status = "failure"; }],
    ["success despite blocked cell", (run: NotebookRun) => { run.cells[1].status = "blocked"; }],
    ["failure despite every cell succeeding", (run: NotebookRun) => { run.status = "failure"; }],
    ["reference from another run", (run: NotebookRun) => { run.cells[0].resultRef!.runId = "other"; }],
    ["reference from another cell", (run: NotebookRun) => { run.cells[0].resultRef!.cellId = "other"; }],
    ["reference from another revision", (run: NotebookRun) => { run.cells[0].resultRef!.revision++; }],
    ["manual reference in AI execution", (run: NotebookRun) => { run.cells[0].resultRef!.accessMode = "user"; }],
    ["reference count smaller than preview", (run: NotebookRun) => { run.cells[0].resultRef!.rowCount = 0; }],
    ["larger result without preview truncation", (run: NotebookRun) => { run.cells[0].resultRef!.rowCount = 2; }],
    ["incomplete result without truncation", (run: NotebookRun) => { run.cells[0].resultRef!.complete = false; }],
    ["complete equal-count result marked truncated", (run: NotebookRun) => { run.cells[0].table!.truncated = true; }],
  ] as const)("rejects %s with the fixed non-sensitive error", (_name, mutate) => {
    const raw = receipt(); mutate(raw);
    expect(notebookRunSchema.safeParse(raw).success, "Shape validation alone accepts this inconsistent receipt").toBe(true);
    expect(() => parseNotebookRunReceipt(raw, captureNotebookRunExpectation(document(), "ai"))).toThrow(new Error(message));
  });
  it("does not leak invalid input values or Zod issues", () => {
    const raw = { ...receipt(), runId: { syntheticSecret: "never-echo-this-value" }, unexpected: "private" };
    expect(() => parseNotebookRunReceipt(raw, captureNotebookRunExpectation(document(), "ai"))).toThrow(new Error(message));
  });
  it("accepts larger complete results behind bounded previews and genuine incomplete successful results", () => {
    const raw = receipt();
    raw.cells[0].resultRef!.rowCount = 1324; raw.cells[0].table!.truncated = true;
    raw.cells[1].resultRef!.complete = false; raw.cells[1].table!.truncated = true;
    const parsed = parseNotebookRunReceipt(raw, captureNotebookRunExpectation(document(), "ai"));
    expect(parsed.status).toBe("success");
    expect(parsed.cells[0].resultRef).toMatchObject({ complete: true, rowCount: 1324 });
    expect(parsed.cells[1].resultRef?.complete).toBe(false);
  });
  it("preserves legacy receipts with no refs and refs with no table, including narrative success", () => {
    const raw = receipt();
    delete raw.cells[0].resultRef; delete raw.cells[1].table;
    delete raw.cells[2].table; delete raw.cells[2].resultRef;
    expect(parseNotebookRunReceipt(raw, captureNotebookRunExpectation(document(), "ai"))).toEqual(raw);
  });
  it("still checks reference identity when the legacy receipt has no table", () => {
    const raw = receipt(); delete raw.cells[1].table; raw.cells[1].resultRef!.accessMode = "user";
    expect(() => parseNotebookRunReceipt(raw, captureNotebookRunExpectation(document(), "ai"))).toThrow(new Error(message));
  });
  it("keeps failure/blocked diagnostics and successful independent cells without claiming all failed", () => {
    const raw = receipt(); raw.status = "failure";
    raw.cells[1] = { cellId: "sql", status: "failure", durationMs: 5, queryId: "query_synthetic", error: "Synthetic error",
      stdout: "Synthetic diagnostic", stderr: "Synthetic stderr", timing: { preparationMs: 1, executionMs: 3, failurePhase: "execution", termination: "error" } };
    raw.cells[2] = { cellId: "chart", status: "blocked", durationMs: 0, error: "Synthetic blocked reason" };
    expect(parseNotebookRunReceipt(raw, captureNotebookRunExpectation(document(), "ai"))).toEqual(raw);
  });
  it("keeps the existing empty-run and empty-ID schema compatibility without introducing ID format policy", () => {
    const doc = { name: "Empty", revision: 0, cells: [] };
    const raw = { ...receipt(), runId: "", revision: 0, cells: [], dataSignature: "" };
    expect(parseNotebookRunReceipt(raw, captureNotebookRunExpectation(doc, "user"))).toEqual(raw);
  });
  it.each([false, true])("accepts the actual executor with bounded source/result previews for AI=%s", async (forAi) => {
    const { source } = semanticFixture();
    const rows = Array.from({ length: 1324 }, (_, index) => ({ region: `Region ${index}`, amount: 1 }));
    const doc: NotebookDocument = { name: "Large complete result", revision: 3, cells: [
      { id: "target", title: "Recipe first", kind: "transform", inputCellId: "data", outputName: "all_rows", steps: [{ id: "all", type: "limit", count: 2000 }] },
      { id: "data", title: "Data last", kind: "data", sourceDataSourceId: source.id, outputName: "sales" },
    ] };
    const expected = captureNotebookRunExpectation(doc, forAi ? "ai" : "user", "target");
    const run = await executeNotebook({ document: doc, sources: [{ source, rows }], forAi, targetCellId: "target" }, { query: vi.fn(), log: vi.fn() });
    expect(parseNotebookRunReceipt(run, expected)).toEqual(run);
    expect(run.cells.map((cell) => cell.table?.rows.length)).toEqual([100, 1000]);
    expect(run.cells.map((cell) => cell.resultRef?.rowCount)).toEqual([1324, 1324]);
  });
  it.each(["truncated", "failure"] as const)("accepts actual executor %s semantics with an independent narrative cell", async (scenario) => {
    const { source, rows } = semanticFixture(), doc = document();
    const expected = captureNotebookRunExpectation(doc, "ai");
    const query = scenario === "failure" ? vi.fn().mockRejectedValue(new Error("Synthetic failure"))
      : vi.fn().mockResolvedValue({ ...table, truncated: true });
    const run = await executeNotebook({ document: doc, sources: [{ source, rows }], forAi: true }, { query, log: vi.fn() });
    expect(parseNotebookRunReceipt(run, expected)).toEqual(run);
    expect(run.cells.map((cell) => cell.status)).toEqual(scenario === "failure"
      ? ["success", "failure", "blocked", "success"] : ["success", "success", "success", "success"]);
  });
});
