import { expect, it } from "vitest";
import { harnessTaskSummarySchema, type HarnessTraceEvent } from "@/core/harness/contracts";
import { dshWebProgress } from "./progress";

it("projects actual tool/cell status, replaces running with receipts and never includes raw data", () => {
  const task = harnessTaskSummarySchema.parse({ id: "task", idempotencyKey: "synthetic_task", instruction: "合成分析", pageId: "home", role: "editor",
    state: "executingTool", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), events: [], counters: { loopCount: 0, modelCallCount: 0, toolCallCount: 1 } });
  const event = (sequence: number, details: Partial<HarnessTraceEvent>): HarnessTraceEvent => ({ id: `task:${sequence}`, taskId: "task", sequence,
    timestamp: task.createdAt, type: "status_update", message: "合成状态", ...details });
  task.trace = [event(1, { type: "tool_started", toolCall: { id: "tool1", name: "runNotebookCells", status: "running", durationMs: 0 } }),
    event(2, { notebookCellId: "sql", notebookRunId: "run1", notebookStatus: "running" }),
    event(3, { notebookCellId: "sql", notebookRunId: "run1", notebookStatus: "failure", message: "查询失败" }),
    event(4, { type: "tool_completed", toolCall: { id: "tool1", name: "runNotebookCells", status: "success", durationMs: 5 } }),
    event(5, { type: "answer_delta", message: "not a process receipt" })];
  expect(dshWebProgress(task)?.steps).toHaveLength(2);
  expect(dshWebProgress(task)?.steps[0]).toMatchObject({ state: "done", message: "试运行分析步骤 · 完成" });
  expect(dshWebProgress(task)?.steps[1]).toMatchObject({ state: "failure", cellId: "sql" });
  task.trace.push(event(6, { notebookStatus: "running", notebookCellId: "table", notebookRunId: "run1" })); task.state = "cancelled";
  expect(dshWebProgress(task)?.steps.at(-1)?.state).toBe("stopped");
  expect(dshWebProgress(null)).toBeUndefined();
  task.trace = Array.from({ length: 90 }, (_, i) => event(i + 1, {})); expect(dshWebProgress(task)?.steps).toHaveLength(80);
});
