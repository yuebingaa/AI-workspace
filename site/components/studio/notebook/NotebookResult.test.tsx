import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookTable } from "@/core/notebook/contracts";
import type { NotebookResultAvailability } from "@/core/notebook/result-availability";
import { NotebookResult } from "./NotebookResult";

const cell: NotebookCell = { id: "display", kind: "table", title: "合成结果", inputCellId: "source", columns: ["value"] };
function table(count: number, truncated = false): NotebookTable {
  return { fields: [{ name: "value", label: "合成值", type: "number" }], rows: Array.from({ length: count }, (_, value) => ({ value })), truncated };
}
function availability(overrides: Partial<NotebookResultAvailability> = {}): NotebookResultAvailability {
  return { previewRowCount: 1_000, knownRowCount: 1_324, completeness: "complete", previewOnly: true,
    canSaveDataset: true, canSnapshot: false, ...overrides };
}
describe("Notebook result preview scope", () => {
  it.each(["incomplete", "inconsistent", "unknown"] as const)("keeps %s scope visible while the chart data table is collapsed", completeness => {
    const chart: NotebookCell = { id: "chart", kind: "chart", title: "受限图表", inputCellId: "source", chartType: "bar", categoryField: "value", valueFields: ["value"] };
    const html = renderToStaticMarkup(<NotebookResult cell={chart} table={table(2, true)} availability={availability({ previewRowCount: 2, knownRowCount: null, completeness, canSaveDataset: false })} />);
    const controls = html.match(/<div class="notebook-result-view"[\s\S]*?<\/div>/u)?.[0] ?? "";
    expect(controls).toContain("当前预览 2 行");
    expect(controls).toContain(completeness === "incomplete" ? "结果不完整" : completeness === "inconsistent" ? "结果元数据不一致" : "完整性未知");
    expect(controls).not.toContain("完整结果");
    expect(html).toContain('<div hidden="" class="notebook-result"><div class="notebook-table-toolbar">');
  });
  it("offers accessible sorting and explicitly preview-only export without a query action", () => {
    const html = renderToStaticMarkup(<NotebookResult cell={cell} table={table(45)} />);
    expect(html).toContain('aria-label="按合成值排序"');
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain("搜索与排序仅作用于已返回的预览，不会重新查询或改变下游计算。");
    expect(html).toContain("原始顺序");
    expect(html).toContain('aria-label="当前预览导出"');
    expect(html).toContain("导出当前预览 CSV");
    expect(html).toContain("仅导出当前已返回预览 45 行");
    expect(html).toContain("不重新查询，不影响图表或下游计算");
    expect(html).not.toMatch(/>导出全部|>下载完整|>重新查询/);
  });
  it("renders missing properties consistently with explicit NULL without exposing undefined", () => {
    const input = table(1);
    input.rows = [{}];
    const html = renderToStaticMarkup(<NotebookResult cell={cell} table={input} />);
    expect(html).toContain('<span class="notebook-null">NULL</span>');
    expect(html).not.toContain(">undefined<");
  });
  it("distinguishes a complete result from local preview pages without rendering all preview rows", () => {
    const html = renderToStaticMarkup(<NotebookResult cell={cell} table={table(1000, true)} availability={availability()} />);
    expect(html).toContain("完整结果 1324 行 · 当前预览 1000 行");
    expect(html).toContain('aria-label="结果范围"');
    expect(html).toContain("预览 1 / 50");
    expect(html.match(/<tr>/gu)).toHaveLength(21);
    expect(html).toContain("仅导出当前已返回预览 1000 行");
    expect(html).not.toContain("导出当前已返回预览 1324 行");
    expect(html).toContain("不是全量下载");
    expect(html).not.toContain("结果不完整");
  });
  it("shows real truncation without calling the returned count a full result", () => {
    const html = renderToStaticMarkup(<NotebookResult cell={cell} table={table(1000, true)}
      availability={availability({ completeness: "incomplete", canSaveDataset: false })} />);
    expect(html).toContain("结果不完整 · 当前预览 1000 行");
    expect(html).not.toContain("完整结果 1324");
  });
  it("renders inconsistent metadata as unknown completeness rather than a fabricated total", () => {
    const html = renderToStaticMarkup(<NotebookResult cell={cell} table={table(1000, true)}
      availability={availability({ completeness: "inconsistent", knownRowCount: null, canSaveDataset: false })} />);
    expect(html).toContain("结果元数据不一致 · 当前预览 1000 行");
    expect(html).not.toContain("1324");
  });
  it("keeps legacy truncated tables conservative and untruncated empty results clear", () => {
    const legacy = renderToStaticMarkup(<NotebookResult cell={cell} table={table(25, true)} />);
    expect(legacy).toContain("完整性未知 · 当前预览 25 行");
    const empty = renderToStaticMarkup(<NotebookResult cell={cell} table={table(0)} />);
    expect(empty).toContain("完整结果 0 行");
    expect(empty).toContain("查询成功，结果为空");
    expect(empty).not.toContain("下一页结果");
  });
});
