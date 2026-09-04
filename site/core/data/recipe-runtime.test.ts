import { describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { DataRecipe, DataRecipeStep, DataRow } from "@/core/models";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { retailOrderRows, retailOrdersDataSource } from "@/fixtures/retail-orders";
import { createRecipePreview, executeDataRecipe, MAX_RECIPE_PREVIEW_ROWS, recipeWithStepCount } from "./recipe-runtime";

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

  it("计时异常不覆盖配方成功或业务失败结果", () => {
    let successClockCalls = 0;
    const success = executeDataRecipe(recipe([
      { id: "limit_clock_failure", type: "limit", count: 2 },
    ]), retailOrdersDataSource, retailOrderRows, {
      clock: () => {
        const value: number | Error | undefined = [0, 1, new Error("synthetic clock failure"), 2][successClockCalls++];
        if (value instanceof Error) throw value;
        return value ?? Number.NaN;
      },
    });
    expect(success).toMatchObject({
      success: true,
      steps: [{ stepId: "limit_clock_failure", status: "success", durationMs: 0 }],
      totalDurationMs: 2,
    });
    expect(success.rows).toHaveLength(2);
    expect(successClockCalls).toBe(4);

    let failureClockCalls = 0;
    const failure = executeDataRecipe(recipe([
      { id: "missing_field_clock_failure", type: "filter", field: "missing_field", operator: "equals", value: "x" },
    ]), retailOrdersDataSource, retailOrderRows, {
      clock: () => [0, 1, Number.POSITIVE_INFINITY, 2][failureClockCalls++] ?? Number.NaN,
    });
    expect(failure).toMatchObject({
      success: false,
      failedStepId: "missing_field_clock_failure",
      steps: [{ status: "failure", durationMs: 0 }],
      totalDurationMs: 2,
    });
    if (failure.success) throw new Error("预期配方失败");
    expect(failure.error).toContain("字段不存在");
    expect(failureClockCalls).toBe(4);
  });

  it("拒绝非法起始计时且正常边界只采样一次", () => {
    expect(() => executeDataRecipe(fixtureRecipe(), retailOrdersDataSource, retailOrderRows, {
      clock: () => Number.NaN,
    })).toThrow(/数据配方计时时钟无效/);

    const clock = (() => {
      const values = [0, 10, 15, 20];
      return vi.fn(() => values.shift() ?? Number.NaN);
    })();
    const result = executeDataRecipe(recipe([
      { id: "limit_exact_timing", type: "limit", count: 1 },
    ]), retailOrdersDataSource, retailOrderRows, { clock });
    expect(result).toMatchObject({ success: true, steps: [{ durationMs: 5 }], totalDurationMs: 20 });
    expect(clock).toHaveBeenCalledTimes(4);
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

  it("日期转换拒绝无效月末而不静默滚动", () => {
    const rows: DataRow[] = structuredClone(retailOrderRows);
    rows[0].order_date = "2026-02-31";
    const result = executeDataRecipe(recipe([
      { id: "cast_invalid_date", type: "castField", field: "order_date", to: "date" },
    ]), retailOrdersDataSource, rows);

    expect(result).toMatchObject({ success: false, failedStepId: "cast_invalid_date" });
    if (result.success) throw new Error("预期配方失败");
    expect(result.error).toContain("不是有效日期");
    expect(result.rows).toEqual(rows);
  });

  it("聚合拒绝溢出求和且大数平均保持有限", () => {
    const rows: DataRow[] = structuredClone(retailOrderRows).slice(0, 2);
    rows.forEach((row) => { row.region = "虚构大数区域"; row.revenue = Number.MAX_VALUE; });
    const sum = executeDataRecipe(recipe([{
      id: "overflow_sum",
      type: "groupAggregate",
      groupBy: ["region"],
      aggregations: [{ field: "revenue", aggregation: "sum", as: "total_revenue", label: "总收入" }],
    }]), retailOrdersDataSource, rows);
    expect(sum).toMatchObject({ success: false, failedStepId: "overflow_sum" });
    if (sum.success) throw new Error("预期求和失败");
    expect(sum.error).toContain("无效数值");

    const average = executeDataRecipe(recipe([{
      id: "finite_average",
      type: "groupAggregate",
      groupBy: ["region"],
      aggregations: [{ field: "revenue", aggregation: "average", as: "average_revenue", label: "平均收入" }],
    }]), retailOrdersDataSource, rows);
    expect(average.success).toBe(true);
    expect(average.rows[0].average_revenue).toBe(Number.MAX_VALUE);
  });

  it("五万行单组聚合只创建一次分组并保持输入不变", () => {
    const rows: DataRow[] = Array.from({ length: 50_000 }, (_, index) => ({
      ...retailOrderRows[0],
      order_id: `bulk_order_${index}`,
      region: "单组",
      revenue: 1,
    }));
    const originalFirst = structuredClone(rows[0]);
    const originalLast = structuredClone(rows.at(-1));
    const mapSet = vi.spyOn(Map.prototype, "set");
    const result = executeDataRecipe(recipe([{
      id: "large_single_group",
      type: "groupAggregate",
      groupBy: ["region"],
      aggregations: [
        { field: "revenue", aggregation: "count", as: "row_count", label: "行数" },
        { field: "revenue", aggregation: "sum", as: "total_revenue", label: "总收入" },
        { field: "revenue", aggregation: "average", as: "average_revenue", label: "平均收入" },
      ],
    }]), retailOrdersDataSource, rows);
    const groupCreationCount = mapSet.mock.calls.filter(([key]) => key === '["单组"]').length;
    mapSet.mockRestore();

    expect(result.success).toBe(true);
    expect(result.rows).toEqual([{ region: "单组", row_count: 50_000, total_revenue: 50_000, average_revenue: 1 }]);
    expect(groupCreationCount).toBe(1);
    expect(rows[0]).toEqual(originalFirst);
    expect(rows.at(-1)).toEqual(originalLast);
    expect(rows).toHaveLength(50_000);
  });

  it.each([
    ["NaN", Number.NaN, "min" as const],
    ["正无穷", Number.POSITIVE_INFINITY, "max" as const],
    ["负无穷", Number.NEGATIVE_INFINITY, "min" as const],
  ])("聚合在具体步骤拒绝%s", (_label, invalid, aggregation) => {
    const rows: DataRow[] = structuredClone(retailOrderRows).slice(0, 1);
    rows[0].revenue = invalid;
    const result = executeDataRecipe(recipe([{
      id: "invalid_numeric_aggregate",
      type: "groupAggregate",
      groupBy: ["region"],
      aggregations: [{ field: "revenue", aggregation, as: "invalid_value", label: "无效值" }],
    }]), retailOrdersDataSource, rows);

    expect(result).toMatchObject({ success: false, failedStepId: "invalid_numeric_aggregate" });
    if (result.success) throw new Error("预期聚合失败");
    expect(result.error).toContain("非有限数值");
  });

  it("配方预览行数只允许收紧而不能放宽全局上限", () => {
    const result = executeDataRecipe(fixtureRecipe(), retailOrdersDataSource, retailOrderRows);
    expect(result.success).toBe(true);
    expect(createRecipePreview(result, 1).rows).toHaveLength(1);
    expect(() => createRecipePreview(result, 0)).toThrow(/预览限制无效/);
    expect(() => createRecipePreview(result, 1.5)).toThrow(/预览限制无效/);
    expect(() => createRecipePreview(result, MAX_RECIPE_PREVIEW_ROWS + 1)).toThrow(/预览限制无效/);
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
