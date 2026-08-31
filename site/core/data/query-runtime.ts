import type {
  DataAggregation,
  DataBinding,
  DataColumnBinding,
  DataFormat,
  DataRow,
  DataSourceDefinition,
  DataValue,
  LocalDataRuntime,
  QueryComponentKind,
  QueryExecutionRecord,
} from "@/core/models";
import { StudioValidationError } from "@/core/schemas";

export interface MetricBindingResult { rawValue: DataValue; value: string }
export interface ChartBindingResult { labels: string[]; values: number[]; yAxis: string[] }
export interface TableBindingResult {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string>>;
}

export const MAX_QUERY_EXECUTION_RECORDS = 100;

export type RecordedQueryResult<T> =
  | { success: true; result: T; record: QueryExecutionRecord }
  | { success: false; error: Error; record: QueryExecutionRecord };

let querySequence = 0;

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function appendQueryExecutionRecord(
  records: QueryExecutionRecord[],
  record: QueryExecutionRecord,
  limit = MAX_QUERY_EXECUTION_RECORDS,
): QueryExecutionRecord[] {
  return [record, ...records].slice(0, Math.max(1, limit));
}

export function summarizeBinding(binding: DataBinding, sourceName?: string): string {
  const parts = [
    `数据源 ${sourceName ?? binding.dataSourceId}`,
    `${binding.field} · ${binding.aggregation}`,
  ];
  if (binding.groupBy) parts.push(`按 ${binding.groupBy} 分组`);
  if (binding.filters.length) parts.push(`${binding.filters.length} 个筛选条件`);
  return parts.join("；");
}

export function createExecutionPlanSummary(binding: DataBinding, inputRows: number): string {
  const steps = [`扫描 ${inputRows} 行`];
  if (binding.filters.length) steps.push(`应用 ${binding.filters.length} 个筛选条件`);
  if (binding.groupBy) steps.push(`按 ${binding.groupBy} 分组并执行 ${binding.aggregation}`);
  else steps.push(`执行 ${binding.aggregation} 聚合`);
  if (binding.sort.length) steps.push(`按 ${binding.sort.map((item) => `${item.field} ${item.direction}`).join("、")} 排序`);
  steps.push(`最多输出 ${binding.limit} 行`);
  return steps.join(" → ");
}

function sourceFor(
  binding: DataBinding,
  dataSources: DataSourceDefinition[],
  runtime: LocalDataRuntime,
): { source: DataSourceDefinition; rows: DataRow[] } {
  const source = dataSources.find((item) => item.id === binding.dataSourceId);
  if (!source) throw new StudioValidationError("数据绑定运行失败", [`数据源不存在：${binding.dataSourceId}`]);
  const rows = runtime.rowsByDataSourceId[source.id];
  if (!rows) throw new StudioValidationError("数据绑定运行失败", [`数据源“${source.name}”没有可用的本地行数据`]);
  const availableFields = new Set(source.fields.map((field) => field.name));
  const referencedFields = [
    binding.field,
    binding.groupBy,
    ...binding.filters.map((filter) => filter.field),
    ...binding.sort.map((sort) => sort.field),
    ...(binding.columns?.map((column) => column.field) ?? []),
  ].filter((field): field is string => Boolean(field));
  const missing = [...new Set(referencedFields.filter((field) => !availableFields.has(field)))];
  if (missing.length) throw new StudioValidationError("数据绑定运行失败", [`字段不存在：${missing.join("、")}`]);
  return { source, rows };
}

function compare(left: DataValue, right: DataValue): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right), "zh-CN", { numeric: true });
}

function matchesFilter(value: DataValue, operator: DataBinding["filters"][number]["operator"], expected: string | number | boolean) {
  switch (operator) {
    case "equals": return value === expected;
    case "notEquals": return value !== expected;
    case "contains": return String(value ?? "").includes(String(expected));
    case "greaterThan": return compare(value, expected) > 0;
    case "greaterThanOrEqual": return compare(value, expected) >= 0;
    case "lessThan": return compare(value, expected) < 0;
    case "lessThanOrEqual": return compare(value, expected) <= 0;
  }
}

function prepareRows(binding: DataBinding, rows: DataRow[]): DataRow[] {
  const filtered = rows.filter((row) => binding.filters.every((filter) => (
    matchesFilter(row[filter.field] ?? null, filter.operator, filter.value)
  )));
  return filtered.sort((left, right) => {
    for (const sort of binding.sort) {
      const result = compare(left[sort.field] ?? null, right[sort.field] ?? null);
      if (result) return sort.direction === "asc" ? result : -result;
    }
    return 0;
  });
}

export function aggregateValues(rows: DataRow[], field: string, aggregation: DataAggregation): DataValue {
  if (aggregation === "count") return rows.length;
  const values = rows.map((row) => row[field]).filter((value): value is Exclude<DataValue, null> => value !== null && value !== undefined);
  if (aggregation === "countDistinct") return new Set(values.map((value) => `${typeof value}:${String(value)}`)).size;
  if (aggregation === "none") return values[0] ?? null;
  if (!values.length) return null;
  if (aggregation === "min") return values.reduce((result, value) => compare(value, result) < 0 ? value : result);
  if (aggregation === "max") return values.reduce((result, value) => compare(value, result) > 0 ? value : result);
  const numbers = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (numbers.length !== values.length) {
    throw new StudioValidationError("数据绑定运行失败", [`字段“${field}”包含不能用于 ${aggregation} 的非数值数据`]);
  }
  const sum = numbers.reduce((total, value) => total + value, 0);
  return aggregation === "average" ? sum / numbers.length : sum;
}

export function formatDataValue(value: DataValue, format: DataFormat): string {
  if (value === null) return "—";
  if (typeof value !== "number" || format.style === "text" || format.style === "auto") {
    return `${format.prefix ?? ""}${String(value)}${format.suffix ?? ""}`;
  }
  const fractionDigits = format.decimals ?? (format.style === "percent" ? 1 : 0);
  let formatted: string;
  if (format.style === "currency") {
    formatted = new Intl.NumberFormat("zh-CN", {
      style: "currency",
      currency: format.currency ?? "CNY",
      notation: format.notation ?? "standard",
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  } else if (format.style === "percent") {
    formatted = new Intl.NumberFormat("zh-CN", {
      style: "percent",
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  } else {
    formatted = new Intl.NumberFormat("zh-CN", {
      notation: format.notation ?? "standard",
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(value);
  }
  return `${format.prefix ?? ""}${formatted}${format.suffix ?? ""}`;
}

export function executeMetricBinding(
  binding: DataBinding,
  dataSources: DataSourceDefinition[],
  runtime: LocalDataRuntime,
): MetricBindingResult {
  const { rows } = sourceFor(binding, dataSources, runtime);
  const rawValue = aggregateValues(prepareRows(binding, rows), binding.field, binding.aggregation);
  return { rawValue, value: formatDataValue(rawValue, binding.format) };
}

function groupedRows(rows: DataRow[], groupBy: string): Array<[string, DataRow[]]> {
  const groups = new Map<string, DataRow[]>();
  for (const row of rows) {
    const key = String(row[groupBy] ?? "未分类");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()];
}

export function executeChartBinding(
  binding: DataBinding,
  dataSources: DataSourceDefinition[],
  runtime: LocalDataRuntime,
): ChartBindingResult {
  const { rows } = sourceFor(binding, dataSources, runtime);
  if (!binding.groupBy) throw new StudioValidationError("图表数据绑定失败", ["柱状图缺少分组字段"]);
  const groups = groupedRows(prepareRows(binding, rows), binding.groupBy).slice(0, binding.limit);
  const labels = groups.map(([label]) => label.replace(/^0(?=\d月$)/, ""));
  const values = groups.map(([, group]) => {
    const value = aggregateValues(group, binding.field, binding.aggregation);
    if (typeof value !== "number") throw new StudioValidationError("图表数据绑定失败", ["聚合结果不是数值"]);
    return value;
  });
  const maximum = Math.max(...values, 0);
  const yAxis = [1, 0.75, 0.5, 0.25, 0].map((ratio) => formatDataValue(maximum * ratio, binding.format));
  return { labels, values, yAxis };
}

function columnValue(rows: DataRow[], column: DataColumnBinding): DataValue {
  return aggregateValues(rows, column.field, column.aggregation);
}

export function executeTableBinding(
  binding: DataBinding,
  dataSources: DataSourceDefinition[],
  runtime: LocalDataRuntime,
): TableBindingResult {
  const { source, rows } = sourceFor(binding, dataSources, runtime);
  if (!binding.columns?.length) throw new StudioValidationError("表格数据绑定失败", ["至少需要选择一个表格列"]);
  const prepared = prepareRows(binding, rows);
  const groups = binding.groupBy ? groupedRows(prepared, binding.groupBy) : prepared.map((row, index) => [`row_${index}`, [row]] as [string, DataRow[]]);
  const computed = groups.map(([, group]) => Object.fromEntries(binding.columns!.map((column) => [
    column.field,
    column.field === binding.groupBy && column.aggregation === "none"
      ? group[0][column.field]
      : columnValue(group, column),
  ])));
  computed.sort((left, right) => {
    for (const sort of binding.sort) {
      const result = compare(left[sort.field] ?? null, right[sort.field] ?? null);
      if (result) return sort.direction === "asc" ? result : -result;
    }
    return 0;
  });
  const columns = binding.columns.map((column) => ({
    key: column.field,
    label: column.label ?? source.fields.find((field) => field.name === column.field)?.label ?? column.field,
  }));
  return {
    columns,
    rows: computed.slice(0, binding.limit).map((row) => Object.fromEntries(binding.columns!.map((column) => [
      column.field,
      formatDataValue(row[column.field] ?? null, column.format),
    ]))),
  };
}

interface BindingResultMap {
  metric: MetricBindingResult;
  chart: ChartBindingResult;
  table: TableBindingResult;
}

export function executeRecordedBinding<TKind extends QueryComponentKind>(
  kind: TKind,
  binding: DataBinding,
  dataSources: DataSourceDefinition[],
  runtime: LocalDataRuntime,
  context: { componentId: string; pageId: string; revision?: string },
  clock: () => Date = () => new Date(),
): RecordedQueryResult<BindingResultMap[TKind]> {
  const started = clock();
  const source = dataSources.find((item) => item.id === binding.dataSourceId);
  const inputRowCount = runtime.rowsByDataSourceId[binding.dataSourceId]?.length ?? 0;
  const executionKey = context.revision
    ? `${context.pageId}:${context.componentId}:${context.revision}:${stableHash(JSON.stringify(binding))}`
    : null;
  const common = {
    id: executionKey ? `query_${stableHash(executionKey)}` : `query_${started.getTime()}_${++querySequence}`,
    componentId: context.componentId,
    pageId: context.pageId,
    componentKind: kind,
    dataSourceId: binding.dataSourceId,
    bindingSummary: summarizeBinding(binding, source?.name),
    planSummary: createExecutionPlanSummary(binding, inputRowCount),
    startedAt: started.toISOString(),
    inputRowCount,
  };
  try {
    const result = (
      kind === "metric"
        ? executeMetricBinding(binding, dataSources, runtime)
        : kind === "chart"
          ? executeChartBinding(binding, dataSources, runtime)
          : executeTableBinding(binding, dataSources, runtime)
    ) as BindingResultMap[TKind];
    const completed = clock();
    const outputRowCount = kind === "metric"
      ? 1
      : kind === "chart"
        ? (result as ChartBindingResult).labels.length
        : (result as TableBindingResult).rows.length;
    return {
      success: true,
      result,
      record: {
        ...common,
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        outputRowCount,
        status: "success",
      },
    };
  } catch (caught) {
    const completed = clock();
    const error = caught instanceof Error ? caught : new Error("未知查询错误");
    return {
      success: false,
      error,
      record: {
        ...common,
        completedAt: completed.toISOString(),
        durationMs: Math.max(0, completed.getTime() - started.getTime()),
        outputRowCount: 0,
        status: "failure",
        error: error.message,
      },
    };
  }
}

export function validateRuntimeRows(source: DataSourceDefinition, rows: DataRow[]): void {
  const issues: string[] = [];
  rows.forEach((row, rowIndex) => {
    for (const field of source.fields) {
      const value = row[field.name];
      if (value === null) continue;
      const valid = field.type === "date"
        ? typeof value === "string" && !Number.isNaN(Date.parse(value))
        : typeof value === field.type;
      if (!valid) issues.push(`第 ${rowIndex + 1} 行字段“${field.label}”类型应为 ${field.type}`);
    }
  });
  if (issues.length) throw new StudioValidationError("本地数据 fixture 校验失败", issues.slice(0, 10));
}
