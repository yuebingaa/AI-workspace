import { describe, expect, it } from "vitest";
import type { AppNode, AppSpec, ChangeSet } from "@/core/models";
import { demoFixtureResult } from "@/fixtures/demo-product";
import {
  applyChangeSet,
  cancelPreview,
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

function appNode(appSpec: AppSpec, nodeId: string) {
  for (const page of appSpec.pages) {
    const match = findNode(page.root, nodeId);
    if (match) return match;
  }
}

describe("ChangeSet 执行器", () => {
  it("正常预览时只生成预览 AppSpec，不修改正式 AppSpec", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const state = createExecutionState(dataProduct.appSpec);
    const next = previewChangeSet(state, repurchaseChangeSet);

    expect(appNode(state.present, "metric_repurchase")).toBeUndefined();
    expect(appNode(next.present, "metric_repurchase")).toBeUndefined();
    expect(appNode(next.preview!.appSpec, "metric_repurchase")).toBeDefined();
    expect(next.history).toHaveLength(0);
  });

  it("正常应用时更新正式 AppSpec 并记录历史", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const next = applyChangeSet(createExecutionState(dataProduct.appSpec), repurchaseChangeSet);

    expect(appNode(next.present, "metric_repurchase")).toBeDefined();
    expect(next.preview).toBeNull();
    expect(next.history).toHaveLength(1);
    expect(next.appliedChangeSetIds).toEqual([repurchaseChangeSet.id]);
  });

  it("取消预览时恢复正式 AppSpec", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const original = createExecutionState(dataProduct.appSpec);
    const previewed = previewChangeSet(original, repurchaseChangeSet);
    const cancelled = cancelPreview(previewed);

    expect(cancelled.preview).toBeNull();
    expect(cancelled.present).toEqual(original.present);
    expect(appNode(cancelled.present, "metric_repurchase")).toBeUndefined();
  });

  it("撤销最近一次变更时恢复应用前 AppSpec", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const applied = applyChangeSet(createExecutionState(dataProduct.appSpec), repurchaseChangeSet);
    const undone = undoLastChange(applied);

    expect(appNode(undone.present, "metric_repurchase")).toBeUndefined();
    expect(undone.history).toHaveLength(0);
    expect(undone.appliedChangeSetIds).toHaveLength(0);
  });

  it("拒绝引用不存在组件的操作且不修改正式 AppSpec", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const invalid = structuredClone(repurchaseChangeSet);
    const operation = invalid.operations.find((item) => item.type === "updateNodeProps");
    if (!operation || operation.type !== "updateNodeProps") throw new Error("测试 fixture 缺少更新操作");
    operation.nodeId = "missing_component";
    const state = createExecutionState(dataProduct.appSpec);

    expect(() => previewChangeSet(state, invalid)).toThrow(/不存在的组件/);
    expect(state.preview).toBeNull();
    expect(state.present).toEqual(dataProduct.appSpec);
  });

  it("拒绝新增与现有节点重复的 ID", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const invalid = structuredClone(repurchaseChangeSet);
    const operation = invalid.operations.find((item) => item.type === "addNode");
    if (!operation || operation.type !== "addNode") throw new Error("测试 fixture 缺少新增操作");
    operation.node.id = "page_home_revenue";

    expect(() => previewChangeSet(createExecutionState(dataProduct.appSpec), invalid)).toThrow(/重复节点 ID/);
  });

  it("拒绝不符合组件定义的属性", () => {
    const { dataProduct } = fixtures();
    const invalid = {
      id: "changeset_invalid_props",
      title: "非法属性测试",
      status: "ready",
      operations: [{
        id: "operation_invalid_props",
        type: "updateNodeProps",
        label: "修改指标",
        description: "把指标值改成非法数字类型",
        pageId: "page_home",
        nodeId: "page_home_revenue",
        props: { value: 42 },
      }],
    } as unknown as ChangeSet;

    expect(() => applyChangeSet(createExecutionState(dataProduct.appSpec), invalid)).toThrow(/属性校验失败/);
  });

  it("拒绝结构不完整的 ChangeOperation", () => {
    const { dataProduct } = fixtures();
    const invalid = {
      id: "changeset_invalid_operation",
      title: "非法操作结构",
      status: "ready",
      operations: [{ id: "broken", type: "addNode" }],
    } as unknown as ChangeSet;

    expect(() => previewChangeSet(createExecutionState(dataProduct.appSpec), invalid)).toThrow(/Schema 校验失败/);
  });

  it("支持连续应用和连续撤销", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const secondChangeSet: ChangeSet = {
      id: "changeset_update_header",
      title: "更新页面说明",
      status: "ready",
      operations: [{
        id: "operation_update_header",
        type: "updateNodeProps",
        label: "更新页面说明",
        description: "验证第二次连续应用",
        pageId: "page_home",
        nodeId: "page_home_header",
        props: { description: "第二次变更后的页面说明" },
      }],
    };

    const initial = createExecutionState(dataProduct.appSpec);
    const first = applyChangeSet(initial, repurchaseChangeSet);
    const second = applyChangeSet(first, secondChangeSet);
    expect(second.history).toHaveLength(2);
    expect(appNode(second.present, "metric_repurchase")).toBeDefined();
    expect(appNode(second.present, "page_home_header")?.props).toMatchObject({ description: "第二次变更后的页面说明" });

    const undoSecond = undoLastChange(second);
    expect(appNode(undoSecond.present, "metric_repurchase")).toBeDefined();
    expect(appNode(undoSecond.present, "page_home_header")?.props).not.toMatchObject({ description: "第二次变更后的页面说明" });

    const undoFirst = undoLastChange(undoSecond);
    expect(appNode(undoFirst.present, "metric_repurchase")).toBeUndefined();
    expect(undoFirst.present).toEqual(initial.present);
    expect(undoFirst.history).toHaveLength(0);
  });
});
