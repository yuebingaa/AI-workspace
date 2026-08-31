import { describe, expect, it } from "vitest";
import { applyChangeSet, createExecutionState, undoLastChange } from "@/core/changesets";
import type { AppNode } from "@/core/models";
import { demoFixtureResult } from "@/fixtures/demo-product";
import {
  appSpecToPuckData,
  puckDataToAppPage,
  puckDataToChangeSet,
} from "./appspec-puck-adapter";

function fixtures() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data);
}

function findNode(root: AppNode, nodeId: string): AppNode | undefined {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const match = findNode(child, nodeId);
    if (match) return match;
  }
}

describe("AppSpec 与 Puck Data 适配器", () => {
  it("将 AppSpec 页面转换为包含嵌套插槽的 Puck Data", () => {
    const { dataProduct } = fixtures();
    const data = appSpecToPuckData(dataProduct.appSpec, "page_home");

    expect(data.content.map((item) => item.type)).toEqual([
      "PageHeader",
      "InsightBanner",
      "MetricGrid",
      "DashboardGrid",
      "DataTable",
    ]);
    const metricGrid = data.content.find((item) => item.type === "MetricGrid");
    expect(metricGrid?.props.children).toHaveLength(3);
    expect(metricGrid?.props.children[0].type).toBe("MetricCard");
  });

  it("将 Puck 属性编辑转换为 ChangeSet", () => {
    const { dataProduct } = fixtures();
    const data = appSpecToPuckData(dataProduct.appSpec, "page_home");
    const header = data.content.find((item) => item.type === "PageHeader");
    if (!header || header.type !== "PageHeader") throw new Error("缺少页面标题 fixture");
    header.props.title = "Puck 编辑后的标题";

    const changeSet = puckDataToChangeSet(dataProduct.appSpec, "page_home", data);
    expect(changeSet.operations).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "updateNodeProps", nodeId: "page_home_header" }),
    ]));
  });

  it("AppSpec 转换为 Puck Data 再转换回来后结构保持一致", () => {
    const { dataProduct } = fixtures();
    const page = dataProduct.appSpec.pages.find((item) => item.id === "page_home")!;
    const data = appSpecToPuckData(dataProduct.appSpec, page.id);

    expect(puckDataToAppPage(page, data)).toEqual(page);
  });

  it("拖动排序生成 moveNode 操作并得到正确顺序", () => {
    const { dataProduct } = fixtures();
    const data = appSpecToPuckData(dataProduct.appSpec, "page_home");
    data.content = [data.content[1], data.content[0], ...data.content.slice(2)];

    const changeSet = puckDataToChangeSet(dataProduct.appSpec, "page_home", data);
    expect(changeSet.operations.some((operation) => operation.type === "moveNode")).toBe(true);

    const applied = applyChangeSet(createExecutionState(dataProduct.appSpec), changeSet);
    const page = applied.present.pages.find((item) => item.id === "page_home")!;
    expect(page.root.children?.slice(0, 2).map((node) => node.id)).toEqual([
      "page_home_insight",
      "page_home_header",
    ]);
  });

  it("组件属性修改生成正确的 updateNodeProps 操作", () => {
    const { dataProduct } = fixtures();
    const data = appSpecToPuckData(dataProduct.appSpec, "page_home");
    const table = data.content.find((item) => item.type === "DataTable");
    if (!table || table.type !== "DataTable") throw new Error("缺少数据表 fixture");
    table.props.actionLabel = "导出当前视图";

    const changeSet = puckDataToChangeSet(dataProduct.appSpec, "page_home", data);
    expect(changeSet.operations).toContainEqual(expect.objectContaining({
      type: "updateNodeProps",
      nodeId: "page_home_table",
      props: expect.objectContaining({ actionLabel: "导出当前视图" }),
    }));
  });

  it("数据绑定编辑生成 ChangeSet 而不直接修改 AppSpec", () => {
    const { dataProduct } = fixtures();
    const original = structuredClone(dataProduct.appSpec);
    const data = appSpecToPuckData(dataProduct.appSpec, "page_home");
    const grid = data.content.find((item) => item.type === "MetricGrid");
    if (!grid || grid.type !== "MetricGrid") throw new Error("缺少指标组 fixture");
    const metric = grid.props.children.find((item) => item.type === "MetricCard");
    if (!metric || metric.type !== "MetricCard") throw new Error("缺少指标卡 fixture");
    metric.props.binding = { ...metric.props.binding, field: "average_order_value", aggregation: "average" };

    const changeSet = puckDataToChangeSet(dataProduct.appSpec, "page_home", data, "editor");
    expect(changeSet.operations).toContainEqual(expect.objectContaining({
      type: "updateNodeProps",
      nodeId: "page_home_revenue",
      props: expect.objectContaining({ binding: expect.objectContaining({ field: "average_order_value" }) }),
    }));
    expect(dataProduct.appSpec).toEqual(original);
  });

  it("拒绝包含非法组件属性的 Puck Data", () => {
    const { dataProduct } = fixtures();
    const data = appSpecToPuckData(dataProduct.appSpec, "page_home");
    const invalid = structuredClone(data) as unknown as {
      content: Array<{ type: string; props: Record<string, unknown> }>;
      root: Record<string, unknown>;
    };
    invalid.content[0].props.title = 42;

    expect(() => puckDataToChangeSet(dataProduct.appSpec, "page_home", invalid)).toThrow(/属性校验失败/);
  });

  it("Puck 变更应用后可通过现有执行器撤销", () => {
    const { dataProduct } = fixtures();
    const data = appSpecToPuckData(dataProduct.appSpec, "page_home");
    const header = data.content.find((item) => item.type === "PageHeader");
    if (!header || header.type !== "PageHeader") throw new Error("缺少页面标题 fixture");
    header.props.description = "通过 Puck 修改的页面说明";
    const changeSet = puckDataToChangeSet(dataProduct.appSpec, "page_home", data);

    const initial = createExecutionState(dataProduct.appSpec);
    const applied = applyChangeSet(initial, changeSet);
    const appliedPage = applied.present.pages.find((item) => item.id === "page_home")!;
    expect(findNode(appliedPage.root, "page_home_header")?.props).toMatchObject({
      description: "通过 Puck 修改的页面说明",
    });

    const undone = undoLastChange(applied);
    expect(undone.present).toEqual(initial.present);
  });
});
