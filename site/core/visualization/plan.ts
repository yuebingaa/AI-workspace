import type { DataTable } from "@/core/datasets/table-contracts";
import { isVisualizationDate, parseChartDefinitionV2, type ChartDefinitionV2 } from "./definition";

export const VISUAL_INPUT_TABLE = "visual_input";
const ordinal = "viz_input_order";
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string | number | boolean) => typeof value === "string" ? `'${value.replaceAll("'", "''")}'` : String(value);
const aggregateSql = { sum: "SUM", mean: "AVG", min: "MIN", max: "MAX", median: "MEDIAN", count: "COUNT", distinctCount: "COUNT" } as const;
export type VisualizationNumericMode = "safe-integer" | "float64";
export interface VisualizationPlan {
  sql: string; fields: DataTable["fields"]; inputFields: DataTable["fields"];
  inputOrder: boolean; numericMode: VisualizationNumericMode;
}

/** Pure whitelist compiler over typed, complete input. No credentials, fetching or execution. */
export function compileVisualization(value: ChartDefinitionV2, table: DataTable): VisualizationPlan {
  const definition = parseChartDefinitionV2(value), { data } = definition;
  if (table.truncated) throw Error("不能对不完整输入计算正式图表；请先在上游筛选或汇总。");
  const fields = new Map(table.fields.map(field => [field.name, field]));
  if (fields.size !== table.fields.length || new Set(table.fields.map(field => field.name.toLowerCase())).size !== fields.size) throw Error("输入字段名称重复或大小写冲突。");
  const selected = new Set([...data.dimensions.map(item => item.field), ...data.measures.flatMap(item => item.field === null ? [] : [item.field]), ...data.filters.map(item => item.field)]);
  if ([...selected].some(name => !fields.has(name) || name.toLowerCase() === ordinal)) throw Error("引用字段不存在或使用了保留名称。");
  for (const name of selected) for (const row of table.rows) {
    if (!Object.hasOwn(row, name)) throw Error("输入行缺少已声明字段；不能将缺失值默认为 NULL。");
    const field = fields.get(name)!, value = row[name];
    if (value === null) continue;
    if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw Error("数值超过安全绘图范围或类型不匹配；精确大数请保留原始表格。");
    if (field.type === "boolean" && typeof value !== "boolean") throw Error("布尔字段类型不匹配。");
    if (field.type === "string" && typeof value !== "string") throw Error("文本字段类型不匹配。");
    if (field.type === "date" && !isVisualizationDate(value)) throw Error("日期字段仅支持纯日期或导入器的 UTC 午夜日期；时间戳分桶尚未开放。");
  }
  const projection: string[] = [], outputFields: DataTable["fields"] = [];
  for (const dimension of data.dimensions) {
    const field = fields.get(dimension.field)!;
    if (dimension.timeUnit !== "none" && field.type !== "date") throw Error("日期粒度只能用于纯日期字段。");
    const expression = dimension.timeUnit === "none" ? (field.type === "date" ? `CAST(${quote(field.name)} AS DATE)` : quote(field.name))
      : `CAST(date_trunc('${dimension.timeUnit}', CAST(${quote(field.name)} AS DATE)) AS DATE)`;
    projection.push(`${expression} AS ${quote(dimension.as)}`);
    outputFields.push({ name: dimension.as, label: field.label, type: field.type });
  }
  const measure = data.measures[0], measureField = measure.field === null ? null : fields.get(measure.field)!;
  const counts = ["count", "countRows", "distinctCount"].includes(measure.aggregate ?? "");
  if (!counts && measureField?.type !== "number") throw Error("数值指标须为明确的 number 类型；不把 decimal / bigint 文本静默转成浮点数。");
  const integral = counts || table.rows.every(row => row[measure.field!] === null || Number.isSafeInteger(row[measure.field!]));
  const numericMode = integral && measure.aggregate !== "mean" && measure.aggregate !== "median" ? "safe-integer" : "float64";
  const inputExpression = measureField ? quote(measureField.name) : "*";
  const expression = measure.aggregate === null ? inputExpression : measure.aggregate === "countRows" ? "COUNT(*)"
    : measure.aggregate === "distinctCount" ? `COUNT(DISTINCT ${inputExpression})`
      : `${aggregateSql[measure.aggregate]}(${measure.aggregate === "sum" && integral ? `CAST(${inputExpression} AS BIGINT)` : inputExpression})`;
  projection.push(`${expression} AS ${quote(measure.as)}`);
  outputFields.push({ name: measure.as, label: measureField?.label ?? "行数", type: "number" });
  const predicates = data.filters.map(filter => {
    const field = fields.get(filter.field)!, name = quote(field.name);
    if (filter.kind === "range") {
      if (field.type !== "number") throw Error("数值范围筛选不能用于其他字段类型。");
      return [filter.min === null ? null : `${name} >= ${literal(filter.min)}`, filter.max === null ? null : `${name} <= ${literal(filter.max)}`].filter(Boolean).join(" AND ") || "TRUE";
    }
    for (const value of filter.values) if (value !== null && (field.type === "date" ? !isVisualizationDate(value)
      : typeof value !== (field.type === "number" ? "number" : field.type === "boolean" ? "boolean" : "string"))) throw Error("筛选值类型与字段不一致。");
    const nonNull = filter.values.filter((value): value is string | number | boolean => value !== null);
    return [nonNull.length ? `${name} IN (${nonNull.map(literal).join(", ")})` : null, filter.values.includes(null) ? `${name} IS NULL` : null].filter(Boolean).join(" OR ") || "FALSE";
  });
  const order = data.orderBy.map(item => `${quote(item.field)} ${item.direction === "ascending" ? "ASC" : "DESC"} NULLS LAST`);
  const sorted = new Set(data.orderBy.map(item => item.field));
  if (data.mode === "aggregate") {
    for (const dimension of data.dimensions) if (!sorted.has(dimension.as)) order.push(`${quote(dimension.as)} ASC NULLS LAST`);
  }
  if (data.mode === "rows") order.push(`${quote(ordinal)} ASC`);
  return { sql: `SELECT ${projection.join(", ")} FROM ${quote(VISUAL_INPUT_TABLE)}${predicates.length ? ` WHERE ${predicates.map(item => `(${item})`).join(" AND ")}` : ""}${data.mode === "aggregate" ? ` GROUP BY ${data.dimensions.map((_, index) => index + 1).join(", ")}` : ""} ORDER BY ${order.join(", ")}${data.limit ? ` LIMIT ${data.limit}` : ""}`,
    fields: outputFields, inputFields: table.fields.filter(field => selected.has(field.name)), inputOrder: data.mode === "rows", numericMode };
}

/** Stable source row ordinal is internal only; never part of the visual result. */
export function visualizationQueryTable(plan: VisualizationPlan, table: DataTable) {
  return { name: VISUAL_INPUT_TABLE,
    fields: [...plan.inputFields, ...(plan.inputOrder ? [{ name: ordinal, label: ordinal, type: "number" as const }] : [])],
    rows: table.rows.map((row, index) => Object.fromEntries([...plan.inputFields.map(field => [field.name, row[field.name]]), ...(plan.inputOrder ? [[ordinal, index]] : [])])) };
}
