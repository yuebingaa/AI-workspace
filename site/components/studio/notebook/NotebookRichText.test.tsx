// @vitest-environment happy-dom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { markupRoot } from "@/test-support/markup";
import { NotebookRichText } from "./NotebookRichText";
import { NotebookTextResult } from "./NotebookTextResult";
import { renderNotebookTextParts, type NotebookTextPart } from "@/core/notebook/text-references";
import { notebookCellRunSchema } from "@/core/notebook/contracts";
import { notebookProgressResult } from "@/core/notebook/live-progress";

function render(markdown: string, parts?: NotebookTextPart[]) {
  return markupRoot(renderToStaticMarkup(<NotebookRichText markdown={markdown} parts={parts} />));
}
describe("Notebook safe Markdown", () => {
  it("uses mature Markdown/GFM rendering for report structure", () => {
    const root = render("## 季度结论\n\n**金额**与 *客户*\n\n- 企业\n- 个人\n\n> 说明\n\n| 指标 | 金额 |\n| --- | ---: |\n| 销售 | 150 |\n\n```sql\nSELECT 1\n```");
    expect(root.querySelector("h2")?.textContent).toBe("季度结论");
    expect(root.querySelectorAll("li")).toHaveLength(2);
    expect(root.querySelector("strong")?.textContent).toBe("金额");
    expect(root.querySelector("blockquote")?.textContent).toContain("说明");
    expect(root.querySelector("tbody td")?.textContent).toBe("销售");
    expect(root.querySelector("pre code")?.textContent).toContain("SELECT 1");
  });
  it("does not execute HTML, fetch images or create unsafe/internal links", () => {
    const root = render('<script>alert(1)</script>\n\n<iframe src="https://invalid.example"/>\n\n![private](https://invalid.example/pixel)\n\n[x](javascript:alert%281%29) [file](file:///C:/data) [local](/api/projects) [web](https://example.com)');
    expect(root.querySelector("script,iframe,img,object,embed,input")).toBeNull();
    expect(root.querySelectorAll("a")).toHaveLength(1);
    expect(root.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(root.querySelector("a")?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });
  const attacks = ["**不是强调**", "[不是链接](https://invalid.example)", "<img src=x onerror=alert(1)>", "\n\n# 不是标题\n\n- 不是列表", "| 新列 |", "`代码`", "https://invalid.example", "ACNOTEBOOKVALUE0END", "&lt;script&gt;"];
  it.each(attacks)("preserves data as literal text after parsing: %s", value => {
    const parts: NotebookTextPart[] = [{ kind: "markdown", value: "## 结论\n\n值：" }, { kind: "literal", value }];
    const root = render(parts.map(part => part.value).join(""), parts);
    expect(root.querySelectorAll("h1,h2,h3")).toHaveLength(1);
    expect(root.querySelector("strong,a,img,li,code,script")).toBeNull();
    expect(root.querySelector("p")?.textContent).toBe(`值：${value}`);
  });
  it("does not interpolate a data value into link destinations or image attributes", () => {
    const root = render("", [{ kind: "markdown", value: "[链接](https://" }, { kind: "literal", value: "example.com" }, { kind: "markdown", value: ")" }]);
    expect(root.querySelector("a")).toBeNull();
    expect(root.textContent).not.toContain("ACNOTEBOOKVALUE");
  });
  it("preserves pipes and line breaks in a dynamic table cell without adding rows or columns", () => {
    const parts: NotebookTextPart[] = [{ kind: "markdown", value: "| 项目 | 值 |\n| --- | --- |\n| 合计 | " }, { kind: "literal", value: "a | b\n\n# c" }, { kind: "markdown", value: " |" }];
    const root = render("", parts);
    expect(root.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(root.querySelectorAll("tbody td")).toHaveLength(2);
    expect(root.querySelectorAll("tbody td")[1].textContent).toBe("a | b\n\n# c");
  });
  it("creates matching server parts and keeps stale/failed data hidden", () => {
    const cell = { id: "note", kind: "text" as const, title: "结论", markdown: "## 结论\n\n总计 **{{total}}**", references: [{ key: "total", cellId: "data", field: "amount" }] };
    const parts = renderNotebookTextParts(cell, new Map([["data", { fields: [{ name: "amount", label: "金额", type: "string" as const }], rows: [{ amount: "[值](https://invalid.example)" }], truncated: false }]]));
    const result = notebookCellRunSchema.parse({ cellId: "note", status: "success", durationMs: 0, text: parts.map(part => part.value).join(""), textParts: parts });
    const root = markupRoot(renderToStaticMarkup(<NotebookTextResult cell={cell} cells={[cell]} result={result} stale={false} running={false} />));
    expect(root.querySelector("h2")?.textContent).toBe("结论");
    expect(root.querySelector("strong")?.textContent).toBe("[值](https://invalid.example)");
    expect(root.querySelector("a")).toBeNull();
    expect(renderToStaticMarkup(<NotebookTextResult cell={cell} cells={[cell]} result={result} stale running={false} />)).not.toContain("https://invalid.example");
    expect(notebookCellRunSchema.safeParse({ ...result, text: "changed" }).success).toBe(false);
    expect(notebookCellRunSchema.safeParse({ ...result, status: "failure" }).success).toBe(false);
  });
  it("strips rich boundaries from truncated progress, never renders a partial template as trusted markup", () => {
    const result = { cellId: "note", status: "success" as const, durationMs: 0, text: "x".repeat(3000), textParts: [{ kind: "literal" as const, value: "x".repeat(3000) }] };
    const preview = notebookProgressResult(result);
    expect(preview.text).toHaveLength(2000); expect(preview.textParts).toBeUndefined();
    expect(notebookCellRunSchema.safeParse(preview).success).toBe(true);
  });
});
