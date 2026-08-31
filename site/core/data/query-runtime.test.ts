import { describe, expect, it } from "vitest";
import type { DataBinding, DataRow } from "@/core/models";
import { demoLocalDataRuntime, retailOrdersDataSource } from "@/fixtures/retail-orders";
import {
  aggregateValues,
  executeChartBinding,
  executeMetricBinding,
  executeTableBinding,
} from "./query-runtime";

function binding(overrides: Partial<DataBinding> = {}): DataBinding {
  return {
    dataSourceId: retailOrdersDataSource.id,
    field: "revenue",
    aggregation: "sum",
    groupBy: null,
    filters: [],
    sort: [],
    limit: 12,
    format: { style: "number", decimals: 0 },
    ...overrides,
  };
}

describe("本地数据查询运行时", () => {
  it("支持数值聚合与去重计数", () => {
    const rows: DataRow[] = [{ value: 10, customer: "a" }, { value: 20, customer: "a" }, { value: 30, customer: "b" }];
    expect(aggregateValues(rows, "value", "sum")).toBe(60);
    expect(aggregateValues(rows, "value", "average")).toBe(20);
    expect(aggregateValues(rows, "value", "count")).toBe(3);
    expect(aggregateValues(rows, "value", "min")).toBe(10);
    expect(aggregateValues(rows, "value", "max")).toBe(30);
    expect(aggregateValues(rows, "customer", "countDistinct")).toBe(2);
  });

  it("指标卡绑定从 fixture 计算展示值", () => {
    const result = executeMetricBinding(
      binding({ format: { style: "currency", currency: "CNY", notation: "compact", decimals: 1 } }),
      [retailOrdersDataSource],
      demoLocalDataRuntime,
    );
    expect(result.rawValue).toBeCloseTo(3_248_000);
    expect(result.value).toContain("324.8万");
  });

  it("柱状图绑定按月份分组统计", () => {
    const result = executeChartBinding(
      binding({ groupBy: "month", sort: [{ field: "month", direction: "asc" }] }),
      [retailOrdersDataSource],
      demoLocalDataRuntime,
    );
    expect(result.labels).toHaveLength(12);
    expect(result.labels[0]).toBe("1月");
    expect(result.values.reduce((total, value) => total + value, 0)).toBeCloseTo(3_248_000);
  });

  it("表格列绑定支持分组、排序和数量限制", () => {
    const result = executeTableBinding(binding({
      groupBy: "region",
      sort: [{ field: "revenue", direction: "desc" }],
      limit: 3,
      columns: [
        { field: "region", aggregation: "none", format: { style: "text" } },
        { field: "revenue", aggregation: "sum", format: { style: "number", decimals: 0 } },
      ],
    }), [retailOrdersDataSource], demoLocalDataRuntime);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({ region: "华东", revenue: "1,248,600" });
  });

  it("支持基本筛选、排序和限制", () => {
    const result = executeTableBinding(binding({
      filters: [{ field: "region", operator: "equals", value: "华东" }],
      sort: [{ field: "revenue", direction: "desc" }],
      limit: 2,
      columns: [
        { field: "order_id", aggregation: "none", format: { style: "text" } },
        { field: "region", aggregation: "none", format: { style: "text" } },
        { field: "revenue", aggregation: "none", format: { style: "number", decimals: 0 } },
      ],
    }), [retailOrdersDataSource], demoLocalDataRuntime);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.region === "华东")).toBe(true);
    expect(Number(result.rows[0].revenue.replaceAll(",", ""))).toBeGreaterThan(Number(result.rows[1].revenue.replaceAll(",", "")));
  });

  it("拒绝不存在的数据源或字段", () => {
    expect(() => executeMetricBinding(binding({ dataSourceId: "missing" }), [retailOrdersDataSource], demoLocalDataRuntime)).toThrow(/数据源不存在/);
    expect(() => executeMetricBinding(binding({ field: "missing" }), [retailOrdersDataSource], demoLocalDataRuntime)).toThrow(/字段不存在/);
  });
});
