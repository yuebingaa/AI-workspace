import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectInspection } from "@/core/projects/inspection";
import { ProjectInspectionContent, ProjectInspectionPanel } from "./ProjectInspectionPanel";

function fixture(): ProjectInspection {
  return { mode: "read-only", project: { name: "合成项目", updatedAt: "2026-09-21T00:00:00.000Z", stateRevision: 4 },
    notebooks: [{ index: 1, name: "合成分析", revision: 2, cells: [
      { index: 1, id: "sql_a", title: "已知查询", support: "known", kind: "sql", source: { language: "sql", text: "SELECT '<script>synthetic</script>'", truncated: true } },
      { index: 2, id: "future_a", title: "未来单元", support: "unknown", kind: "futureMatrix" },
    ] }], unknownCellCount: 1, omittedSourceCount: 3 };
}
describe("display-only project inspection", () => {
  it("renders known and unsupported metadata, truncation and the no-write boundary", () => {
    const html = renderToStaticMarkup(<ProjectInspectionContent inspection={fixture()} />);
    for (const label of ["合成项目", "项目修订 4", "合成分析", "已知查询", "未来单元", "futureMatrix", "当前版本不支持此单元",
      "不会切换当前项目，不执行代码，也不保存修改", "源码仅显示前段", "3 个单元的源码"]) expect(html).toContain(label);
    expect(html).not.toMatch(/<(?:textarea|input|button)\b/u);
    expect(html).not.toContain("contenteditable"); expect(html).not.toContain("加入 AI");
  });
  it("escapes code and names as text and keeps source collapsed by default", () => {
    const value = fixture(); value.project.name = "<img src=x>"; value.notebooks[0].cells[1].title = "<svg onload=unsafe>";
    const html = renderToStaticMarkup(<ProjectInspectionContent inspection={value} />);
    expect(html).toContain("&lt;script&gt;"); expect(html).toContain("&lt;img src=x&gt;");
    expect(html).not.toContain("<script>"); expect(html).not.toContain("<svg");
    expect(html).toContain("<details><summary>查看 SQL 源码</summary>");
    expect(html).not.toMatch(/<details[^>]*open/u);
  });
  it("does not offer source disclosure for unsupported cells", () => {
    const value = fixture(); value.notebooks[0].cells = [value.notebooks[0].cells[1]];
    const html = renderToStaticMarkup(<ProjectInspectionContent inspection={value} />);
    expect(html).toContain("不展示或执行内部配置"); expect(html).not.toContain("<details"); expect(html).not.toContain("<code");
  });
  it("shows an explicit empty project instead of implying successful execution", () => {
    const value = fixture(); value.notebooks = []; value.unknownCellCount = 0; value.omittedSourceCount = 0;
    const html = renderToStaticMarkup(<ProjectInspectionContent inspection={value} />);
    expect(html).toContain("项目尚未保存 Notebook 步骤"); expect(html).not.toContain("运行成功");
  });
  it("offers cancellation during initial loading without an execution or save action", () => {
    const html = renderToStaticMarkup(<ProjectInspectionPanel path="C:\\synthetic" onBack={vi.fn()} />);
    expect(html).toContain("返回项目列表"); expect(html).toContain("正在读取项目步骤");
    expect(html).not.toContain("C:\\synthetic"); expect(html).not.toContain("保存按钮");
    expect(html.match(/<button/g)).toHaveLength(1);
  });
});
