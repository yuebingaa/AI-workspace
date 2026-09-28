import { describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { NotebookRun } from "@/core/notebook/contracts";
import type { NotebookArtifact, NotebookCell } from "@/core/notebook/definition";
import type { NotebookDraftRunner } from "@/core/notebook/execution-contracts";
import { cellsToRun } from "@/core/notebook/graph";
import { executeHarnessTool, type HarnessToolContext } from "./tool-registry";
import { NotebookDiagnosticSession } from "./notebook-diagnostics";

const mismatch = "执行回执与本次草稿不一致，不能作为验证证据。";
function receipt(artifact: NotebookArtifact): NotebookRun {
  const runId = "synthetic_receipt";
  const revision = artifact.baseRevision ?? 0;
  return { runId, revision, startedAt: "2026-09-16T00:00:00.000Z", status: "success", dataSignature: "synthetic", notice: "synthetic",
    cells: cellsToRun({ name: artifact.name, revision, cells: artifact.cells }).map((cell) => ({
      cellId: cell.id, status: "success", durationMs: 1,
      ...(cell.kind === "sql" ? {
        table: { fields: [{ name: "amount", label: "合成金额", type: "number" as const }], rows: [{ amount: 1 }], truncated: false },
        resultRef: { resultId: `${runId}:${cell.id}`, runId, revision, cellId: cell.id, accessMode: "ai" as const,
          mode: "table" as const, inputResultIds: [], rowCount: 1, complete: true, dataSignature: "synthetic" },
      } : {}),
    })) };
}
function fixture() {
  const { product, source, rows } = semanticFixture();
  const note: NotebookCell = { id: "note", kind: "text", title: "说明", markdown: "合成回执测试" };
  const data: NotebookCell = { id: "data", kind: "data", title: "合成数据", sourceDataSourceId: source.id, outputName: "inputs" };
  const sql: NotebookCell = { id: "sql", kind: "sql", title: "合成查询", inputCellIds: ["data"], outputName: "totals", sql: "SELECT * FROM inputs" };
  const context: HarnessToolContext = { request: { idempotencyKey: "receipt_contract_test", instruction: "创建并运行 Notebook 单元", role: "editor",
    pageId: "page_home", appSpec: product.appSpec, recipes: [], dataSourceId: source.id,
    notebookContext: { sourceIds: [source.id], document: { name: "合成回执", revision: 7, cells: [note, data] } } },
    dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, now: Date.now, id: () => "receipt_test",
    notebookCellSession: { document: { name: "合成回执", revision: 7, cells: [note, data] }, editVersion: 0 },
    notebookDiagnostics: new NotebookDiagnosticSession(), notebookRunner: async (artifact) => receipt(artifact) };
  return { context, sql, draft: { name: "合成草稿", cells: [sql, note, data] } };
}
const faults = ["empty", "duplicate", "order", "unknown", "revision", "falseSuccess", "falseFailure", "schema",
  "refRun", "refCell", "refRevision", "refAccess", "rowCount", "truncation"] as const;
type Fault = typeof faults[number];
function corrupt(run: NotebookRun, fault: Fault): NotebookRun {
  const sql = run.cells.find((cell) => cell.cellId === "sql")!;
  if (fault === "empty") run.cells = [];
  if (fault === "duplicate") run.cells[1] = run.cells[0];
  if (fault === "order") run.cells.reverse();
  if (fault === "unknown") run.cells[0].cellId = "other";
  if (fault === "revision") run.revision++;
  if (fault === "falseSuccess") sql.status = "failure";
  if (fault === "falseFailure") run.status = "failure";
  if (fault === "schema") sql.durationMs = -1;
  if (fault === "refRun") sql.resultRef!.runId = "other_run";
  if (fault === "refCell") sql.resultRef!.cellId = "other";
  if (fault === "refRevision") sql.resultRef!.revision++;
  if (fault === "refAccess") sql.resultRef!.accessMode = "user";
  if (fault === "rowCount") sql.resultRef!.rowCount = 0;
  if (fault === "truncation") sql.table!.truncated = true;
  return run;
}

describe("Harness Notebook receipt consumers", () => {
  it.each(["full", "incremental"] as const)("%s runners receive isolated execution data without conversation or tool state", async (path) => {
    const { context, draft, sql } = fixture();
    const { model, source } = semanticFixture();
    const controller = new AbortController();
    context.signal = controller.signal;
    context.request.semanticModel = model;
    context.request.instruction = "CONVERSATION_ONLY_SYNTHETIC_MARKER";
    context.request.appSpec.dataSources.push({ ...structuredClone(source), id: "unselected_source" });
    context.dataRuntime.rowsByDataSourceId.unselected_source = [{ private: "OUTSIDE_DRAFT_SYNTHETIC_MARKER" }];
    const original = structuredClone({ request: context.request, runtime: context.dataRuntime });
    // This implementation depends only on the domain contract, not HarnessToolContext.
    const runner = vi.fn<NotebookDraftRunner>(async (artifact, input) => {
      expect(input).toMatchObject({ revision: 7, taskId: "harness_receipt_contract_test", semanticModels: [model] });
      expect(input.signal).toBe(controller.signal);
      expect(input.sources).toEqual([{ source, rows: original.runtime.rowsByDataSourceId[source.id] }]);
      expect(input).not.toHaveProperty("request");
      expect(input).not.toHaveProperty("notebookCellSession");
      expect(JSON.stringify(input)).not.toContain("SYNTHETIC_MARKER");
      input.sources[0].source.name = "Adapter-local rename";
      input.sources[0].rows[0].amount = -999;
      input.semanticModels[0].name = "Adapter-local semantic model";
      return receipt(artifact);
    });
    context.notebookRunner = runner;
    if (path === "incremental") await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [sql] }, context);
    for (let attempt = 0; attempt < 2; attempt++) {
      await executeHarnessTool(path === "full" ? "createNotebookDraft" : "runNotebookCells",
        path === "full" ? draft : { editVersion: 1 }, context);
      expect({ request: context.request, runtime: context.dataRuntime }).toEqual(original);
    }
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it.each(faults)("full drafts reject %s receipts before publishing execution evidence", async (fault) => {
    const { context, draft } = fixture();
    const before = structuredClone(context.request);
    context.notebookRunner = async (artifact) => corrupt(receipt(artifact), fault);
    await expect(executeHarnessTool("createNotebookDraft", draft, context)).rejects.toThrow(mismatch);
    expect(context.notebookDiagnostics!.snapshot(() => {})).toMatchObject({ status: "unavailable" });
    expect(context.request).toEqual(before);
  });

  it.each(["full", "incremental"] as const)("%s runner mutations cannot replace reviewed definitions or revision", async (path) => {
    const { context, draft, sql } = fixture();
    context.notebookRunner = async (artifact) => {
      const run = receipt(artifact);
      artifact.baseRevision = 88;
      artifact.cells[0].title = "内部运行器改写";
      artifact.cells.reverse();
      artifact.executionOrder.reverse();
      return run;
    };
    if (path === "incremental") {
      await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [sql], afterCellId: null }, context);
      await executeHarnessTool("runNotebookCells", { editVersion: 1 }, context);
    }
    const result = await executeHarnessTool(path === "full" ? "createNotebookDraft" : "submitNotebookDraft",
      path === "full" ? draft : { editVersion: 1 }, context);
    expect(result.notebookArtifact).toMatchObject({ baseRevision: 7, cells: draft.cells,
      executionOrder: ["note", "data", "sql"], executionEvidence: { status: "success", completedCellIds: ["note", "data", "sql"] } });
  });

  it("captures revision before awaiting a runner that changes its input and receipt together", async () => {
    const { context, sql } = fixture();
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [sql] }, context);
    context.notebookRunner = async (artifact) => { artifact.baseRevision = 88; return receipt(artifact); };
    await expect(executeHarnessTool("runNotebookCells", { editVersion: 1 }, context)).rejects.toThrow(mismatch);
    expect(context.notebookCellSession!.run).toBeUndefined();
  });

  it.each(["refRun", "refCell", "refRevision", "refAccess", "rowCount", "truncation", "falseFailure"] as const)(
    "incremental runs reject %s before caching or submitting", async (fault) => {
      const { context, sql } = fixture();
      await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [sql] }, context);
      context.notebookRunner = async (artifact) => corrupt(receipt(artifact), fault);
      await expect(executeHarnessTool("runNotebookCells", { editVersion: 1 }, context)).rejects.toThrow(mismatch);
      expect(context.notebookCellSession!.run).toBeUndefined();
      expect(context.notebookCellSession!.runVersion).toBeUndefined();
      await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 1 }, context)).rejects.toThrow("尚未完整试运行通过");
    });

  it.each(["empty", "order", "revision", "falseSuccess", "refAccess", "rowCount"] as const)(
    "submission rechecks cached %s mutations against the current document", async (fault) => {
      const { context, sql } = fixture();
      await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [sql] }, context);
      await executeHarnessTool("runNotebookCells", { editVersion: 1 }, context);
      corrupt(context.notebookCellSession!.run!, fault);
      await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 1 }, context)).rejects.toThrow(mismatch);
    });

  it("retains genuine failed trial errors and bounded read-only diagnostics", async () => {
    const { context, draft } = fixture();
    context.notebookRunner = async (artifact) => {
      const run = receipt(artifact); run.status = "failure";
      run.cells[2] = { cellId: "sql", status: "failure", durationMs: 1, error: "synthetic SQL failure" };
      return run;
    };
    await expect(executeHarnessTool("createNotebookDraft", draft, context)).rejects.toThrow("Notebook 试运行失败");
    expect(context.notebookDiagnostics!.snapshot(() => {})).toMatchObject({ status: "failure", baseRevision: 7,
      runId: "synthetic_receipt", cells: [{ cellId: "sql", status: "failure" }, { cellId: "note", status: "success" }, { cellId: "data", status: "success" }] });
  });

  it("keeps optional no-run declarative drafts and legacy no-reference receipts compatible", async () => {
    const { context, draft } = fixture();
    const simple = { ...draft, cells: draft.cells.filter((cell) => cell.kind !== "sql") };
    const unrun = await executeHarnessTool("createNotebookDraft", simple, { ...context, notebookRunner: undefined });
    expect(unrun.notebookArtifact!.executionEvidence).toBeUndefined();
    context.notebookRunner = async (artifact) => ({ ...receipt(artifact), cells: receipt(artifact).cells.map(({ cellId }) => ({ cellId, status: "success", durationMs: 1 })) });
    const legacy = await executeHarnessTool("createNotebookDraft", draft, context);
    expect(legacy.notebookArtifact!.executionEvidence?.status).toBe("success");
  });

  it("does not confuse an installed runner returning nothing with an optional absent runner", async () => {
    const { context, draft } = fixture();
    context.notebookRunner = vi.fn<NonNullable<HarnessToolContext["notebookRunner"]>>();
    await expect(executeHarnessTool("createNotebookDraft", { ...draft, cells: draft.cells.filter((cell) => cell.kind !== "sql") }, context))
      .rejects.toThrow(mismatch);
  });

  it("checks cancellation before inspecting a late malformed complete-draft receipt", async () => {
    const { context, draft } = fixture(); const controller = new AbortController();
    context.signal = controller.signal;
    context.notebookRunner = async (artifact) => { controller.abort(); return corrupt(receipt(artifact), "empty"); };
    await expect(executeHarnessTool("createNotebookDraft", draft, context)).rejects.toMatchObject({ name: "AbortError" });
  });

  it.each(["cancel", "edit"] as const)("keeps incremental %s invalidation ahead of malformed late receipt checks", async (change) => {
    const { context, sql } = fixture(); const controller = new AbortController();
    context.signal = controller.signal;
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [sql] }, context);
    context.notebookRunner = async (artifact) => {
      if (change === "cancel") controller.abort();
      else context.notebookCellSession!.editVersion++;
      return corrupt(receipt(artifact), "empty");
    };
    const pending = executeHarnessTool("runNotebookCells", { editVersion: 1 }, context);
    if (change === "cancel") await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    else await expect(pending).rejects.toThrow("草稿版本已变化");
    expect(context.notebookCellSession!.run).toBeUndefined();
    expect(context.notebookCellSession!.runVersion).toBeUndefined();
  });
});
