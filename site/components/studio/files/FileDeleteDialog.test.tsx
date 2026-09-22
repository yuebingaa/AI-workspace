import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { NotebookFileReference } from "@/core/notebook/file-references";
import { FileDeleteDialog } from "./FileDeleteDialog";

const reference: NotebookFileReference = { pageId: "page_one", notebookName: "原件分析", cellId: "python_one", cellTitle: "读取销售原件", downstreamCount: 3 };
function render(references: NotebookFileReference[], options: { recoverable?: boolean; disabled?: boolean; name?: string } = {}) {
  const onConfirm = vi.fn(async () => undefined), onClose = vi.fn();
  const html = renderToStaticMarkup(<FileDeleteDialog name="sales.csv" recoverable references={references}
    fallbackFocusRef={{ current: null }} onConfirm={onConfirm} onClose={onClose} {...options} />);
  expect(onConfirm).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  return html;
}

describe("original file deletion impact dialog", () => {
  it("shows explicit Python references and initially disables deletion until acknowledged", () => {
    const html = render([reference]);
    expect(html).toContain('role="alertdialog"'); expect(html).toContain('aria-describedby=');
    for (const text of ["1 个 Python 步骤引用此文件名", "原件分析", "读取销售原件", "page_one", "python_one", "下游 3 个步骤", "按文件名匹配，不绑定文件 ID", "已有显示结果不会自动重新计算", "恢复原件后需手动重新运行"]) expect(html).toContain(text);
    expect(html).toMatch(/type="checkbox"(?![^>]*checked)/u);
    expect(html).toMatch(/class="file-delete-confirm" disabled=""/u);
    expect(html).toMatch(/<button type="button">取消<\/button>/u);
  });
  it("does not claim no impact or require acknowledgement when no declared file references exist", () => {
    const html = render([]);
    expect(html).toContain("未发现该文件名的显式引用");
    expect(html).toContain("不检查自由代码或未采用草稿");
    expect(html).toContain("已导入的数据表和 Notebook 定义会保留");
    expect(html).not.toContain('type="checkbox"');
    expect(html).toMatch(/class="file-delete-confirm">删除<\/button>/u);
  });
  it("keeps the permission and interaction lock even without file references", () => {
    expect(render([], { disabled: true })).toMatch(/class="file-delete-confirm" disabled=""/u);
    const html = render([reference], { disabled: true });
    expect(html).toMatch(/type="checkbox" disabled=""/u);
    expect(html).toMatch(/class="file-delete-confirm" disabled=""/u);
  });
  it("caps only visible references while acknowledgement covers the complete count", () => {
    const html = render(Array.from({ length: 12 }, (_, index) => ({ ...reference, cellId: `python_${index}` })));
    expect(html.match(/<li>/gu)).toHaveLength(10);
    expect(html).toContain("12 个 Python 步骤引用此文件名");
    expect(html).toContain("另有 2 个引用未展开；确认范围包含全部 12 个引用");
    expect(html).toContain("每个步骤的下游数量单独计算，可能重叠");
    expect(html).not.toContain("python_10");
  });
  it("distinguishes temporary file removal from project recycle-bin restoration", () => {
    const html = render([reference], { recoverable: false });
    expect(html).toContain("将移除本次会话的原件");
    expect(html).toContain("重新导入原件后需手动重新运行");
    expect(html).not.toContain("回收站");
  });
  it("escapes user-provided filenames, notebook titles and cell identity", () => {
    const html = render([{ ...reference, notebookName: "<img src=x>", cellTitle: "<script>alert(1)</script>", cellId: "<b>id</b>" }], { name: "<svg onload=alert(1)>.csv" });
    for (const tag of ["<script", "<img", "<svg", "<b>"]) expect(html).not.toContain(tag);
    expect(html).toContain("&lt;script&gt;"); expect(html).toContain("&lt;svg onload=alert(1)&gt;.csv");
  });
});
