import { describe, it, expect } from "vitest";
import { executeDataRecipe } from "@/core/data";
import { createExecutionState } from "@/core/changesets";
import { dataProductSchema } from "@/core/schemas";
import { createStudioSnapshot, exportStudioBackup, importStudioBackup } from "@/core/repository";
import { semanticLayerSchema, semanticModelSchema, semanticQuerySchema } from "./contracts";
import { compileSemanticQuery, deleteSemanticModel, saveSemanticModel, selectedSemanticModel, selectSemanticModel, semanticModelsForWorkspace, validateSemanticModel } from "./model";
import { semanticFixture } from "./test-fixture";
import { assertSemanticBinding, assertSemanticPreviewBindings } from "./bindings";
import type { DataBinding } from "@/core/models";
import { reconcileDataProductWorkspaces } from "@/core/workspaces";

describe("业务语义模型", () => {
  it("图表新绑定遵循指标口径，纯样式变更不会改写旧图表", () => {
    const { product, model } = semanticFixture();
    const binding: DataBinding = { dataSourceId: model.sourceDatasetId, field: "amount", aggregation: "sum", groupBy: "region",
      filters: [], sort: [], limit: 10, format: { style: "number" } };
    expect(() => assertSemanticBinding(model, binding)).not.toThrow();
    expect(() => assertSemanticBinding(model, { ...binding, aggregation: "max" })).toThrow("不符合模型");
    expect(() => assertSemanticBinding(model, { ...binding, groupBy: "amount" })).toThrow("未定义分组");
    expect(() => assertSemanticBinding(model, { ...binding, dataSourceId: "other_source" })).toThrow("来源表");
    expect(() => assertSemanticPreviewBindings(model, product.appSpec, structuredClone(product.appSpec))).not.toThrow();
    const next = structuredClone(product.appSpec);
    next.pages[0].root.children!.push({ id: "semantic_chart", type: "BarChart", props: { title: "销售额", subtitle: "", binding: { ...binding, aggregation: "max" } } });
    expect(() => assertSemanticPreviewBindings(model, product.appSpec, next)).toThrow("不符合模型");
  });
  it("移除工作界面时清理失效选择，模型与表格一同保留到回退界面", () => {
    const { product, model } = semanticFixture();
    const saved = saveSemanticModel(product, model, "page_home", "editor");
    saved.appSpec.pages.push({ id: "fallback", title: "空白", route: "/fallback", root: { id: "fallback_root", type: "PageRoot", props: {}, children: [] } });
    const spec = { ...saved.appSpec, pages: saved.appSpec.pages.filter((page) => page.id !== "page_home"), navigation: saved.appSpec.navigation.filter((item) => item.pageId !== "page_home") };
    const next = reconcileDataProductWorkspaces(saved, spec);
    expect(next.semanticLayer?.selectedByWorkspace.page_home).toBeUndefined();
    expect(next.semanticLayer?.models).toEqual([model]);
    expect(next.datasets.find((dataset) => dataset.id === model.sourceDatasetId)?.workspaceId).not.toBe("page_home");
  });
  it("兼容旧产品；模型和选择状态进入现有备份，更新保留 ID 并递增版本", () => {
    const { product, model } = semanticFixture();
    expect(dataProductSchema.parse(product)).toEqual(product);
    const saved = saveSemanticModel(product, model, "page_home", "editor");
    const snapshot = createStudioSnapshot(saved, createExecutionState(saved.appSpec), [], []);
    expect(importStudioBackup(exportStudioBackup(snapshot)).dataProduct.semanticLayer).toEqual(saved.semanticLayer);
    const updated = saveSemanticModel(saved, { ...model, name: "新版销售" }, "page_home", "editor");
    expect(updated.semanticLayer?.models[0]).toMatchObject({ id: model.id, version: 2, name: "新版销售" });
    expect(() => saveSemanticModel(updated, model, "page_home", "editor")).toThrow("版本已更新");
    expect(product).not.toHaveProperty("semanticLayer");
  });
  it("创建与删除受角色约束，同名和跨界面创建被拒绝", () => {
    const { product, model } = semanticFixture();
    expect(() => saveSemanticModel(product, model, "page_home", "viewer")).toThrow("无权");
    expect(() => saveSemanticModel(product, model, "other_page", "editor")).toThrow("当前工作界面");
    const saved = saveSemanticModel(product, model, "page_home", "editor");
    expect(() => saveSemanticModel(saved, { ...model, id: "duplicate" }, "page_home", "editor")).toThrow("同名");
    expect(() => deleteSemanticModel(saved, model.id, "viewer")).toThrow("无权");
  });
  it("选择隔离工作界面，切换其他数据表时不携带旧模型", () => {
    const { product, model, source } = semanticFixture();
    const saved = saveSemanticModel(product, model, "page_home", "editor");
    expect(selectedSemanticModel(saved, "page_home", source.id)?.id).toBe(model.id);
    expect(selectedSemanticModel(saved, "page_home", "other_source")).toBeUndefined();
    expect(semanticModelsForWorkspace(saved, "other_page")).toEqual([]);
    expect(() => selectSemanticModel(saved, "other_page", model.id)).toThrow();
    expect(selectedSemanticModel(selectSemanticModel(saved, "page_home", null), "page_home")).toBeUndefined();
  });
  it("删除仅清理定义与选择，不修改数据表、配方或 AppSpec", () => {
    const { product, model } = semanticFixture();
    const next = deleteSemanticModel(saveSemanticModel(product, model, "page_home", "editor"), model.id, "editor");
    expect(next.semanticLayer).toEqual({ models: [], selectedByWorkspace: {} });
    expect(next.datasets).toEqual(product.datasets); expect(next.recipes).toEqual(product.recipes); expect(next.appSpec).toEqual(product.appSpec);
  });
  it("校验不存在的字段、不支持的聚合、重复标识和非法表达式", () => {
    const { model, source } = semanticFixture();
    expect(() => validateSemanticModel({ ...model, measures: [{ ...model.measures[0], field: "missing" }] }, source)).toThrow("已不存在");
    expect(() => validateSemanticModel({ ...model, measures: [{ ...model.measures[0], field: "region" }] }, source)).toThrow("不支持");
    expect(semanticModelSchema.safeParse({ ...model, measures: [{ ...model.measures[0], key: "area" }] }).success).toBe(false);
    expect(semanticModelSchema.safeParse({ ...model, sql: "select *" }).success).toBe(false);
    expect(semanticModelSchema.safeParse({ ...model, measures: [{ ...model.measures[0], key: "constructor" }] }).success).toBe(false);
    expect(semanticLayerSchema.safeParse({ models: [model, model], selectedByWorkspace: {} }).success).toBe(false);
    expect(semanticLayerSchema.safeParse({ models: [model], selectedByWorkspace: { page_home: "unknown" } }).success).toBe(false);
  });
  it("按固定口径计算多指标，整体汇总不重复 SUM；输出保留业务名称和字段血缘", () => {
    const { model, source, rows } = semanticFixture();
    const byArea = executeDataRecipe(compileSemanticQuery(model, source, { dimensions: ["area"], measures: ["revenue", "average_sale"], limit: 100 }), source, rows);
    expect(byArea.success).toBe(true);
    expect(byArea.rows).toEqual([{ area: "华东", revenue: 150, average_sale: 75 }, { area: "华南", revenue: 80, average_sale: 80 }]);
    expect(byArea.fields.find((field) => field.name === "area")?.label).toBe("销售区域");
    expect(byArea.lineage.find((field) => field.field === "revenue")?.sourceFields).toEqual(["amount"]);
    const total = executeDataRecipe(compileSemanticQuery(model, source, { dimensions: [], measures: ["revenue"], limit: 1 }), source, rows);
    expect(total.success).toBe(true); expect(total.rows).toEqual([{ revenue: 230 }]);
    expect(rows).toEqual(semanticFixture().rows);
  });
  it("业务标识与物理字段重名不会产生聚合覆盖", () => {
    const { model, source, rows } = semanticFixture();
    model.measures[0].key = "region";
    const result = executeDataRecipe(compileSemanticQuery(model, source, { dimensions: ["area"], measures: ["region"], limit: 100 }), source, rows);
    expect(result.success).toBe(true); expect(result.rows[0]).toEqual({ area: "华东", region: 150 });
  });
  it("未知成员、自定义聚合和超限查询不能执行，空值仍按 DataRecipe 报错", () => {
    const { model, source, rows } = semanticFixture();
    expect(() => compileSemanticQuery(model, source, { dimensions: [], measures: ["invented"], limit: 100 })).toThrow("未定义指标");
    expect(semanticQuerySchema.safeParse({ dimensions: [], measures: ["revenue"], limit: 100, aggregation: "average" }).success).toBe(false);
    expect(semanticQuerySchema.safeParse({ dimensions: [], measures: ["revenue"], limit: 101 }).success).toBe(false);
    const result = executeDataRecipe(compileSemanticQuery(model, source, { dimensions: [], measures: ["revenue"], limit: 1 }), source, [...rows, { region: "华北", amount: null }]);
    expect(result.success).toBe(false);
  });
});
