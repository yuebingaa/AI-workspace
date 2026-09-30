import { describe, expect, it } from "vitest";
import { applyNotebookLiveProgress, type NotebookLiveState } from "./live-state";
import { notebookLiveProgressSchema, notebookProgressResult, type NotebookLiveProgress } from "./live-progress";
import type { NotebookCellRun, NotebookDocument } from "./contracts";

const baseline: NotebookDocument = { name: "合成分析", revision: 2, cells: [
  { id: "source", kind: "data", title: "合成来源", sourceDataSourceId: "synthetic", outputName: "sales" },
] };
const result: NotebookCellRun = { cellId: "source", status: "success", durationMs: 1,
  table: { fields: [{ name: "amount", label: "金额", type: "number" }], rows: [{ amount: 3 }], truncated: false },
  resultRef: { resultId: "r:source", runId: "r", cellId: "source", revision: 2, mode: "table", inputResultIds: [],
    rowCount: 1, complete: true, dataSignature: "synthetic", accessMode: "ai" } };
function reducer() {
  let state: NotebookLiveState | null = null, sequence = 0;
  return { get state() { return state; }, update(update: NotebookLiveProgress["update"], version = 1, overrides = {}) {
    state = applyNotebookLiveProgress(state, { scopeKey: "scope", taskId: "task", baseline, sequence: ++sequence,
      progress: { baseRevision: 2, editVersion: version, update }, ...overrides }); return state;
  } };
}
function running() {
  const flow = reducer(); flow.update({ kind: "draft", document: structuredClone(baseline), changedCellIds: ["source"], removedCellIds: [] });
  flow.update({ kind: "run_started", runId: "r", revision: 2, cellIds: ["source"] }); return flow;
}

describe("ephemeral live Notebook projection", () => {
  it("moves from queued to running to success without mutating the saved baseline", () => {
    const before = structuredClone(baseline), flow = running();
    expect(flow.state?.statuses.source).toBe("queued");
    flow.update({ kind: "cell_started", runId: "r", revision: 2, cellId: "source" });
    expect(flow.state?.statuses.source).toBe("running");
    flow.update({ kind: "cell_finished", runId: "r", revision: 2, result });
    expect(flow.state?.results.source.table?.rows).toEqual([{ amount: 3 }]);
    const complete = flow.state;
    flow.update({ kind: "cell_started", runId: "r", revision: 2, cellId: "source" });
    expect(flow.state).toBe(complete);
    expect(baseline).toEqual(before);
  });
  it("ignores duplicate, wrong revision/run/cell/access receipts and terminal late events", () => {
    const flow = running(), original = flow.state;
    for (const patch of [{ runId: "old" }, { revision: 1 }, { result: { ...result, cellId: "unknown" } },
      { result: { ...result, resultRef: { ...result.resultRef!, accessMode: "user" as const } } }]) {
      flow.update({ kind: "cell_finished", runId: "r", revision: 2, result, ...patch }); expect(flow.state).toBe(original);
    }
    flow.update({ kind: "cell_finished", runId: "r", revision: 2, result }, 1, { sequence: 1 }); expect(flow.state).toBe(original);
    flow.update({ kind: "run_finished", runId: "r", revision: 2, status: "failure" });
    const finished = flow.state;
    flow.update({ kind: "cell_finished", runId: "r", revision: 2, result }); expect(flow.state).toBe(finished);
    for (const phase of ["cancelled", "failed", "ready"] as const) {
      const stopped = { ...flow.state!, phase };
      expect(applyNotebookLiveProgress(stopped, { scopeKey: "scope", taskId: "task", sequence: 100, baseline,
        progress: { baseRevision: 2, editVersion: 1, update: { kind: "cell_finished", runId: "r", revision: 2, result } } })).toBe(stopped);
    }
  });
  it("invalidates results on a new edit, rejects old versions, and isolates a new task", () => {
    const flow = running(); flow.update({ kind: "cell_finished", runId: "r", revision: 2, result });
    const document = { ...baseline, name: "新的草稿" };
    flow.update({ kind: "draft", document, changedCellIds: ["source"], removedCellIds: [] }, 2);
    expect(flow.state).toMatchObject({ editVersion: 2, statuses: { source: "stale" }, results: {} });
    const edited = flow.state;
    flow.update({ kind: "cell_finished", runId: "r", revision: 2, result }); expect(flow.state).toBe(edited);
    flow.update({ kind: "draft", document, changedCellIds: [], removedCellIds: [] }, 0, { taskId: "next" });
    expect(flow.state).toMatchObject({ taskId: "next", editVersion: 0, statuses: { source: "pending" }, results: {} });
  });
  it("requires the full cell set at run start", () => {
    const flow = running(), previous = flow.state;
    for (const cellIds of [[], ["unknown"], ["source", "source"]]) {
      flow.update({ kind: "run_started", runId: "next", revision: 2, cellIds }); expect(flow.state).toBe(previous);
    }
  });
  it("bounds rows and text, strips logs, preserves result identity and input", () => {
    const full = { ...result, stdout: "private log", stderr: "private error", text: "x".repeat(3000),
      table: { ...result.table!, rows: Array.from({ length: 100 }, () => ({ amount: "x".repeat(1000) })) } };
    const preview = notebookProgressResult(full);
    expect(preview.stdout).toBeUndefined(); expect(preview.stderr).toBeUndefined(); expect(preview.text).toHaveLength(2000);
    expect(preview.table!.rows.length).toBeLessThan(50); expect(preview.table!.truncated).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify(preview.table!.rows)).byteLength).toBeLessThanOrEqual(16000);
    expect(preview.resultRef).toEqual(full.resultRef); expect(full.table.rows).toHaveLength(100);
    expect(notebookLiveProgressSchema.safeParse({ baseRevision: 2, editVersion: 1, update: { kind: "cell_finished", runId: "r", revision: 2, result: preview } }).success).toBe(true);
  });
});
