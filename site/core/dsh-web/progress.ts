import type { HarnessTaskSummary } from "@/core/harness/contracts";
import type { DshWebSnapshot } from "./protocol";

const toolLabels: Record<string, string> = { cellSearch: "查看 Notebook", editNotebookCells: "更新分析草稿",
  runNotebookCells: "试运行分析步骤", submitNotebookDraft: "提交待确认草稿", inspectEdsRawWorkbook: "检查工作表结构",
  readEdsRawRows: "读取工作表", inspectConnectionSchema: "检查数据库结构", getKernelPackagesInfo: "检查 Python 环境" };

/** Only actual trace receipts enter the official UI slot; no prompt/code/data or inferred reasoning. */
export function dshWebProgress(task: HarnessTaskSummary | null): DshWebSnapshot["progress"] {
  if (!task?.trace?.length) return undefined;
  const steps = new Map<string, NonNullable<DshWebSnapshot["progress"]>["steps"][number]>();
  for (const event of task.trace) {
    if (event.type === "answer_delta" || event.type === "completed") continue;
    const tool = event.toolCall;
    const state = event.notebookStatus === "failure" || event.notebookStatus === "blocked" || event.type === "tool_failed" ? "failure"
      : event.notebookStatus === "running" || event.notebookStatus === "queued" || tool?.status === "running" ? "running" : "done";
    const id = tool?.id ?? event.id;
    const key = event.notebookRunId ? `${event.notebookRunId}:${event.notebookCellId ?? "run"}` : id;
    steps.set(key, { id, message: (tool ? `${toolLabels[tool.name] ?? "执行工具"} · ${state === "failure" ? "失败" : state === "running" ? "进行中" : "完成"}` : event.message).slice(0, 600),
      state, ...(tool ? { detail: `${tool.name} · ${event.message}`.slice(0, 1000) } : {}),
      ...(event.notebookCellId ? { cellId: event.notebookCellId } : {}) });
  }
  const running = ["idle", "planning", "executingTool", "observing", "verifying", "replanning"].includes(task.state);
  return { taskId: task.id, steps: [...steps.values()].slice(-80).map(step => !running && step.state === "running"
    ? { ...step, state: "stopped" } : step) };
}
