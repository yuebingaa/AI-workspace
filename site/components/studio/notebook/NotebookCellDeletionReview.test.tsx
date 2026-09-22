import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { prepareNotebookCellDeletion } from "@/core/notebook/cell-deletion";
import { NotebookCellDeletionReview } from "./NotebookCellDeletionReview";

const document: NotebookDocument = { name: "Deletion fixture", revision: 2, cells: [
  { id: "data_id", kind: "data", title: "原始数据步骤", sourceDataSourceId: "dataset", outputName: "raw_rows" },
  { id: "query_id", kind: "sql", title: "销售额汇总", inputCellIds: ["data_id"], outputName: "totals", sql: "SELECT SUM(amount) AS total FROM raw_rows -- private-code-marker" },
  { id: "table_id", kind: "table", title: "结果表格", inputCellId: "query_id", columns: ["total"] },
  { id: "text_id", kind: "text", title: "文字结论", markdown: "合计 {{total}}", references: [{ cellId: "query_id", key: "total", field: "total" }] },
  { id: "independent", kind: "text", title: "独立说明", markdown: "保留的正文" },
] };
function render(targetId = "data_id", options: { disabled?: boolean; stale?: boolean } = {}, source = document) {
  const review = prepareNotebookCellDeletion(source, targetId), onConfirm = vi.fn(), onKeep = vi.fn();
  const html = renderToStaticMarkup(<NotebookCellDeletionReview review={review} disabled={false} stale={false} onConfirm={onConfirm} onKeep={onKeep} {...options} />);
  expect(onConfirm).not.toHaveBeenCalled(); expect(onKeep).not.toHaveBeenCalled();
  return html;
}

describe("Notebook cell deletion impact review", () => {
  it("shows the complete removal list, stable identities and direct/transitive roles without code or data", () => {
    const html = render();
    expect(html).toContain('aria-label="确认删除分析步骤"'); expect(html).toContain('role="alert"');
    for (const value of ["原始数据步骤", "销售额汇总", "结果表格", "文字结论", "data_id", "query_id", "table_id", "text_id", "raw_rows", "totals", "当前单元", "直接下游", "间接下游", "保留 1 个其他步骤"]) expect(html).toContain(value);
    expect(html.match(/<li>/gu)).toHaveLength(4);
    expect(html).toContain("确认删除 4 个单元");
    for (const value of ["private-code-marker", "保留的正文", "independent", "disabled=", "一键恢复"]) expect(html).not.toContain(value);
  });
  it("shows only one removal for an independent leaf and keeps explicit confirmation", () => {
    const html = render("independent");
    expect(html.match(/<li>/gu)).toHaveLength(1); expect(html).toContain("确认删除 1 个单元");
    expect(html).toContain("保留 4 个其他步骤"); expect(html).toContain(">保留</button>");
  });
  it.each([{ disabled: true, stale: false }, { disabled: false, stale: true }, { disabled: true, stale: true }])("blocks confirmation but leaves a way to close the review: %j", (options) => {
    const html = render("query_id", options);
    expect(html).toMatch(/disabled=""[^>]*>确认删除 3 个单元/u);
    expect(html).toMatch(options.stale ? /<button type="button">关闭过期审阅<\/button>/u : /<button type="button">保留<\/button>/u);
    if (options.stale) expect(html).toContain("文档已变化，本次删除审阅已过期，未删除任何步骤");
  });
  it("distinguishes deletion of steps from retained external resources and explicit-reference scope", () => {
    const html = render();
    expect(html).toContain("原始文件、数据表、语义模型及已保存的看板 / 结果快照不会删除");
    expect(html).toContain("不分析自由 SQL / Python 代码");
    expect(html).toContain("步骤没有回收站"); expect(html).toContain("删除前的项目备份");
  });
  it("escapes user-controlled names and IDs", () => {
    const html = render("<script>id</script>", {}, { name: "Fixture", revision: 0, cells: [
      { id: "<script>id</script>", kind: "text", title: "<img src=x>", markdown: "<iframe>" },
    ] });
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<img"); expect(html).not.toContain("<iframe>");
    expect(html).toContain("&lt;script&gt;id&lt;/script&gt;"); expect(html).toContain("&lt;img src=x&gt;");
  });
});
