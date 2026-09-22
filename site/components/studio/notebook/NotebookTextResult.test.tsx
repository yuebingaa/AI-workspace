import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookCellRun } from "@/core/notebook/contracts";
import { NotebookTextResult } from "./NotebookTextResult";

const parameter: NotebookCell = { id: "parameter", kind: "parameter", title: "合成参数", outputName: "renamed_parameter", parameter: { type: "text", value: "not-yet-run-value" } };
const note: Extract<NotebookCell, { kind: "text" }> = { id: "note", kind: "text", title: "说明", markdown: "报告：{{amount}}", references: [{ key: "amount", cellId: "parameter", field: "value" }] };
const success: NotebookCellRun = { cellId: "note", status: "success", durationMs: 1, text: "报告：5" };
function render(result?: NotebookCellRun, stale = false, running = false, cell = note) {
  return renderToStaticMarkup(<NotebookTextResult cell={cell} cells={[cell, parameter]} result={result} stale={stale} running={running} />);
}

describe("Notebook text receipt presentation", () => {
  it("preserves static text including template-like syntax without needing execution", () => {
    const html = render(undefined, false, false, { id: "static", kind: "text", title: "静态", markdown: "{{amount}} **不解析** <script>" });
    expect(html).toBe('<p class="notebook-text">{{amount}} **不解析** &lt;script&gt;</p>');
  });
  it("shows the successful server receipt as escaped literal text rather than interpolating local parameters", () => {
    const html = render({ ...success, text: '<script>alert(1)</script> **plain** [link](https://invalid.example)' });
    expect(html).toContain('aria-label="说明计算结果"');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("**plain**");
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<a ");
    expect(html).not.toContain("not-yet-run-value");
  });
  it("retains an empty successful receipt instead of falling back to the template", () => {
    const html = render({ ...success, text: "" });
    expect(html).toContain('aria-label="说明计算结果"></p>');
    expect(html).toContain("本次说明结果为空文本");
  });
  it.each([
    { result: undefined, stale: false, running: false, expected: "引用结果待运行" },
    { result: success, stale: true, running: false, expected: "引用结果已失效" },
    { result: success, stale: false, running: true, expected: "正在计算引用说明" },
    { result: { ...success, status: "failure" as const }, stale: false, running: false, expected: "引用说明计算失败" },
    { result: { ...success, status: "blocked" as const }, stale: false, running: false, expected: "上游步骤失败" },
    { result: { cellId: "note", status: "success" as const, durationMs: 1 }, stale: false, running: false, expected: "未取得说明文本结果" },
    { result: { ...success, cellId: "other" }, stale: false, running: false, expected: "未取得说明文本结果" },
  ])("does not expose old or absent text as a current result: $expected", ({ result, stale, running, expected }) => {
    const html = render(result, stale, running);
    expect(html).toContain(expected);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('aria-label="说明计算结果"');
    expect(html).not.toContain("报告：5");
    expect(html).not.toContain("not-yet-run-value");
  });
  it("makes the stored template and ID-bound reference visible separately from results", () => {
    const html = render(success);
    expect(html).toContain("<summary>查看说明模板和引用</summary>");
    expect(html).toContain('<pre aria-label="说明模板">报告：{{amount}}</pre>');
    expect(html).toContain("合成参数");
    expect(html).toContain("renamed_parameter.value");
    expect(html).toContain("按单元 ID 关联");
    expect(html).not.toContain("<details open");
  });
  it("labels a removed source without looking up some other output with a similar name", () => {
    const html = render(undefined, false, false, { ...note, references: [{ key: "amount", cellId: "removed", field: "value" }] });
    expect(html).toContain("单元不可用");
    expect(html).toContain("removed.value");
    expect(html).not.toContain("not-yet-run-value");
  });
});
