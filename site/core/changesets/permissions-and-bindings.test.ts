import { describe, expect, it } from "vitest";
import type { AppNode, AppSpec, ChangeSet, MetricCardProps } from "@/core/models";
import { demoFixtureResult } from "@/fixtures/demo-product";
import {
  applyChangeSet,
  createExecutionState,
  previewChangeSet,
  undoLastChange,
} from "./executor";

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

function nodeIn(appSpec: AppSpec, nodeId: string) {
  for (const page of appSpec.pages) {
    const node = findNode(page.root, nodeId);
    if (node) return node;
  }
}

function updateMetricBinding(appSpec: AppSpec, patch: Partial<MetricCardProps["binding"]>): ChangeSet {
  const node = nodeIn(appSpec, "page_home_revenue");
  if (!node || node.type !== "MetricCard") throw new Error("缺少指标卡 fixture");
  return {
    id: "changeset_binding",
    title: "修改指标绑定",
    status: "ready",
    operations: [{
      id: "operation_binding",
      type: "updateNodeProps",
      label: "修改数据绑定",
      description: "测试绑定变更",
      pageId: "page_home",
      nodeId: node.id,
      props: { binding: { ...node.props.binding, ...patch } },
    }],
  };
}

describe("数据绑定 ChangeSet 与编辑权限", () => {
  it("绑定变更可应用并撤销", () => {
    const { dataProduct } = fixtures();
    const initial = createExecutionState(dataProduct.appSpec);
    const changeSet = updateMetricBinding(initial.present, { field: "average_order_value", aggregation: "average" });
    const applied = applyChangeSet(initial, changeSet, "editor");
    expect(nodeIn(applied.present, "page_home_revenue")).toMatchObject({
      props: { binding: { field: "average_order_value", aggregation: "average" } },
    });
    expect(undoLastChange(applied, "editor").present).toEqual(initial.present);
  });

  it("拒绝不兼容字段类型和不存在的字段", () => {
    const { dataProduct } = fixtures();
    const state = createExecutionState(dataProduct.appSpec);
    expect(() => applyChangeSet(state, updateMetricBinding(state.present, { field: "region", aggregation: "sum" }), "editor")).toThrow(/不支持 sum 聚合/);
    expect(() => applyChangeSet(state, updateMetricBinding(state.present, { field: "missing_field" }), "editor")).toThrow(/不存在的字段/);
    expect(() => applyChangeSet(state, updateMetricBinding(state.present, { dataSourceId: "missing_source" }), "editor")).toThrow(/不存在的数据源/);
  });

  it("viewer 可以预览但不能应用或撤销", () => {
    const { dataProduct } = fixtures();
    const state = createExecutionState(dataProduct.appSpec);
    const changeSet = updateMetricBinding(state.present, { aggregation: "average" });
    expect(previewChangeSet(state, changeSet, "viewer").preview).not.toBeNull();
    expect(() => applyChangeSet(state, changeSet, "viewer")).toThrow(/查看者无权修改组件属性/);
    const applied = applyChangeSet(state, changeSet, "editor");
    expect(() => undoLastChange(applied, "viewer")).toThrow(/查看者无权撤销/);
  });

  it("editor 可以添加、排序和修改，但不能删除组件或修改页面结构", () => {
    const { dataProduct } = fixtures();
    const state = createExecutionState(dataProduct.appSpec);
    const remove: ChangeSet = {
      id: "changeset_remove",
      title: "删除组件",
      status: "ready",
      operations: [{ id: "remove_health", type: "removeNode", label: "删除健康度", description: "权限测试", pageId: "page_home", nodeId: "page_home_health" }],
    };
    const updatePage: ChangeSet = {
      id: "changeset_page",
      title: "修改页面",
      status: "ready",
      operations: [{ id: "update_page", type: "updatePage", label: "重命名页面", description: "权限测试", pageId: "page_home", title: "新名称" }],
    };
    expect(() => applyChangeSet(state, remove, "editor")).toThrow(/编辑者无权删除组件/);
    expect(() => applyChangeSet(state, updatePage, "editor")).toThrow(/编辑者无权修改页面结构/);
  });

  it("admin 可以删除组件和修改页面结构", () => {
    const { dataProduct } = fixtures();
    const state = createExecutionState(dataProduct.appSpec);
    const changeSet: ChangeSet = {
      id: "changeset_admin",
      title: "管理员操作",
      status: "ready",
      operations: [
        { id: "remove_health", type: "removeNode", label: "删除健康度", description: "权限测试", pageId: "page_home", nodeId: "page_home_health" },
        { id: "update_page", type: "updatePage", label: "重命名页面", description: "权限测试", pageId: "page_home", title: "管理员页面" },
      ],
    };
    const applied = applyChangeSet(state, changeSet, "admin");
    expect(nodeIn(applied.present, "page_home_health")).toBeUndefined();
    expect(applied.present.pages.find((page) => page.id === "page_home")?.title).toBe("管理员页面");
    expect(applied.present.navigation.find((item) => item.pageId === "page_home")?.title).toBe("管理员页面");
  });

  it("任何角色都不能删除页面根节点", () => {
    const { dataProduct } = fixtures();
    const changeSet: ChangeSet = {
      id: "changeset_remove_root",
      title: "删除根节点",
      status: "ready",
      operations: [{ id: "remove_root", type: "removeNode", label: "删除根节点", description: "约束测试", pageId: "page_home", nodeId: "page_home_root" }],
    };
    expect(() => applyChangeSet(createExecutionState(dataProduct.appSpec), changeSet, "admin")).toThrow(/不能删除页面根节点/);
  });

  it("拒绝超过每页组件数量上限", () => {
    const { dataProduct } = fixtures();
    const metric = nodeIn(dataProduct.appSpec, "page_home_revenue");
    if (!metric || metric.type !== "MetricCard") throw new Error("缺少指标卡 fixture");
    const oversizedNode: AppNode = {
      id: "oversized_grid",
      type: "MetricGrid",
      props: { columns: 4 },
      children: Array.from({ length: 20 }, (_, index) => ({
        id: `oversized_metric_${index}`,
        type: "MetricCard" as const,
        props: { ...structuredClone(metric.props), label: `测试指标 ${index + 1}` },
      })),
    };
    const changeSet: ChangeSet = {
      id: "changeset_oversized",
      title: "超出组件上限",
      status: "ready",
      operations: [{ id: "add_oversized", type: "addNode", label: "添加过多组件", description: "上限测试", pageId: "page_home", parentId: "page_home_root", node: oversizedNode }],
    };
    expect(() => applyChangeSet(createExecutionState(dataProduct.appSpec), changeSet, "editor")).toThrow(/最多允许 30 个/);
  });
});
