import { z } from "zod";

// V2 computation contract; no Notebook IDs, React or renderer-specific types.
const field = z.string().min(1).max(120).refine(value => !/[\u0000-\u001f]/u.test(value));
const alias = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,59}$/u);
const scalar = z.union([z.string().max(2000), z.number().finite(), z.boolean(), z.null()]);
export const visualizationFilterSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("oneOf"), field, values: z.array(scalar).max(100) }).strict(),
  z.object({ kind: z.literal("range"), field, min: z.number().finite().nullable(), max: z.number().finite().nullable() }).strict()
    .refine(value => value.min === null || value.max === null || value.min <= value.max, "筛选范围无效"),
]);
export const chartDefinitionV2Schema = z.object({
  schemaVersion: z.literal(2), mark: z.enum(["bar", "line", "area"]),
  data: z.object({
    mode: z.enum(["rows", "aggregate"]), timezone: z.literal("UTC"),
    dimensions: z.array(z.object({ field, as: alias, timeUnit: z.enum(["none", "year", "quarter", "month", "day"]) }).strict()).min(1).max(4),
    measures: z.array(z.object({ field: field.nullable(), as: alias,
      aggregate: z.enum(["sum", "mean", "min", "max", "median", "count", "countRows", "distinctCount"]).nullable() }).strict()).length(1),
    filters: z.array(visualizationFilterSchema).max(20),
    orderBy: z.array(z.object({ field: alias, direction: z.enum(["ascending", "descending"]), nulls: z.literal("last") }).strict()).max(5),
    limit: z.number().int().min(1).max(1000).optional(),
  }).strict(),
  encoding: z.object({ x: alias, y: alias, color: alias.optional(), facetX: alias.optional(), facetY: alias.optional(), tooltip: z.array(alias).max(5) }).strict(),
  presentation: z.object({ title: z.string().trim().min(1).max(160), palette: z.enum(["muted", "blue", "warm"]),
    stack: z.enum(["stack", "none"]), numberFormat: z.enum([",.0f", ",.2f", ".1%"]),
    axes: z.boolean(), grid: z.boolean(), legend: z.boolean() }).strict(),
}).strict().superRefine((definition, ctx) => {
  const { data, encoding } = definition, measure = data.measures[0];
  const outputs = [...data.dimensions, ...data.measures].map(item => item.as);
  const fail = (message: string) => ctx.addIssue({ code: "custom", message });
  if (new Set(outputs).size !== outputs.length || outputs.some(name => name.toLowerCase() === "viz_input_order")
    || new Set(outputs.map(name => name.toLowerCase())).size !== outputs.length) fail("结果别名必须唯一，不能使用保留名称");
  if (!data.dimensions.some(item => item.as === encoding.x) || measure.as !== encoding.y) fail("坐标轴必须引用已定义的维度和指标");
  if (encoding.color && (encoding.color === encoding.x || !data.dimensions.some(item => item.as === encoding.color))) fail("颜色必须引用独立的分组维度");
  const dimensionChannels = [encoding.x, encoding.color, encoding.facetX, encoding.facetY].filter((name): name is string => name !== undefined);
  if (new Set(dimensionChannels).size !== dimensionChannels.length || dimensionChannels.some(name => !data.dimensions.some(item => item.as === name))) fail("X、颜色与分面须引用独立的维度");
  if (data.dimensions.some(item => !dimensionChannels.includes(item.as))) fail("不允许未用于 X、颜色或分面的隐藏分组");
  if (new Set(encoding.tooltip).size !== encoding.tooltip.length || encoding.tooltip.some(name => !outputs.includes(name))) fail("Tooltip 只能引用已有结果字段，不会增加分组");
  if (new Set(data.orderBy.map(item => item.field)).size !== data.orderBy.length || data.orderBy.some(item => !outputs.includes(item.field))) fail("排序必须引用唯一的结果字段");
  if (data.mode === "rows" ? measure.aggregate !== null || measure.field === null : measure.aggregate === null) fail("原始行与聚合模式配置不一致");
  if (data.mode === "rows" && definition.presentation.stack !== "none") fail("原始行模式不自动堆叠重复分类");
  if (measure.aggregate === "countRows" ? measure.field !== null : measure.field === null) fail("countRows 不需要字段，其他指标需要字段");
});
export type ChartDefinitionV2 = z.infer<typeof chartDefinitionV2Schema>;

/** CSV's canonical UTC-midnight serialization represents a DATE. No arbitrary timestamp/DST coercion. */
export function isVisualizationDate(value: unknown): value is string {
  return typeof value === "string" && (z.iso.date().safeParse(value).success
    || (/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(value) && z.iso.date().safeParse(value.slice(0, 10)).success));
}

export function parseChartDefinitionV2(value: unknown): ChartDefinitionV2 {
  const result = chartDefinitionV2Schema.safeParse(value);
  if (!result.success) throw Error("V2 图表配置或版本不支持；请检查维度、指标、排序与结果字段。");
  return result.data;
}

/** Stable semantic identity; presentation/mark do not change computed values. */
export function visualizationDataKey(value: ChartDefinitionV2): string {
  return JSON.stringify({ schemaVersion: 2, data: parseChartDefinitionV2(value).data });
}
