import { describe, expect, it } from "vitest";
import type { DataRecipe, DataRecipeStep, DataRow } from "@/core/models";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { retailOrderRows, retailOrdersDataSource } from "@/fixtures/retail-orders";
import { createRecipePreview, executeDataRecipe, recipeWithStepCount } from "./recipe-runtime";

function fixtureRecipe(): DataRecipe {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data.dataProduct.recipes[0]);
}

function recipe(steps: DataRecipeStep[]): DataRecipe {
  return {
    id: "recipe_test",
    name: "测试配方",
    sourceDatasetId: retailOrdersDataSource.id,
    outputDatasetId: "dataset_recipe_test",
    status: "ready",
    steps,
  };
}

describe("DataRecipe 本地执行器与字段血缘", () => {
  it("按顺序执行八种步骤并为每一步生成 Schema、行数和耗时摘要", () => {
    let time = 0;
    const result = executeDataRecipe(fixtureRecipe(), retailOrdersDataSource, retailOrderRows, { clock: () => ++time });
    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(8);
    expect(result.steps.every((step) => step.status === "success" && step.durationMs >= 0)).toBe(true);
    expect(result.steps.map((step) => step.stepType)).toEqual([
      "selectFields",
      "filter",
      "renameField",
      "castField",
      "deriveField",
      "groupAggregate",
      "sort",
      "limit",
    ]);
    expect(result.steps[1]).toMatchObject({ inputRowCount: 48, outputRowCount: 12 });
    expect(result.steps[4].fields.map((field) => field.name)).toContain("revenue_per_anomaly");
    expect(result.rows).toHaveLength(4);
    expect(result.fields.map((field) => field.name)).toEqual([
      "category",
      "total_revenue",
      "average_repurchase_rate",
      "total_anomaly_count",
    ]);
    expect(result.rows[0].total_revenue).toBeTypeOf("number");
    expect(createRecipePreview(result, 2).rows).toHaveLength(2);
  });

  it("追踪聚合输出到原始字段和具体转换步骤", () => {
    const result = executeDataRecipe(fixtureRecipe(), retailOrdersDataSource, retailOrderRows);
    expect(result.success).toBe(true);
    expect(result.lineage.find((lineage) => lineage.field === "total_revenue")).toEqual({
      field: "total_revenue",
      sourceFields: ["revenue"],
      transformations: [expect.objectContaining({ stepId: "aggregate_category", stepType: "groupAggregate" })],
    });
    expect(result.lineage.find((lineage) => lineage.field === "category")?.sourceFields).toEqual(["category"]);
  });

  it("撤销最近步骤只缩短本地配方预览，不修改正式配方", () => {
    const formal = fixtureRecipe();
    const draft = recipeWithStepCount(formal, formal.steps.length - 1);
    expect(draft.steps).toHaveLength(7);
    expect(formal.steps).toHaveLength(8);
    const result = executeDataRecipe(draft, retailOrdersDataSource, retailOrderRows);
    expect(result.success).toBe(true);
    expect(result.steps.at(-1)?.stepType).toBe("sort");
  });

  it("不存在的字段安全失败并定位到对应步骤", () => {
    const result = executeDataRecipe(recipe([
      { id: "filter_missing", type: "filter", field: "missing_field", operator: "equals", value: "x" },
    ]), retailOrdersDataSource, retailOrderRows);
    expect(result).toMatchObject({ success: false, failedStepId: "filter_missing" });
    if (result.success) throw new Error("预期配方失败");
    expect(result.error).toContain("字段不存在");
  });

  it("非法类型转换安全失败且保留转换前结果", () => {
    const result = executeDataRecipe(recipe([
      { id: "cast_order", type: "castField", field: "order_id", to: "number" },
    ]), retailOrdersDataSource, retailOrderRows);
    expect(result).toMatchObject({ success: false, failedStepId: "cast_order", rows: expect.any(Array) });
    if (result.success) throw new Error("预期配方失败");
    expect(result.error).toContain("不能转换为数值");
    expect(result.rows).toEqual(retailOrderRows);
  });

  it("派生字段除零时安全失败", () => {
    const result = executeDataRecipe(recipe([{
      id: "divide_zero",
      type: "deriveField",
      field: "broken_ratio",
      label: "错误比率",
      operator: "divide",
      left: { kind: "field", field: "revenue" },
      right: { kind: "literal", value: 0 },
    }]), retailOrdersDataSource, retailOrderRows);
    expect(result).toMatchObject({ success: false, failedStepId: "divide_zero" });
    if (result.success) throw new Error("预期配方失败");
    expect(result.error).toContain("除零");
  });

  it("输入空值时返回中文错误而不产生部分正式结果", () => {
    const rows: DataRow[] = structuredClone(retailOrderRows);
    rows[0].revenue = null;
    const result = executeDataRecipe(recipe([{
      id: "derive_null",
      type: "deriveField",
      field: "revenue_double",
      label: "双倍收入",
      operator: "multiply",
      left: { kind: "field", field: "revenue" },
      right: { kind: "literal", value: 2 },
    }]), retailOrdersDataSource, rows);
    expect(result).toMatchObject({ success: false, failedStepId: "derive_null" });
    if (result.success) throw new Error("预期配方失败");
    expect(result.error).toContain("包含空值");
  });

  it("重复步骤和重复步骤 ID 在执行前被 Schema 拒绝", () => {
    const duplicateSemantic = executeDataRecipe(recipe([
      { id: "limit_one", type: "limit", count: 3 },
      { id: "limit_two", type: "limit", count: 3 },
    ]), retailOrdersDataSource, retailOrderRows);
    expect(duplicateSemantic.success).toBe(false);
    if (duplicateSemantic.success) throw new Error("预期配方失败");
    expect(duplicateSemantic.error).toContain("语义完全重复");

    const duplicateId = executeDataRecipe(recipe([
      { id: "same_step", type: "limit", count: 3 },
      { id: "same_step", type: "limit", count: 4 },
    ]), retailOrdersDataSource, retailOrderRows);
    expect(duplicateId.success).toBe(false);
    if (duplicateId.success) throw new Error("预期配方失败");
    expect(duplicateId.error).toContain("步骤 ID 不能重复");
  });
});
