import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { NotebookTable } from "@/core/notebook/contracts";
import type { NotebookResultAvailability } from "@/core/notebook/result-availability";
import { NotebookResultTable } from "./NotebookResultTable";

function table(count = 45, truncated = false): NotebookTable {
  return { fields: [{ name: "value", label: "合成值", type: "number" }], rows: Array.from({ length: count }, (_, value) => ({ value })), truncated };
}
function availability(count: number, overrides: Partial<NotebookResultAvailability> = {}): NotebookResultAvailability {
  return { previewRowCount: count, knownRowCount: count, completeness: "complete", previewOnly: false, canSaveDataset: count > 0, canSnapshot: count > 0, ...overrides };
}
function render(input = table(), scope = availability(input.rows.length)) {
  return renderToStaticMarkup(<NotebookResultTable title="合成结果" table={input} availability={scope} />);
}

describe("Notebook preview CSV affordance", () => {
  it("exports the whole returned preview rather than just a 20-row page", () => {
    const html = render();
    expect(html).toContain('aria-label="当前预览导出"');
    expect(html).toContain("仅导出当前已返回预览 45 行");
    expect(html).toContain("不只是本页 20 行");
    expect(html).toContain("预览 1 / 3");
    expect(html.match(/<tr>/gu)).toHaveLength(21);
    expect(html).toMatch(/<button type="button" title="[^"]*45[^"]*"[^>]*>导出当前预览 CSV/);
    expect(html).not.toContain("已发起当前预览 CSV 下载");
  });
  it("keeps the complete count distinct and never claims a 1324-row download from a 1000-row preview", () => {
    const html = render(table(1000, true), availability(1000, { knownRowCount: 1324, previewOnly: true }));
    expect(html).toContain("完整结果 1324 行 · 当前预览 1000 行");
    expect(html).toContain("仅导出当前已返回预览 1000 行");
    expect(html).not.toContain("仅导出当前已返回预览 1324 行");
    expect(html).not.toMatch(/disabled=""[^>]*>导出当前预览 CSV/);
  });
  it.each(["unknown", "incomplete"] as const)("allows local preview export without pretending the %s result is complete", (completeness) => {
    const html = render(table(45, true), availability(45, { completeness, knownRowCount: null, canSaveDataset: false, canSnapshot: false }));
    expect(html).toContain(completeness === "unknown" ? "完整性未知" : "结果不完整");
    expect(html).toContain("仅导出当前已返回预览 45 行");
    expect(html).not.toMatch(/disabled=""[^>]*>导出当前预览 CSV/);
    expect(html).not.toContain("完整结果 45 行");
  });
  it("disables export for inconsistent result identity rather than silently downloading a potentially unrelated table", () => {
    const html = render(table(45), availability(45, { completeness: "inconsistent", knownRowCount: null }));
    expect(html).toMatch(/disabled=""[^>]*>导出当前预览 CSV/);
    expect(html).toContain("结果元数据不一致，暂不能导出");
    expect(html).not.toContain("已发起");
  });
  it.each([0, 20, 46, Number.NaN])("disables export when preview metadata says %s rows but the table contains 45", (previewRowCount) => {
    const html = render(table(45), availability(45, { previewRowCount }));
    expect(html).toMatch(/disabled=""[^>]*>导出当前预览 CSV/);
    expect(html).toContain("预览行数与结果元数据不一致");
    expect(html).toContain("仅导出当前已返回预览 45 行");
  });
  it("allows a successful empty preview to export only its header", () => {
    const html = render(table(0), availability(0));
    expect(html).toContain("仅导出当前已返回预览 0 行（仅表头）");
    expect(html).toContain("查询成功，结果为空");
    expect(html).not.toMatch(/disabled=""[^>]*>导出当前预览 CSV/);
    expect(html).not.toContain("下一页结果");
  });
  it("keeps CSV limits and fidelity/security caveats in collapsed accessible details", () => {
    const html = render();
    expect(html).toContain("<details><summary>导出说明</summary>");
    expect(html).toContain("表头使用字段名，不保留列类型");
    expect(html).toContain("NULL 与空文本都会导出为空单元格");
    expect(html).toContain("单引号前缀");
    expect(html).toContain("不保证所有表格软件绝对安全");
    expect(html).toContain("文件上限 4 MiB");
    expect(html).not.toContain("<details open");
  });
  it("does not mutate table rows, fields or availability while rendering the new controls", () => {
    const input = table(45); const scope = availability(45);
    const before = structuredClone({ input, scope });
    render(input, scope);
    expect({ input, scope }).toEqual(before);
  });
});
