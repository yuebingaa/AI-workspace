import { describe, expect, it } from "vitest";
import type { DataBinding, DataRow } from "@/core/models";
import { dataBindingSchema } from "@/core/schemas";
import { demoLocalDataRuntime, retailOrdersDataSource } from "@/fixtures/retail-orders";
import {
  aggregateValues,
  executeChartBinding,
  executeMetricBinding,
  executeTableBinding,
  executeRecordedBinding,
  appendQueryExecutionRecord,
  validateRuntimeRows,
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

  it("拒绝溢出求和且大数平均保持有限", () => {
    const rows: DataRow[] = [{ value: Number.MAX_VALUE }, { value: Number.MAX_VALUE }];
    expect(() => aggregateValues(rows, "value", "sum")).toThrow(/无效数值/);
    expect(aggregateValues(rows, "value", "average")).toBe(Number.MAX_VALUE);
    expect(() => aggregateValues([{ value: Number.NaN }], "value", "min")).toThrow(/非有限数值/);
    expect(() => aggregateValues([{ value: Number.POSITIVE_INFINITY }], "value", "max")).toThrow(/非有限数值/);
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

  it("分组图表按聚合结果排序而不是按单行极值排序", () => {
    const result = executeChartBinding(
      binding({ groupBy: "region", sort: [{ field: "revenue", direction: "desc" }] }),
      [retailOrdersDataSource],
      { rowsByDataSourceId: { [retailOrdersDataSource.id]: [
        { region: "虚构 A", revenue: 60 },
        { region: "虚构 A", revenue: 60 },
        { region: "虚构 B", revenue: 100 },
      ] } },
    );
    expect(result.labels).toEqual(["虚构 A", "虚构 B"]);
    expect(result.values).toEqual([120, 100]);
  });

  it("空分组与字面未分类使用不同的类型键和可辨识标签", () => {
    const result = executeChartBinding(
      binding({ groupBy: "region" }),
      [retailOrdersDataSource],
      { rowsByDataSourceId: { [retailOrdersDataSource.id]: [
        { region: null, revenue: 10 },
        { region: "未分类", revenue: 20 },
      ] } },
    );
    expect(result.labels).toEqual(["（空值）", "未分类"]);
    expect(result.values).toEqual([10, 20]);
  });

  it.each([
    ["全正", [10, 20], { minimum: 0, maximum: 20 }],
    ["全负", [-10, -20], { minimum: -20, maximum: 0 }],
    ["跨零", [-10, 20], { minimum: -10, maximum: 20 }],
    ["全零", [0, 0], { minimum: 0, maximum: 1 }],
  ])("柱状图为%s值生成包含零点的有限坐标域", (_label, values, expectedDomain) => {
    const result = executeChartBinding(
      binding({ groupBy: "region", sort: [{ field: "region", direction: "asc" }] }),
      [retailOrdersDataSource],
      { rowsByDataSourceId: { [retailOrdersDataSource.id]: values.map((revenue, index) => ({ region: `区域${index}`, revenue })) } },
    );
    expect(result.domain).toEqual(expectedDomain);
    expect(result.yAxis).toHaveLength(5);
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

  it("Schema 与运行时都拒绝会互相覆盖的重复表格字段", () => {
    const duplicate = binding({
      columns: [
        { field: "revenue", label: "收入总计", aggregation: "sum", format: { style: "number" } },
        { field: "revenue", label: "收入均值", aggregation: "average", format: { style: "number" } },
      ],
    });

    expect(dataBindingSchema.safeParse(duplicate).success).toBe(false);
    expect(() => executeTableBinding(duplicate, [retailOrdersDataSource], demoLocalDataRuntime)).toThrow(/列字段不能重复/);
  });

  it("分组表格按隐藏主度量的聚合值排序而不是单行极值", () => {
    const result = executeTableBinding(binding({
      groupBy: "region",
      sort: [{ field: "revenue", direction: "desc" }],
      columns: [{ field: "region", aggregation: "none", format: { style: "text" } }],
    }), [retailOrdersDataSource], { rowsByDataSourceId: { [retailOrdersDataSource.id]: [
      { region: "虚构 A", revenue: 60 },
      { region: "虚构 A", revenue: 60 },
      { region: "虚构 B", revenue: 100 },
    ] } });

    expect(result.rows).toEqual([{ region: "虚构 A" }, { region: "虚构 B" }]);
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

  it("生成查询成功和失败执行记录", () => {
    const times = [new Date("2026-08-31T00:00:00.000Z"), new Date("2026-08-31T00:00:00.007Z")];
    const success = executeRecordedBinding("metric", binding(), [retailOrdersDataSource], demoLocalDataRuntime, { componentId: "metric_1", pageId: "page_1" }, () => times.shift()!);
    expect(success.success).toBe(true);
    expect(success.record).toMatchObject({ status: "success", componentId: "metric_1", pageId: "page_1", inputRowCount: 48, outputRowCount: 1, durationMs: 7 });
    expect(success.record.planSummary).toMatch(/扫描 48 行/);

    const failureTimes = [new Date("2026-08-31T00:00:01.000Z"), new Date("2026-08-31T00:00:01.003Z")];
    const failure = executeRecordedBinding("metric", binding({ field: "missing" }), [retailOrdersDataSource], demoLocalDataRuntime, { componentId: "metric_bad", pageId: "page_1" }, () => failureTimes.shift()!);
    expect(failure.success).toBe(false);
    expect(failure.record).toMatchObject({ status: "failure", outputRowCount: 0, durationMs: 3 });
    expect(failure.record.error).toMatch(/字段不存在/);
  });

  it("计时失败不覆盖查询结果或原始业务错误", () => {
    const started = new Date("2026-08-31T00:00:00.000Z");
    let successClockCalls = 0;
    const success = executeRecordedBinding(
      "metric",
      binding(),
      [retailOrdersDataSource],
      demoLocalDataRuntime,
      { componentId: "metric_clock_success", pageId: "page_1" },
      () => successClockCalls++ === 0 ? started : new Date(Number.NaN),
    );
    expect(success.success).toBe(true);
    expect(success.record).toMatchObject({
      status: "success",
      startedAt: started.toISOString(),
      completedAt: started.toISOString(),
      durationMs: 0,
    });
    expect(successClockCalls).toBe(2);

    let failureClockCalls = 0;
    const failure = executeRecordedBinding(
      "metric",
      binding({ field: "missing" }),
      [retailOrdersDataSource],
      demoLocalDataRuntime,
      { componentId: "metric_clock_failure", pageId: "page_1" },
      () => {
        failureClockCalls += 1;
        if (failureClockCalls === 1) return started;
        throw new Error("synthetic clock failure");
      },
    );
    expect(failure.success).toBe(false);
    expect(failure.record.error).toMatch(/字段不存在/);
    expect(failure.record).toMatchObject({ completedAt: started.toISOString(), durationMs: 0 });
    expect(failureClockCalls).toBe(2);

    expect(() => executeRecordedBinding(
      "metric",
      binding(),
      [retailOrdersDataSource],
      demoLocalDataRuntime,
      { componentId: "metric_clock_invalid", pageId: "page_1" },
      () => new Date(Number.NaN),
    )).toThrow(/查询时钟必须返回有效 Date/);
  });

  it("限制查询执行记录数量", () => {
    const makeRecord = (index: number) => executeRecordedBinding("metric", binding(), [retailOrdersDataSource], demoLocalDataRuntime, { componentId: `metric_${index}`, pageId: "page_1" }).record;
    const records = [0, 1, 2].reduce((current, index) => appendQueryExecutionRecord(current, makeRecord(index), 2), [] as ReturnType<typeof makeRecord>[]);
    expect(records).toHaveLength(2);
    expect(records[0].componentId).toBe("metric_2");
    const record = makeRecord(3);
    expect(() => appendQueryExecutionRecord(records, record, 0)).toThrow(/记录限制无效/);
    expect(() => appendQueryExecutionRecord(records, record, 1.5)).toThrow(/记录限制无效/);
    expect(() => appendQueryExecutionRecord(records, record, 101)).toThrow(/记录限制无效/);
  });

  it("fixture 日期校验拒绝无效月末并保留合法闰日与时间戳", () => {
    const dateSource = {
      ...retailOrdersDataSource,
      fields: retailOrdersDataSource.fields.filter((field) => field.name === "order_date"),
    };

    expect(() => validateRuntimeRows(dateSource, [{ order_date: "2026-02-29" }])).toThrow(/fixture 校验失败/);
    expect(() => validateRuntimeRows(dateSource, [{ order_date: "2028-02-29" }])).not.toThrow();
    expect(() => validateRuntimeRows(dateSource, [{ order_date: "2026-09-02T08:30:00.000Z" }])).not.toThrow();
  });

  it("fixture 数值校验拒绝 NaN 与无穷值", () => {
    const numberSource = {
      ...retailOrdersDataSource,
      fields: retailOrdersDataSource.fields.filter((field) => field.name === "revenue"),
    };

    expect(() => validateRuntimeRows(numberSource, [{ revenue: Number.NaN }])).toThrow(/fixture 校验失败/);
    expect(() => validateRuntimeRows(numberSource, [{ revenue: Number.POSITIVE_INFINITY }])).toThrow(/fixture 校验失败/);
    expect(() => validateRuntimeRows(numberSource, [{ revenue: Number.NEGATIVE_INFINITY }])).toThrow(/fixture 校验失败/);
  });
});
