import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { ChangeSet } from "@/core/models";
import { describeHarnessChangeSet } from "./change-summary";

function appSpec() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data.dataProduct.appSpec);
}

describe("Harness ChangeSet change summary", () => {
  it("answers what changed with exact before and after values", () => {
    const changeSet: ChangeSet = {
      id: "changeset_summary_update",
      title: "修改收入标题",
      status: "ready",
      operations: [{
        id: "operation_summary_update",
        type: "updateNodeProps",
        label: "修改组件属性",
        description: "修改收入卡片标题",
        pageId: "page_home",
        nodeId: "page_home_revenue",
        props: { label: "月度总收入", showValues: true },
      }],
    };

    const summary = describeHarnessChangeSet(changeSet, appSpec());

    expect(summary).toContain("已生成 1 项待确认变更");
    expect(summary).toContain("本月收入");
    expect(summary).toContain("月度总收入");
    expect(summary).toContain("数据标签：未设置 → 开启");
    expect(summary).toContain("正式页面尚未修改");
  });

  it("describes additions, moves, removals, and page updates", () => {
    const spec = appSpec();
    const node = structuredClone(spec.pages[0].root.children?.[0]);
    if (!node) throw new Error("fixture missing node");
    const changeSet: ChangeSet = {
      id: "changeset_summary_structural",
      title: "结构调整",
      status: "ready",
      operations: [
        { id: "operation_add", type: "addNode", label: "新增", description: "新增组件", pageId: "page_home", parentId: "page_home_root", node },
        { id: "operation_move", type: "moveNode", label: "移动", description: "移动组件", pageId: "page_home", nodeId: node.id, parentId: "page_home_root", position: 1 },
        { id: "operation_remove", type: "removeNode", label: "删除", description: "删除组件", pageId: "page_home", nodeId: node.id },
        { id: "operation_page", type: "updatePage", label: "页面", description: "修改页面", pageId: "page_home", title: "经营驾驶舱", route: "/dashboard" },
      ],
    };

    const summary = describeHarnessChangeSet(changeSet, spec);

    expect(summary).toContain("新增");
    expect(summary).toContain("移动到");
    expect(summary).toContain("删除");
    expect(summary).toContain("经营驾驶舱");
    expect(summary).toContain("/dashboard");
  });
});
