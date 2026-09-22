import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SemanticModelDeletionImpact } from "./SemanticModelDeletionImpact";

describe("semantic model deletion impact display", () => {
  it("shows the exact Notebook and cell identity without offering cascade deletion", () => {
    const html = renderToStaticMarkup(<SemanticModelDeletionImpact id="impact" references={[
      { pageId: "page_one", notebookName: "销售分析", cellId: "query_one", cellTitle: "区域汇总" },
      { pageId: "page_two", notebookName: "销售分析", cellId: "query_two", cellTitle: "区域汇总" },
    ]} />);
    expect(html).toContain('id="impact"'); expect(html).toContain("2 个 Notebook 单元正在引用");
    for (const value of ["销售分析", "区域汇总", "page_one", "page_two", "query_one", "query_two", "不会自动删除下游分析"]) expect(html).toContain(value);
    expect(html).not.toContain("<button");
  });
  it("limits display, not the reported count or protection", () => {
    const references = Array.from({ length: 12 }, (_, i) => ({ pageId: "page", notebookName: "Book", cellId: `cell_${i}`, cellTitle: `Query ${i}` }));
    const html = renderToStaticMarkup(<SemanticModelDeletionImpact id="impact" references={references} />);
    expect(html.match(/<li>/gu)).toHaveLength(10);
    expect(html).toContain("12 个 Notebook 单元正在引用"); expect(html).toContain("另有 2 个引用未展开");
  });
  it("explains confirmation and old-draft behavior for an unreferenced model", () => {
    const html = renderToStaticMarkup(<SemanticModelDeletionImpact id="impact" references={[]} />);
    expect(html).toContain("删除前仍会再次检查并要求确认");
    expect(html).toContain("原数据、看板及历史结果不变"); expect(html).toContain("需重新生成");
    expect(html).not.toContain("暂不能删除");
  });
  it("escapes untrusted names instead of rendering them as markup", () => {
    const html = renderToStaticMarkup(<SemanticModelDeletionImpact id="impact" references={[
      { pageId: "page", notebookName: "<img src=x>", cellId: "cell", cellTitle: "<script>alert(1)</script>" },
    ]} />);
    expect(html).not.toContain("<img"); expect(html).not.toContain("<script"); expect(html).toContain("&lt;script&gt;");
  });
});
