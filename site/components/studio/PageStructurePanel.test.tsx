import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { PageStructurePanel } from "./PageStructurePanel";

function renderPanel(withInterfaces: boolean, activePageId = "page_eds_analysis") {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  const appSpec = structuredClone(demoFixtureResult.data.dataProduct.appSpec);
  if (withInterfaces) {
    appSpec.navigation.push(
      { id: "nav_eds_analysis", title: "EDS 异常分析", pageId: "page_eds_analysis" },
      { id: "nav_sales_analysis", title: "销售分析与月度经营汇总工作界面", pageId: "page_sales_analysis" },
    );
  }
  return renderToStaticMarkup(<PageStructurePanel appSpec={appSpec} activePageId={activePageId} onPageChange={() => undefined} />);
}

describe("PageStructurePanel", () => {
  it("只显示真实工作界面的选择按钮，不再混入资源和管理操作", () => {
    const html = renderPanel(true);

    expect(html).toContain('aria-label="工作界面选择"');
    expect(html).toContain('aria-label="工作界面列表"');
    expect(html).toContain("EDS 异常分析");
    expect(html).toContain('title="销售分析与月度经营汇总工作界面"');
    expect(html.match(/<button /g)).toHaveLength(2);
    for (const removed of ["经营总览", "客户洞察", "retail_orders", "Data Browser", "数据管理", "数据质量", "AI 数据分析", "语义模型", "原始资料", "导入表格", "空白界面", "重命名", "删除"]) {
      expect(html).not.toContain(removed);
    }
  });

  it("只标记当前界面，名称和选中状态同时可被辅助技术读取", () => {
    const html = renderPanel(true);
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('aria-current="page" title="EDS 异常分析"');
    expect(html).toContain('class="interface-selection-check" aria-hidden="true"');
    expect(renderPanel(true, "page_sales_analysis")).toContain('aria-current="page" title="销售分析与月度经营汇总工作界面"');
  });

  it("没有可选界面时显示简洁空状态，不提供无关操作", () => {
    const html = renderPanel(false);
    expect(html).toContain("暂无工作界面");
    expect(html).not.toContain("<button");
    expect(html).not.toContain('aria-label="工作界面列表"');
    expect(html).not.toContain('aria-current="page"');
  });
});
