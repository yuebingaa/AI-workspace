import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { PageStructurePanel } from "./PageStructurePanel";

function fixture() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data.dataProduct);
}

function renderPanel(withEdsResources: boolean) {
  const dataProduct = fixture();
  if (withEdsResources) {
    dataProduct.appSpec.navigation.push({ id: "nav_eds_analysis", title: "EDS 异常分析", pageId: "page_eds_analysis" });
    dataProduct.appSpec.pages.push({
      id: "page_eds_analysis",
      title: "EDS 异常分析",
      route: "/eds-analysis",
      root: { id: "page_eds_analysis_root", type: "PageRoot", props: {}, children: [] },
    });
    dataProduct.datasets.push({
      id: "dataset_eds_overview",
      name: "EDS 分析总览",
      rowCount: 2,
      columnCount: 14,
      qualityScore: 100,
    });
  }

  return renderToStaticMarkup(<PageStructurePanel
    dataProduct={dataProduct}
    appSpec={dataProduct.appSpec}
    activePageId={withEdsResources ? "page_eds_analysis" : "page_home"}
    onPageChange={() => undefined}
    role="editor"
    onRenamePage={() => undefined}
    activeDataSourceId={withEdsResources ? "dataset_eds_overview" : "dataset_retail_orders"}
    onOpenDataSource={() => undefined}
    onUploadCsv={() => undefined}
    onOpenEdsAnalysis={() => undefined}
    edsAnalysisButtonRef={createRef<HTMLButtonElement>()}
    originalWorkbook={null}
    originalWorkbookButtonRef={createRef<HTMLButtonElement>()}
    onOpenOriginalWorkbook={() => undefined}
  />);
}

describe("PageStructurePanel", () => {
  it("移除旧零售演示页面、演示数据集和不可操作的图层树", () => {
    const html = renderPanel(true);

    expect(html).toContain("EDS 工作区");
    expect(html).toContain("EDS 异常分析");
    expect(html).toContain("EDS 分析总览");
    expect(html).not.toContain("经营总览");
    expect(html).not.toContain("销售分析");
    expect(html).not.toContain("客户洞察");
    expect(html).not.toContain("retail_orders");
    expect(html).not.toContain("当前页面图层");
    expect(html).not.toContain("页面标题");
    expect(html).not.toContain("···");
    expect(html).not.toContain("disabled");
  });

  it("尚未生成 EDS 看板时只保留可执行的数据入口", () => {
    const html = renderPanel(false);

    expect(html).not.toContain('aria-label="页面列表"');
    expect(html).not.toContain('class="data-source-card-list"');
    expect(html).toContain("EDS 分析");
    expect(html).toContain("上传 CSV");
    expect(html).toContain("放置原始表格");
  });
});
