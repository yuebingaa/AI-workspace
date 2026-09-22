import { describe, expect, it } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { NotebookRun } from "@/core/notebook/contracts";
import type { HarnessModel, HarnessRequest, HarnessToolName } from "./contracts";
import { HarnessRuntime } from "./runtime";
import { NotebookDiagnosticSession, harnessNotebookDiagnosticsSchema, MAX_NOTEBOOK_DIAGNOSTIC_SOURCE_CHARS } from "./notebook-diagnostics";
import { createHarnessNotebookArtifact } from "./notebook";
import { executeHarnessTool, type HarnessToolContext } from "./tool-registry";

function fixture() {
  const { product, source, rows } = semanticFixture();
  const request: HarnessRequest = { idempotencyKey: "notebook_diagnostics_test", instruction: "添加 Python 单元并运行", role: "editor",
    pageId: "page_home", appSpec: product.appSpec, recipes: [], dataSourceId: source.id,
    notebookContext: { sourceIds: [source.id], document: { name: "合成诊断", revision: 3, cells: [
      { id: "data", kind: "data", title: "合成输入", sourceDataSourceId: source.id, outputName: "inputs" },
    ] } } };
  const cell = { id: "py", kind: "python" as const, title: "合成失败", inputCellIds: ["data"], fileNames: [],
    code: "raise ValueError('synthetic code')", outputName: "result" };
  const calls: Array<[HarnessToolName, Record<string, unknown>]> = [["cellSearch", {}],
    ["createPythonCell", { editVersion: 0, cell }], ["runNotebookCells", { editVersion: 1 }]];
  const modelContexts: unknown[] = [];
  const model: HarnessModel = { next: async (input) => {
    modelContexts.push(input.context);
    // A fourth proposal is rejected by the existing three-tool budget, not a fixture exception.
    const [name, args] = calls[input.iteration - 1] ?? ["runNotebookCells", { editVersion: 1 }];
    return { model: "offline-diagnostics", usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
      turn: { type: "callTool", name, arguments: args, toolCallId: `diagnostic_${input.iteration}`, message: "运行合成单元" } };
  } };
  const run: NotebookRun = { runId: "synthetic_run", revision: 3, startedAt: "2026-09-16T00:00:00.000Z", status: "failure", dataSignature: "synthetic", notice: "synthetic",
    cells: [{ cellId: "data", status: "success", durationMs: 0 }, { cellId: "py", status: "failure", durationMs: 8,
      error: "PRIVATE_ERROR_ROW", stdout: "PRIVATE_STDOUT", stderr: "PRIVATE_STDERR",
      timing: { preparationMs: 5, executionMs: 3, failurePhase: "execution", termination: "error" } }] };
  const options = { dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, modelClient: model,
    notebookRunner: async () => run, bounds: { maxToolCalls: 3 }, allowFailureExplanation: false };
  return { request, options, run, modelContexts, source, cell };
}

describe("transient failed Notebook diagnostics", () => {
  it.each(["rowCount", "truncation"] as const)("keeps %s-inconsistent result metadata unavailable without inventing timing", (fault) => {
    const { request, cell, run } = fixture();
    const artifact = createHarnessNotebookArtifact({ name: "合成诊断", cells: [...request.notebookContext!.document.cells, cell] },
      { request, allowedDataSourceIds: request.notebookContext!.sourceIds, now: Date.now, id: () => "metadata" });
    artifact.baseRevision = 3;
    run.cells[0].table = { fields: [{ name: "value", label: "合成值", type: "number" }], rows: [{ value: 1 }], truncated: fault === "truncation" };
    run.cells[0].resultRef = { resultId: "synthetic_data", runId: run.runId, revision: 3, cellId: "data", mode: "table",
      inputResultIds: [], rowCount: fault === "rowCount" ? 0 : 1, complete: true, accessMode: "ai", dataSignature: "synthetic" };
    const diagnostics = new NotebookDiagnosticSession();
    expect(() => diagnostics.recordRun(diagnostics.begin(artifact), run)).not.toThrow();
    expect(diagnostics.snapshot(() => {})).toMatchObject({ status: "unavailable", cells: [
      { cellId: "data", status: "unknown" }, { cellId: "py", status: "unknown" },
    ] });
    expect(diagnostics.snapshot(() => {})?.runId).toBeUndefined();
    expect(diagnostics.snapshot(() => {})?.cells.every((entry) => entry.timing === undefined)).toBe(true);
  });

  it("accepts dependency-ordered receipts independently of displayed cells and untrusted executionOrder", () => {
    const { request, cell, run } = fixture();
    const artifact = createHarnessNotebookArtifact({ name: "显示次序不同", cells: [...request.notebookContext!.document.cells, cell] },
      { request, allowedDataSourceIds: request.notebookContext!.sourceIds, now: Date.now, id: () => "reordered" });
    artifact.baseRevision = 3;
    artifact.cells.reverse();
    artifact.executionOrder = artifact.cells.map((item) => item.id); // Metadata is not trusted execution proof.
    const diagnostics = new NotebookDiagnosticSession();
    diagnostics.recordRun(diagnostics.begin(artifact), run);
    expect(diagnostics.snapshot(() => {})).toMatchObject({ status: "failure", runId: run.runId, cells: [
      { cellId: "py", status: "failure", timing: { preparationMs: 5, executionMs: 3 } },
      { cellId: "data", status: "success" },
    ] });
  });

  it("matches timing and source by cell ID while retaining failure priority and displayed tie order", () => {
    const { request, cell, run } = fixture();
    const other = { ...cell, id: "other", title: "另一失败", outputName: "other_result", code: "raise RuntimeError('other synthetic')" };
    const artifact = createHarnessNotebookArtifact({ name: "分支诊断", cells: [...request.notebookContext!.document.cells, cell, other,
      { id: "visual", kind: "chart", title: "受阻图", inputCellId: "other", chartType: "bar", categoryField: "name", valueFields: ["value"] }] },
    { request, allowedDataSourceIds: request.notebookContext!.sourceIds, now: Date.now, id: () => "branch" });
    artifact.baseRevision = 3;
    artifact.cells.reverse(); // visual, other, py, data; execution is data, other, visual, py.
    const otherTiming = { preparationMs: 7, executionMs: 0, failurePhase: "preparation" as const, termination: "error" as const };
    const diagnostics = new NotebookDiagnosticSession();
    diagnostics.recordRun(diagnostics.begin(artifact), { ...run, cells: [run.cells[0],
      { cellId: "other", status: "failure", durationMs: 7, timing: otherTiming },
      { cellId: "visual", status: "blocked", durationMs: 0 }, run.cells[1]] });
    const result = diagnostics.snapshot(() => {})!;
    expect(result.status).toBe("failure");
    expect(result.cells.map((item) => [item.cellId, item.status])).toEqual([
      ["other", "failure"], ["py", "failure"], ["visual", "blocked"], ["data", "success"],
    ]);
    expect(result.cells[0].timing).toEqual(otherTiming);
    expect(result.cells[1].timing).toEqual(run.cells[1].timing);
    expect(result.cells[2].timing).toBeUndefined();
    for (const item of result.cells) expect(JSON.parse(item.source).id).toBe(item.cellId);
  });

  it.each(["duplicate", "missing", "misordered", "unknown", "revision", "status"] as const)(
    "rejects %s receipts after display reordering instead of attaching misleading diagnostics", (fault) => {
      const { request, cell, run } = fixture();
      const artifact = createHarnessNotebookArtifact({ name: "拒绝错配", cells: [...request.notebookContext!.document.cells, cell] },
        { request, allowedDataSourceIds: request.notebookContext!.sourceIds, now: Date.now, id: () => "invalid_run" });
      artifact.baseRevision = 3;
      artifact.cells.reverse();
      artifact.executionOrder = artifact.cells.map((item) => item.id);
      const invalid = structuredClone(run);
      if (fault === "duplicate") invalid.cells = [invalid.cells[1], invalid.cells[1]];
      if (fault === "missing") invalid.cells.pop();
      if (fault === "misordered") invalid.cells.reverse();
      if (fault === "unknown") invalid.cells[0].cellId = "unknown";
      if (fault === "revision") invalid.revision++;
      if (fault === "status") invalid.status = "success";
      const diagnostics = new NotebookDiagnosticSession();
      diagnostics.recordRun(diagnostics.begin(artifact), invalid);
      const result = diagnostics.snapshot(() => {})!;
      expect(result.status).toBe("unavailable");
      expect(result.runId).toBeUndefined();
      expect(result.cells.every((item) => item.status === "unknown" && !item.timing)).toBe(true);
    });

  it("returns read-only source and matching timing only in the failed final receipt", async () => {
    const { request, options, modelContexts } = fixture();
    const before = structuredClone(request);
    const task = await new HarnessRuntime().run(request, options);
    expect(task.state).toBe("failed");
    expect(task.counters.toolCallCount).toBe(3);
    expect(task.notebookDiagnostics).toMatchObject({ version: 1, baseRevision: 3, editVersion: 1,
      runId: "synthetic_run", status: "failure", omittedCellCount: 0,
      cells: [{ cellId: "py", status: "failure", sourceTruncated: false, timing: { preparationMs: 5, executionMs: 3 } },
        { cellId: "data", status: "success" }] });
    expect(task.notebookDiagnostics?.cells[0].source).toContain("synthetic code");
    expect(JSON.stringify(task.notebookDiagnostics)).not.toMatch(/PRIVATE_ERROR_ROW|PRIVATE_STDOUT|PRIVATE_STDERR|"table"/u);
    expect(JSON.stringify([task.trace, task.evidence, task.workingMemory, modelContexts])).not.toContain("notebookDiagnostics");
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.pendingChangeSet).toBeUndefined();
    expect(request).toEqual(before);
  });

  it("does not invent timing when the runner fails without returning a receipt", async () => {
    const { request, options } = fixture();
    const task = await new HarnessRuntime().run(request, { ...options,
      notebookRunner: async () => { throw new Error("synthetic outer timeout"); } });
    expect(task.notebookDiagnostics).toMatchObject({ status: "unavailable", baseRevision: 3 });
    expect(task.notebookDiagnostics?.runId).toBeUndefined();
    expect(task.notebookDiagnostics?.cells.every((cell) => cell.status === "unknown" && !cell.timing)).toBe(true);
  });

  it.each(["cancel", "authorization", "dataset"] as const)("does not return source after %s is withdrawn", async (kind) => {
    const { request, options, run, source } = fixture();
    const abort = new AbortController();
    let revoked = false;
    const task = await new HarnessRuntime().run(request, { ...options, signal: abort.signal,
      authorizeModelCall: () => { if (revoked && kind === "authorization") throw new Error("Access changed"); },
      notebookRunner: async () => {
        revoked = true;
        if (kind === "cancel") abort.abort();
        if (kind === "dataset") delete options.dataRuntime.rowsByDataSourceId[source.id];
        return run;
      } });
    expect(task.notebookDiagnostics).toBeUndefined();
  });

  it("does not carry successful trial code into an unrelated later task failure", async () => {
    const { request, options, run } = fixture();
    const task = await new HarnessRuntime().run(request, { ...options, notebookRunner: async () => ({ ...run,
      status: "success", cells: run.cells.map((cell) => ({ cellId: cell.cellId, status: "success", durationMs: 1 })) }) });
    expect(task.state).toBe("failed");
    expect(task.notebookDiagnostics).toBeUndefined();
  });

  it("remembers an authorization rejection even if a later recheck could succeed", async () => {
    const { request, options, run } = fixture();
    let rejectNext = false;
    let rejected = 0;
    const task = await new HarnessRuntime().run(request, { ...options, bounds: { maxToolCalls: 4 },
      notebookRunner: async () => { rejectNext = true; return run; },
      authorizeModelCall: () => { if (rejectNext) { rejectNext = false; rejected++; throw new Error("synthetic revoked permission"); } },
    });
    expect(task.state).toBe("failed");
    expect(rejected).toBe(1);
    expect(task.notebookDiagnostics).toBeUndefined();
  });

  it("keeps the full-draft failure separate from adoptable artifacts and rejects invalid drafts", async () => {
    const { request, options, cell } = fixture();
    const diagnostics = new NotebookDiagnosticSession();
    const context: HarnessToolContext = { request, ...options, now: Date.now, id: () => "diagnostic_id", notebookDiagnostics: diagnostics };
    const cells = [...request.notebookContext!.document.cells, cell];
    await expect(executeHarnessTool("createNotebookDraft", { name: "合成失败草稿", cells }, context)).rejects.toThrow("试运行失败");
    expect(diagnostics.snapshot(() => {})).toMatchObject({ status: "failure", baseRevision: 3, runId: "synthetic_run" });
    const empty = new NotebookDiagnosticSession();
    await expect(executeHarnessTool("createNotebookDraft", { name: "非法草稿", cells: [{ ...cell, inputCellIds: ["unavailable"] }] },
      { ...context, notebookDiagnostics: empty })).rejects.toThrow();
    expect(empty.snapshot(() => {})).toBeUndefined();
  });

  it("bounds code before disclosure, prioritizes failures, and reports truncation without leaking receipt data", () => {
    const { request, options, cell, run } = fixture();
    const artifact = createHarnessNotebookArtifact({ name: "长草稿", cells: [...request.notebookContext!.document.cells,
      { ...cell, code: "界🙂".repeat(6000) }] }, { request, allowedDataSourceIds: request.notebookContext!.sourceIds,
      now: Date.now, id: () => "bounded" });
    artifact.baseRevision = 3;
    const diagnostics = new NotebookDiagnosticSession();
    diagnostics.recordRun(diagnostics.begin(artifact, 2), run);
    const result = diagnostics.snapshot(() => { expect(options.dataRuntime).toBeDefined(); })!;
    expect(result.cells[0]).toMatchObject({ cellId: "py", status: "failure", sourceTruncated: false });
    // Multiple individually valid cells exceed the aggregate diagnostic budget.
    const many = createHarnessNotebookArtifact({ name: artifact.name, cells: [...artifact.cells,
      { ...cell, id: "py_second", outputName: "result_second", code: "x".repeat(20_000) }] },
    { request, allowedDataSourceIds: request.notebookContext!.sourceIds, now: Date.now, id: () => "many" });
    many.baseRevision = 3;
    const generation = diagnostics.begin(many, 3);
    diagnostics.recordRun(generation, { ...run, cells: [...run.cells, { cellId: "py_second", status: "failure", durationMs: 1 }] });
    const bounded = diagnostics.snapshot(() => {})!;
    expect(bounded.cells[0].cellId).toBe("py");
    expect(bounded.cells[1]).toMatchObject({ cellId: "py_second", sourceTruncated: true });
    expect(bounded.cells.reduce((sum, value) => sum + value.source.length, 0)).toBeLessThanOrEqual(MAX_NOTEBOOK_DIAGNOSTIC_SOURCE_CHARS);
    expect(bounded.omittedCellCount).toBe(1);
    expect(bounded.cells[1].sourceChars).toBeGreaterThan(bounded.cells[1].source.length);
    expect(harnessNotebookDiagnosticsSchema.safeParse({ ...bounded, cells: bounded.cells.map((value) => ({ ...value, sourceTruncated: false })) }).success).toBe(false);
    expect(harnessNotebookDiagnosticsSchema.safeParse({ ...bounded, rows: [] }).success).toBe(false);
    expect(harnessNotebookDiagnosticsSchema.safeParse({ ...bounded, cells: [bounded.cells[0], bounded.cells[0]] }).success).toBe(false);
    expect(harnessNotebookDiagnosticsSchema.safeParse({ ...bounded, status: "unavailable" }).success).toBe(false);
    expect(JSON.stringify(bounded)).not.toMatch(/PRIVATE_ERROR_ROW|PRIVATE_STDOUT|PRIVATE_STDERR/u);
    expect(diagnostics.snapshot(() => { throw new Error("Access revoked"); })).toBeUndefined();
  });

  it("invalidates stale receipts on editing or rerunning and ignores mismatched provenance", () => {
    const { request, cell, run } = fixture();
    const artifact = createHarnessNotebookArtifact({ name: "合成草稿", cells: [...request.notebookContext!.document.cells, cell] },
      { request, allowedDataSourceIds: request.notebookContext!.sourceIds, now: Date.now, id: () => "versions" });
    artifact.baseRevision = 3;
    const diagnostics = new NotebookDiagnosticSession();
    const old = diagnostics.begin(artifact, 1);
    diagnostics.recordRun(old, run);
    const next = diagnostics.begin(artifact, 2);
    diagnostics.recordRun(old, run);
    expect(diagnostics.snapshot(() => {})).toMatchObject({ status: "unavailable", editVersion: 2 });
    diagnostics.recordRun(next, { ...run, revision: 4 });
    expect(diagnostics.snapshot(() => {})?.runId).toBeUndefined();
    diagnostics.recordRun(next, { ...run, cells: [...run.cells].reverse() });
    expect(diagnostics.snapshot(() => {})?.runId).toBeUndefined();
    diagnostics.recordRun(next, run);
    expect(diagnostics.snapshot(() => {})).toMatchObject({ status: "failure", editVersion: 2, runId: run.runId });
    diagnostics.begin(artifact, 2); // Starting another run clears the old receipt even without another edit.
    expect(diagnostics.snapshot(() => {})?.runId).toBeUndefined();
    expect(new NotebookDiagnosticSession().snapshot(() => {})).toBeUndefined();
  });

  it("rejects matching-looking receipts from another access mode or run identity", () => {
    const { request, cell, run } = fixture();
    const artifact = createHarnessNotebookArtifact({ name: "合成草稿", cells: [...request.notebookContext!.document.cells, cell] },
      { request, allowedDataSourceIds: request.notebookContext!.sourceIds, now: Date.now, id: () => "identity" });
    artifact.baseRevision = 3;
    for (const override of [{ accessMode: "user" as const }, { runId: "other_run" }, { revision: 9 }, { cellId: "other_cell" }]) {
      const diagnostics = new NotebookDiagnosticSession();
      const resultRef = { resultId: "result_data", runId: run.runId, revision: 3, cellId: "data", mode: "table" as const,
        inputResultIds: [], rowCount: 1, complete: true, dataSignature: "synthetic", accessMode: "ai" as const, ...override };
      diagnostics.recordRun(diagnostics.begin(artifact), { ...run, cells: [{ ...run.cells[0], resultRef }, run.cells[1]] });
      expect(diagnostics.snapshot(() => {})).toMatchObject({ status: "unavailable" });
    }
  });
});
