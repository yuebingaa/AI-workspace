import { describe, expect, it } from "vitest";
import type { DataRow, DataSourceDefinition } from "@/core/models";
import { analyzeDataSourceFields, createDataPreview } from "./field-analysis";

const source: DataSourceDefinition = {
  id: "source_test",
  name: "测试数据",
  rowCount: 25,
  columnCount: 2,
  qualityScore: 90,
  updatedAt: "2026-08-31T00:00:00.000Z",
  sourceType: "local-fixture",
  fields: [
    { name: "amount", label: "金额", type: "number", aggregatable: true, supportedAggregations: ["none", "sum", "average", "count", "countDistinct", "min", "max"] },
    { name: "region", label: "区域", type: "string", aggregatable: false, supportedAggregations: ["none", "count", "countDistinct"] },
  ],
};

describe("字段分析与数据预览", () => {
  it("计算数值字段最小值、最大值和平均值", () => {
    const rows: DataRow[] = [{ amount: 10, region: "华东" }, { amount: 20, region: "华南" }, { amount: 30, region: "华东" }];
    const amount = analyzeDataSourceFields(source, rows).find((field) => field.field === "amount")!;
    expect(amount).toMatchObject({ minimum: 10, maximum: 30, average: 20, uniqueCount: 3, nullCount: 0 });
  });

  it("统计文本唯一值、空值数量和比例", () => {
    const rows: DataRow[] = [{ amount: 10, region: "华东" }, { amount: null, region: "华东" }, { amount: 30, region: null }, { amount: null, region: "华南" }];
    const analyses = analyzeDataSourceFields(source, rows);
    expect(analyses.find((field) => field.field === "region")).toMatchObject({ uniqueCount: 2, nullCount: 1, nullRatio: 0.25, samples: ["华东", "华南"] });
    expect(analyses.find((field) => field.field === "amount")).toMatchObject({ nullCount: 2, nullRatio: 0.5, average: 20 });
  });

  it("数据预览最多返回 20 行并支持字段隐藏", () => {
    const rows: DataRow[] = Array.from({ length: 25 }, (_, index) => ({ amount: index, region: `区域${index}` }));
    const preview = createDataPreview(source, rows, ["region"], 100);
    expect(preview.fields).toEqual(["region"]);
    expect(preview.rows).toHaveLength(20);
    expect(preview.rows[0]).toEqual({ region: "区域0" });
  });
});
