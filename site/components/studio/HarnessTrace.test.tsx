import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HarnessTrace, traceRows } from "./HarnessTrace";
import { createHarnessTask } from "@/core/harness/task-state";
import type { HarnessTraceEvent } from "@/core/harness/contracts";
import { harnessNotebookDiagnosticsSchema } from "@/core/harness/notebook-diagnostics";

const task = createHarnessTask("trace_ui_test", "检查销售数据", "page_home", "editor", { now: () => new Date("2026-09-09T00:00:00.000Z"), id: () => "event_ui" });
const event = (sequence: number, type: HarnessTraceEvent["type"], extra: Partial<HarnessTraceEvent> = {}): HarnessTraceEvent => ({
  id: `trace_ui_${sequence}`, sequence, taskId: task.id, timestamp: task.createdAt, type, message: type, ...extra,
});
const diagnosticSource = JSON.stringify({ code: "<script>alert(1)</script>" }, null, 2);
const diagnostics = harnessNotebookDiagnosticsSchema.parse({
  version: 1 as const, baseRevision: 3, editVersion: 1, runId: "run_readonly", status: "failure" as const,
  cells: [{ cellId: "cell_python", kind: "python" as const, title: "失败代码", status: "failure" as const,
    source: diagnosticSource, sourceChars: diagnosticSource.length, sourceTruncated: false,
    timing: { preparationMs: 1234, executionMs: 10000, failurePhase: "execution" as const, termination: "timeout" as const } }],
  omittedCellCount: 0,
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
  it("renders final failed Notebook diagnostics as escaped read-only text without adopting controls", () => {
    const html = renderToStaticMarkup(<HarnessTrace task={{ ...task, state: "failed", trace: [event(1, "tool_completed")], notebookDiagnostics: diagnostics }} />);
    expect(html).toContain("查看失败草稿（只读）");
    expect(html).toContain("失败代码");
    expect(html).toContain("单元定义 · JSON");
    expect(html).toContain("仅保留在当前会话，刷新后丢失");
    expect(html).toContain("环境准备");
    expect(html).toContain("执行超时");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('open=""');
  });
  it("supports a final diagnostic without inventing trace events and explains unavailable receipts", () => {
    const html = renderToStaticMarkup(<HarnessTrace task={{ ...task, state: "blocked", notebookDiagnostics: harnessNotebookDiagnosticsSchema.parse({
      ...diagnostics, status: "unavailable", runId: undefined, cells: [{ ...diagnostics.cells[0], status: "unknown", timing: undefined,
        source: "{", sourceChars: 34000, sourceTruncated: true }], omittedCellCount: 2,
    }) }} />);
    expect(html).toContain("查看失败草稿（只读）");
    expect(html).toContain("未取得执行回执");
    expect(html).toContain("34000");
    expect(html).toContain("另有 2 个单元");
    expect(html).not.toContain("Notebook 单元耗时");
    expect(html).not.toContain("0 ms");
    expect(html).not.toContain("✓");
  });
  it.each(["completed", "cancelled", "awaitingConfirmation"] as const)("never presents stale failure diagnostics for %s", (state) => {
    const html = renderToStaticMarkup(<HarnessTrace task={{ ...task, state, trace: [event(1, "context_loaded")], notebookDiagnostics: diagnostics }} />);
    expect(html).not.toContain("查看失败草稿（只读）");
  });
  it("does not show a failure draft while a new request is running", () => {
    const html = renderToStaticMarkup(<HarnessTrace task={{ ...task, state: "failed", trace: [event(1, "context_loaded")], notebookDiagnostics: diagnostics }} running />);
    expect(html).not.toContain("查看失败草稿（只读）");
  });
});
