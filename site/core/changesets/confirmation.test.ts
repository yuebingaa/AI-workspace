import { describe, expect, it } from "vitest";
import type { AppNode, AppSpec, ChangeSet } from "@/core/models";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { applyPreviewedChangeSet } from "./confirmation";
import {
  applyChangeSet,
  cancelPreview,
  createExecutionState,
  previewChangeSet,
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

describe("previewed ChangeSet confirmation", () => {
  it("rejects a legacy in-memory preview without a captured confirmation baseline", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const state = previewChangeSet(createExecutionState(dataProduct.appSpec), repurchaseChangeSet);
    if (!state.preview) throw new Error("Expected preview");
    delete state.preview.confirmation;
    expect(() => applyPreviewedChangeSet(state, repurchaseChangeSet, "editor")).toThrow("当前预览已变化");
  });

  it("refuses an overlapping formal edit even when applying would reproduce the old preview", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const state = previewChangeSet(createExecutionState(dataProduct.appSpec), repurchaseChangeSet);
    const operation = repurchaseChangeSet.operations.find((item) => item.id === "operation_recipe");
    if (!operation || operation.type !== "updateNodeProps") throw new Error("Expected property update");
    const concurrent: ChangeSet = { id: "changeset_concurrent_overlap", title: "保留较新的编辑", status: "ready", operations: [
      { ...operation, id: "op_concurrent_overlap", props: { description: "预览之后用户修改的同一属性" } },
    ] };
    const newer = { ...applyChangeSet(cancelPreview(state), concurrent, "editor"), preview: state.preview };
    // A final-result-only guard would miss this lost update.
    expect(applyChangeSet(newer, repurchaseChangeSet, "editor").present).toEqual(state.preview?.appSpec);
    const before = structuredClone(newer);
    expect(() => applyPreviewedChangeSet(newer, repurchaseChangeSet, "editor")).toThrow("当前页面或变更内容已变化");
    expect(newer).toEqual(before);
  });

  it.each(["title", "label", "description"] as const)("rejects changed %s metadata even when resulting page content is identical", (field) => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const state = previewChangeSet(createExecutionState(dataProduct.appSpec), repurchaseChangeSet);
    const candidate = structuredClone(repurchaseChangeSet);
    if (field === "title") candidate.title = "不是此前审阅的标题";
    else candidate.operations[0][field] = "不是此前审阅的操作说明";
    expect(applyChangeSet(state, candidate, "editor").present).toEqual(state.preview?.appSpec);
    expect(() => applyPreviewedChangeSet(state, candidate, "editor")).toThrow("当前页面或变更内容已变化");
  });

  it("rejects confirmation when there is no reviewed preview", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const state = createExecutionState(dataProduct.appSpec);
    const before = structuredClone(state);

    expect(() => applyPreviewedChangeSet(state, repurchaseChangeSet, "editor"))
      .toThrow("当前预览已变化");
    expect(state).toEqual(before);
  });

  it("rejects a replacement ChangeSet ID even when operation IDs are unchanged", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const state = previewChangeSet(createExecutionState(dataProduct.appSpec), repurchaseChangeSet);
    const replacement = { ...repurchaseChangeSet, id: "changeset_replacement" };
    const before = structuredClone(state);

    expect(() => applyPreviewedChangeSet(state, replacement, "editor"))
      .toThrow("当前预览已变化");
    expect(state).toEqual(before);
  });

  it("rejects changed operation content under the same ChangeSet and operation IDs", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const state = previewChangeSet(createExecutionState(dataProduct.appSpec), repurchaseChangeSet);
    const changed = structuredClone(repurchaseChangeSet);
    const operation = changed.operations.find((item) => item.id === "operation_recipe");
    if (!operation || operation.type !== "updateNodeProps") throw new Error("测试 fixture 缺少目标操作");
    operation.props = { description: "同 ID 下被替换的预览内容" };
    const before = structuredClone(state);

    expect(() => applyPreviewedChangeSet(state, changed, "editor"))
      .toThrow("当前页面或变更内容已变化");
    expect(state).toEqual(before);
  });

  it("rejects confirmation after the formal page changes independently", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const previewed = previewChangeSet(createExecutionState(dataProduct.appSpec), repurchaseChangeSet);
    const formalUpdate: ChangeSet = {
      id: "changeset_formal_page_update",
      title: "正式页并发更新",
      status: "ready",
      operations: [{
        id: "operation_formal_page_update",
        type: "updateNodeProps",
        label: "更新正式页说明",
        description: "模拟预览后发生的独立正式页变更",
        pageId: "page_home",
        nodeId: "page_home_header",
        props: { description: "预览生成后保存的正式页说明" },
      }],
    };
    const formallyChanged = applyChangeSet(cancelPreview(previewed), formalUpdate, "editor");
    const staleState = { ...formallyChanged, preview: previewed.preview };
    const before = structuredClone(staleState);

    expect(() => applyPreviewedChangeSet(staleState, repurchaseChangeSet, "editor"))
      .toThrow("当前页面或变更内容已变化");
    expect(staleState).toEqual(before);
  });

  it("applies the exact reviewed preview and still enforces viewer permissions", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const previewed = previewChangeSet(createExecutionState(dataProduct.appSpec), repurchaseChangeSet);
    const applied = applyPreviewedChangeSet(previewed, repurchaseChangeSet, "editor");

    expect(applied.preview).toBeNull();
    expect(applied.present).toEqual(previewed.preview?.appSpec);
    expect(appNode(applied.present, "metric_repurchase")).toBeDefined();
    expect(applied.history).toHaveLength(1);
    expect(applied.appliedChangeSetIds).toEqual([repurchaseChangeSet.id]);

    const viewerState = previewChangeSet(createExecutionState(dataProduct.appSpec), repurchaseChangeSet, "viewer");
    const before = structuredClone(viewerState);
    expect(() => applyPreviewedChangeSet(viewerState, repurchaseChangeSet, "viewer"))
      .toThrow(/查看者无权/);
    expect(viewerState).toEqual(before);
  });

  it("cancels a preview without modifying the formal page", () => {
    const { dataProduct, repurchaseChangeSet } = fixtures();
    const previewed = previewChangeSet(createExecutionState(dataProduct.appSpec), repurchaseChangeSet);
    const cancelled = cancelPreview(previewed);

    expect(cancelled.preview).toBeNull();
    expect(cancelled.present).toEqual(dataProduct.appSpec);
    expect(appNode(cancelled.present, "metric_repurchase")).toBeUndefined();
    expect(cancelled.history).toEqual([]);
    expect(cancelled.appliedChangeSetIds).toEqual([]);
  });
});
