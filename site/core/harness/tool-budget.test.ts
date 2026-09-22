import { afterEach, describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { executeNotebook } from "@/core/notebook/server/execution";
import type { HarnessModel, HarnessRequest, HarnessToolName } from "./contracts";
import { HarnessRuntime, type HarnessBounds } from "./runtime";
import { executeHarnessTool, type HarnessToolContext } from "./tool-registry";
import { harnessToolTimeoutMs, NOTEBOOK_TOOL_TIMEOUT_MS } from "./tool-budget";

afterEach(() => vi.useRealTimers());

function scenario(runMs: number, bounds?: Partial<HarnessBounds>, signal?: AbortSignal) {
  const { product, source, rows } = semanticFixture();
  const request: HarnessRequest = { idempotencyKey: "notebook_tool_budget", instruction: "修改 Python 单元并运行分析",
    role: "editor", pageId: "page_home", appSpec: product.appSpec, recipes: [], dataSourceId: source.id,
    notebookContext: { sourceIds: [source.id], document: { name: "合成时钟测试", revision: 0, cells: [] } } };
  const cell = { id: "python", kind: "python", title: "合成计算", inputCellIds: [], fileNames: [], outputName: "totals",
    code: "totals = pd.DataFrame({'total': [230]})" };
  const actions: Array<[HarnessToolName, Record<string, unknown>]> = [["cellSearch", {}],
    ["createPythonCell", { editVersion: 0, cell }], ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }]];
  const modelClient: HarnessModel = { next: async ({ iteration }) => {
    const action = actions[iteration - 1];
    return { model: "offline-budget-model", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, turn: action
      ? { type: "callTool", name: action[0], arguments: action[1], toolCallId: `budget_${iteration}`, message: "验证合成 Notebook" }
      : { type: "complete", message: "任务没有可用结果" } };
  } };
  let runnerSignal: AbortSignal | undefined;
  const notebookRunner: NonNullable<HarnessToolContext["notebookRunner"]> = async (artifact, context) => {
    runnerSignal = context.signal;
    await new Promise<void>((resolve) => setTimeout(resolve, runMs));
    return executeNotebook({ document: { name: artifact.name, revision: artifact.baseRevision!, cells: artifact.cells },
      sources: [{ source, rows }], signal: context.signal, forAi: true }, {
      query: async () => { throw new Error("Unexpected SQL"); }, log: () => {}, python: async () => ({ close: async () => {},
        execute: async () => ({ table: { fields: [{ name: "total", label: "total", type: "number" }], rows: [{ total: 230 }], truncated: false }, stdout: "", stderr: "" }) }),
    });
  };
  const calls: string[] = [];
  const task = new HarnessRuntime().run(request, { dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, modelClient,
    notebookRunner, bounds, signal, monotonicNow: () => Date.now(), allowFailureExplanation: false,
    toolExecutor: (name, args, context) => { calls.push(name); return executeHarnessTool(name, args, context); } });
  return { task, calls, get signal() { return runnerSignal; }, request };
}

describe("operation-scoped Harness tool budgets", () => {
  it("extends only Notebook trial runs and always honors an explicit tighter caller limit", () => {
    expect(NOTEBOOK_TOOL_TIMEOUT_MS).toBe(35_000);
    for (const name of ["runNotebookCells", "createNotebookDraft"] as const) {
      expect(harnessToolTimeoutMs(name)).toBe(35_000);
      expect(harnessToolTimeoutMs(name, 1000)).toBe(1000);
      expect(harnessToolTimeoutMs(name, 10_000)).toBe(10_000);
    }
    for (const name of ["inspectDataset", "cellSearch", "createPythonCell", "getKernelPackagesInfo", "submitNotebookDraft"] as const) {
      expect(harnessToolTimeoutMs(name)).toBe(10_000);
      expect(harnessToolTimeoutMs(name, 500)).toBe(500);
    }
  });

  it("keeps a 12-second Notebook run alive, forwards timing, and still requires adoption", async () => {
    vi.useFakeTimers();
    const run = scenario(12_000);
    const before = JSON.stringify(run.request);
    await vi.advanceTimersByTimeAsync(10_100);
    expect(run.signal?.aborted).toBe(false);
    expect(run.calls).toEqual(["cellSearch", "createPythonCell", "runNotebookCells"]);
    await vi.advanceTimersByTimeAsync(2000);
    const task = await run.task;
    expect(task.state, task.error).toBe("awaitingConfirmation");
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(task.events.find((event) => event.toolCall?.name === "runNotebookCells" && event.toolCall.status === "running")?.toolCall?.status).toBe("running");
    expect(task.trace?.find((event) => event.type === "tool_started" && event.toolCall?.name === "runNotebookCells")?.executionTiming?.toolCallTimeoutMs).toBe(35_000);
    expect(JSON.stringify(run.request)).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([{ bounds: { toolCallTimeoutMs: 1000 }, timeoutMs: 1000 },
    { bounds: { totalExecutionTimeoutMs: 1500 }, timeoutMs: 1500 }])("retains stricter explicit and total budgets: $timeoutMs ms", async ({ bounds, timeoutMs }) => {
    vi.useFakeTimers();
    const run = scenario(12_000, bounds);
    await vi.advanceTimersByTimeAsync(timeoutMs + 10);
    const task = await run.task;
    expect(run.signal?.aborted).toBe(true);
    expect(run.signal?.reason).toMatchObject({ name: "TimeoutError" });
    expect(task.state).not.toBe("awaitingConfirmation");
    expect(task.notebookArtifact).toBeUndefined();
    expect(run.calls).not.toContain("submitNotebookDraft");
    expect(task.events.some((event) => event.toolCall?.name === "runNotebookCells" && event.toolCall.status === "failure")).toBe(true);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(task.notebookArtifact).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps user cancellation immediate and discards the late Notebook receipt", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const run = scenario(12_000, undefined, controller.signal);
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1);
    const task = await run.task;
    expect(task.state).toBe("cancelled");
    expect(run.signal?.aborted).toBe(true);
    expect(run.signal?.reason).not.toMatchObject({ name: "TimeoutError" });
    expect(run.calls).not.toContain("submitNotebookDraft");
    await vi.advanceTimersByTimeAsync(12_000);
    expect(task.notebookArtifact).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still terminates an uncooperative Notebook runner at the bounded default deadline", async () => {
    vi.useFakeTimers();
    const run = scenario(40_000);
    await vi.advanceTimersByTimeAsync(NOTEBOOK_TOOL_TIMEOUT_MS + 1);
    const task = await run.task;
    expect(run.signal?.aborted).toBe(true);
    expect(run.signal?.reason).toMatchObject({ name: "TimeoutError", message: expect.stringContaining("35000") });
    expect(task.notebookArtifact).toBeUndefined();
    expect(run.calls).not.toContain("submitNotebookDraft");
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
