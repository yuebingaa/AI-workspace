import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessTrace, traceRows } from "./HarnessTrace";
import { createHarnessTask } from "@/core/harness/task-state";
import type { HarnessTraceEvent } from "@/core/harness/contracts";

const task = createHarnessTask("trace_ui_test", "检查销售数据", "page_home", "editor", { now: () => new Date("2026-09-09T00:00:00.000Z"), id: () => "event_ui" });
const event = (sequence: number, type: HarnessTraceEvent["type"], extra: Partial<HarnessTraceEvent> = {}): HarnessTraceEvent => ({
  id: `trace_ui_${sequence}`, sequence, taskId: task.id, timestamp: task.createdAt, type, message: type, ...extra,
});
describe("real execution trace UI", () => {
  it("shows only actual steps and keeps awaiting confirmation distinct from completion", () => {
    const trace = [event(1, "context_loaded", { message: "已加载当前页面上下文" }), event(2, "verification_started")];
    const running = renderToStaticMarkup(<HarnessTrace task={{ ...task, trace }} running />);
    expect(running).toContain('open=""');
    expect(running).toContain("2 个步骤");
    expect(running).not.toContain("4 个步骤");
    const waiting = renderToStaticMarkup(<HarnessTrace task={{ ...task, trace, state: "awaitingConfirmation" }} />);
    expect(waiting).not.toContain('open=""');
    expect(waiting).toContain("预览已生成 · 等待确认");
    expect(waiting).toContain("正式页面尚未修改");
    expect(waiting).toContain("未收到完成回执");
  });
  it("collapses completed and failed runs, preserves failed tool evidence and retry receipts", () => {
    const tool = { id: "call_1", name: "inspectDataset" as const, status: "running" as const, durationMs: 0 };
    const trace = [event(1, "tool_started", { toolCall: tool }),
      event(2, "tool_failed", { toolCall: { ...tool, status: "failure", durationMs: 35 } }),
      event(3, "tool_started", { toolCall: { ...tool, id: "call_2" } }),
      event(4, "tool_completed", { toolCall: { ...tool, id: "call_2", status: "success", durationMs: 42 } })];
    expect(traceRows(trace).map((row) => row.type)).toEqual(["tool_failed", "tool_completed"]);
    const failed = renderToStaticMarkup(<HarnessTrace task={{ ...task, state: "failed", error: "证据不足", trace }} />);
    expect(failed).not.toContain('open=""');
    expect(failed).toContain("分析未完成");
    expect(failed).toContain("证据不足");
    const completed = renderToStaticMarkup(<HarnessTrace task={{ ...task, state: "completed", trace }} />);
    expect(completed).not.toContain('open=""');
    expect(completed).toContain("已完成分析");
  });
  it("does not invent a successful trace for a legacy task or local greeting", () => {
    expect(renderToStaticMarkup(<HarnessTrace task={task} />)).toBe("");
  });
});
