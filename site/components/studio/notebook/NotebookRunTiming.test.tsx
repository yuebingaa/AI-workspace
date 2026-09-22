import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NotebookRunTiming } from "./NotebookRunTiming";

describe("Notebook execution phase receipts", () => {
  it("does not invent a zero-duration run when timing is absent", () => {
    expect(renderToStaticMarkup(<NotebookRunTiming />)).toBe("");
  });
  it("shows preparation and execution separately without labeling them pure computation", () => {
    const html = renderToStaticMarkup(<NotebookRunTiming timing={{ preparationMs: 1234, executionMs: 85 }} />);
    expect(html).toContain('aria-label="Notebook 单元耗时"');
    expect(html).toContain("环境准备"); expect(html).toContain("1.23 s");
    expect(html).toContain("执行计算"); expect(html).toContain("85 ms");
    expect(html).toContain("并非纯计算耗时");
    expect(html).not.toContain("失败阶段");
  });
  it("retains a real zero-duration receipt", () => {
    expect(renderToStaticMarkup(<NotebookRunTiming timing={{ preparationMs: 0, executionMs: 0 }} />)).toContain("0 ms");
  });
  it("does not claim computation started after preparation failed", () => {
    const html = renderToStaticMarkup(<NotebookRunTiming timing={{ preparationMs: 2500, executionMs: 0, failurePhase: "preparation", termination: "error" }} />);
    expect(html).toContain("2.50 s");
    expect(html).toContain("未开始");
    expect(html).toContain("失败阶段：环境准备 · 执行失败");
    expect(html).not.toContain("0 ms");
  });
  it("distinguishes a computation timeout from cancellation", () => {
    const timedOut = renderToStaticMarkup(<NotebookRunTiming timing={{ preparationMs: 4, executionMs: 10000, failurePhase: "execution", termination: "timeout" }} />);
    expect(timedOut).toContain("失败阶段：执行计算 · 执行超时");
    expect(timedOut).toContain("10.00 s"); expect(timedOut).not.toContain("已取消");
    const cancelled = renderToStaticMarkup(<NotebookRunTiming timing={{ preparationMs: 4, executionMs: 30, failurePhase: "execution", termination: "cancelled" }} />);
    expect(cancelled).toContain("终止阶段：执行计算 · 已取消");
    expect(cancelled).not.toContain("执行超时"); expect(cancelled).not.toContain("失败阶段");
  });
  it("shows recorded termination without inferring a missing phase", () => {
    const html = renderToStaticMarkup(<NotebookRunTiming timing={{ preparationMs: 4, executionMs: 8, termination: "error" }} />);
    expect(html).toContain("执行失败");
    expect(html).not.toContain("失败阶段");
  });
});
