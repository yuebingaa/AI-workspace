import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectCompatibilityNotice } from "./ProjectCompatibilityNotice";

describe("project compatibility notice", () => {
  it("shows only bounded cell locations and explains fail-closed retention", () => {
    const html = renderToStaticMarkup(<ProjectCompatibilityNotice issue={{
      code: "project_incompatible", reason: "notebook-cells",
      cells: [{ notebookIndex: 2, cellIndex: 3, kind: "futurePlot" }], total: 8, omitted: 7,
    }} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("项目兼容性检查");
    expect(html).toContain("第 2 个 Notebook · 第 3 个单元");
    expect(html).toContain("futurePlot"); expect(html).toContain("另有 7 个");
    expect(html).toContain("全部 8 个均受保护"); expect(html).toContain("不会转换、删除未知定义");
    expect(html).toContain("空白项目覆盖"); expect(html).toContain("先备份整个项目文件夹");
    expect(html).not.toContain("<button"); expect(html).not.toContain("<script");
  });

  it("handles an unprintable unknown kind without displaying its content", () => {
    const html = renderToStaticMarkup(<ProjectCompatibilityNotice issue={{
      code: "project_incompatible", reason: "notebook-cells",
      cells: [{ notebookIndex: 1, cellIndex: 1 }], total: 1, omitted: 0,
    }} />);
    expect(html).toContain("第 1 个单元"); expect(html).not.toContain("<code>");
    expect(html).not.toContain("未列出");
  });

  it("identifies a newer workspace version without rendering source definitions", () => {
    const html = renderToStaticMarkup(<ProjectCompatibilityNotice issue={{
      code: "project_incompatible", reason: "workspace-version", supportedVersion: 6, detectedVersion: 7,
    }} />);
    expect(html).toContain("7"); expect(html).toContain("6");
    expect(html).toContain("不兼容"); expect(html).not.toContain("<ul>");
  });

  it("reports a project-format mismatch without a raw filename or format string", () => {
    const html = renderToStaticMarkup(<ProjectCompatibilityNotice issue={{ code: "project_incompatible", reason: "project-format" }} />);
    expect(html).toContain("不兼容"); expect(html).toContain("本次操作已被拒绝");
    expect(html).not.toContain("<ul>");
  });
});
