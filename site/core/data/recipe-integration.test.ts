import { describe, expect, it } from "vitest";
import { createChangeSetAuditRecord } from "@/core/audit";
import { applyChangeSet, createExecutionState, previewChangeSet, undoLastChange } from "@/core/changesets";
import type { AppNode } from "@/core/models";
import { createStudioSnapshot, LocalStorageStudioRepository, type StorageLike } from "@/core/repository";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { retailOrdersDataSource } from "@/fixtures/retail-orders";
import { createRecipeBindingChangeSet } from "./recipe-binding";

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

function fixtures() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data);
}

function findNode(node: AppNode, id: string): AppNode | undefined {
  if (node.id === id) return node;
  for (const child of node.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
}

describe("DataRecipe 到正式组件绑定的集成链路", () => {
  it("配方绑定通过 ChangeSet 预览、应用、审计、持久化和撤销", () => {
    const { dataProduct } = fixtures();
    const changeSet = createRecipeBindingChangeSet(
      dataProduct.recipes[0],
      retailOrdersDataSource,
      { pageId: "page_home", nodeId: "page_home_table" },
      () => 1_000,
    );
    expect(changeSet.operations).toEqual([expect.objectContaining({
      type: "updateNodeProps",
      pageId: "page_home",
      nodeId: "page_home_table",
      props: { binding: expect.objectContaining({
        dataSourceId: "dataset_retail_orders",
        groupBy: "category",
        filters: [{ field: "region", operator: "equals", value: "华东" }],
        sort: [{ field: "revenue", direction: "desc" }],
        limit: 4,
      }) },
    })]);

    const initial = createExecutionState(dataProduct.appSpec);
    const previewed = previewChangeSet(initial, changeSet, "editor");
    expect(previewed.present).toEqual(initial.present);
    expect(findNode(previewed.preview!.appSpec.pages[0].root, "page_home_table")).not.toEqual(
      findNode(initial.present.pages[0].root, "page_home_table"),
    );

    const applied = applyChangeSet(previewed, changeSet, "editor");
    const audit = createChangeSetAuditRecord(changeSet, "editor", "manual", "applied");
    const storage = new MemoryStorage();
    const repository = new LocalStorageStudioRepository(storage);
    repository.save(createStudioSnapshot(dataProduct, applied, [audit], []));
    const loaded = repository.load();
    expect(loaded?.dataProduct.recipes[0]).toEqual(dataProduct.recipes[0]);
    expect(loaded?.appSpec).toEqual(applied.present);
    expect(loaded?.auditRecords[0]).toMatchObject({ source: "manual", status: "applied" });
    expect(undoLastChange(applied, "editor").present).toEqual(initial.present);
  });

  it("viewer 可以查看配方结果但不能应用绑定 ChangeSet", () => {
    const { dataProduct } = fixtures();
    const changeSet = createRecipeBindingChangeSet(
      dataProduct.recipes[0],
      retailOrdersDataSource,
      { pageId: "page_home", nodeId: "page_home_table" },
      () => 2_000,
    );
    const initial = createExecutionState(dataProduct.appSpec);
    expect(() => applyChangeSet(initial, changeSet, "viewer")).toThrow(/查看者无权修改组件属性/);
    expect(initial.present).toEqual(dataProduct.appSpec);
  });
});
