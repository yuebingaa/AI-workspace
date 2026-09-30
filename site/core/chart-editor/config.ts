import { z } from "zod";
import type { IMutField, TerseFieldRef, TerseSpec, VegaGlobalConfig } from "@kanaries/graphic-walker";

export interface ChartField { id: string; name: string; type: "string" | "number" | "date" | "boolean" }
export interface ChartDataset {
  id: string; name: string; fields: ChartField[];
  rows: Record<string, string | number | boolean | null>[];
  totalRows: number; synthetic?: boolean; truncated?: boolean;
}
export const aggregations = { sum: "求和", mean: "平均值", count: "计数", distinctCount: "去重计数", min: "最小值", max: "最大值", median: "中位数" } as const;
export const dateUnits = { none: "原始日期", year: "年", quarter: "季度", month: "月", week: "周", day: "日" } as const;
export const channels = { x: "X 轴", y: "Y 轴", color: "颜色", facetX: "水平分面", facetY: "垂直分面", tooltip: "Tooltip 字段" } as const;
export type Channel = keyof typeof channels;
const assignment = z.object({ field: z.string().min(1), aggregate: z.enum(["sum", "mean", "count", "distinctCount", "min", "max", "median"]).default("sum"),
  timeUnit: z.enum(["none", "year", "quarter", "month", "week", "day"]).default("none") }).strict();
export type Assignment = z.infer<typeof assignment>;
const filter = z.discriminatedUnion("kind", [
  z.object({ field: z.string(), kind: z.literal("oneOf"), values: z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).max(1000) }).strict(),
  z.object({ field: z.string(), kind: z.literal("range"), min: z.number().finite().nullable(), max: z.number().finite().nullable() }).strict(),
  z.object({ field: z.string(), kind: z.literal("dateRange"), min: z.number().finite().nullable(), max: z.number().finite().nullable() }).strict(),
]);
export type ChartFilter = z.infer<typeof filter>;
export const configSchema = z.object({
  version: z.literal(1), datasetId: z.string(), title: z.string().max(160), mark: z.enum(["area", "bar", "line", "point"]),
  channels: z.object({ x: assignment.nullable(), y: assignment.nullable(), color: assignment.nullable(), facetX: assignment.nullable(), facetY: assignment.nullable(), tooltip: z.array(assignment).max(30) }).strict(),
  filters: z.array(filter).max(30),
  style: z.object({ palette: z.enum(["muted", "blue", "warm"]), font: z.enum(["sans", "serif"]), fontSize: z.number().int().min(10).max(20),
    axes: z.boolean(), legend: z.boolean(), legendPosition: z.enum(["right", "bottom", "top"]).default("right"), grid: z.boolean(), stack: z.enum(["stack", "normalize", "none"]),
    numberFormat: z.enum([",.0f", ",.2f", ".1%"]), showTitle: z.boolean() }).strict(),
}).strict();
export type ChartConfig = z.infer<typeof configSchema>;
export const palettes = { muted: ["#7d91c8", "#9e8fb8", "#93b8aa", "#d1ae7b", "#bc9095"], blue: ["#315b8c", "#5b8fc4", "#8bb6d8", "#b5d3e8"], warm: ["#bb7657", "#d49d68", "#ddb987", "#aaa17c"] };

export function initialConfig(dataset: ChartDataset): ChartConfig {
  const x = dataset.fields.find(f => f.type === "date") ?? dataset.fields.find(f => f.type !== "number");
  const y = dataset.fields.find(f => f.type === "number");
  const color = dataset.fields.find(f => f.type === "string" && f.id !== x?.id);
  const item = (id: string): Assignment => ({ field: id, aggregate: "sum", timeUnit: "none" });
  return { version: 1, datasetId: dataset.id, title: dataset.synthetic ? "季度成交金额 · 客户类型" : `${dataset.name} · 图表`, mark: "area",
    channels: { x: x ? { ...item(x.id), timeUnit: dataset.synthetic ? "quarter" : "none" } : null, y: y ? item(y.id) : null,
      color: color ? item(color.id) : null, facetX: null, facetY: null, tooltip: [] }, filters: [],
    style: { palette: "muted", font: "sans", fontSize: 12, axes: true, legend: true, legendPosition: "right", grid: true, stack: "stack", numberFormat: ",.0f", showTitle: true } };
}

export function canAssign(channel: Channel, field: ChartField): boolean {
  return channel === "y" ? field.type === "number" : ["color", "facetX", "facetY"].includes(channel) ? field.type !== "number" : true;
}
export function assignField(config: ChartConfig, dataset: ChartDataset, channel: Channel, fieldId: string): ChartConfig {
  const field = dataset.fields.find(f => f.id === fieldId);
  if (!field || !canAssign(channel, field)) throw Error(`${channels[channel]} 不支持这个字段类型。`);
  const next: Assignment = { field: fieldId, aggregate: "sum", timeUnit: "none" };
  if (channel === "tooltip") {
    if (config.channels.tooltip.some(f => f.field === fieldId)) return config;
    return { ...config, channels: { ...config.channels, tooltip: [...config.channels.tooltip, next] } };
  }
  return { ...config, channels: { ...config.channels, [channel]: next } };
}
export function restoreConfig(text: string, dataset: ChartDataset): ChartConfig {
  if (text.length > 250_000) throw Error("配置文件过大；请使用本编辑器导出的配置。");
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw Error("配置文件不是有效的 JSON；原配置未改动。"); }
  const result = configSchema.safeParse(parsed);
  if (!result.success) throw Error("配置格式或版本不支持；原配置未改动。");
  const config = result.data;
  if (config.datasetId !== dataset.id) throw Error("配置属于其他数据源，请先打开对应数据源。");
  for (const channel of Object.keys(channels) as Channel[]) {
    const items = channel === "tooltip" ? config.channels.tooltip : config.channels[channel] ? [config.channels[channel]] : [];
    for (const item of items) {
      const field = dataset.fields.find(f => f.id === item.field);
      if (!field || !canAssign(channel, field) || (item.timeUnit !== "none" && field.type !== "date")) throw Error("配置字段已不存在或类型不兼容；原配置未改动。");
    }
  }
  for (const rule of config.filters) {
    const field = dataset.fields.find(f => f.id === rule.field);
    if (!field || (rule.kind === "range" && field.type !== "number") || (rule.kind === "dateRange" && field.type !== "date")) throw Error("筛选字段已不存在或类型不兼容。");
    if (rule.kind !== "oneOf" && rule.min !== null && rule.max !== null && rule.min > rule.max) throw Error("筛选下限不能大于上限。");
  }
  return config;
}
export function metadata(dataset: ChartDataset): IMutField[] {
  return dataset.fields.map(f => ({ fid: f.id, name: f.name, semanticType: f.type === "number" ? "quantitative" : f.type === "date" ? "temporal" : "nominal",
    analyticType: f.type === "number" ? "measure" : "dimension", ...(f.type === "date" ? { offset: 0 } : {}) }));
}

/** Sole translation boundary. GW performs date drilling, filters and aggregation; no local SQL/aggregation reimplementation. */
export function graphicSpec(config: ChartConfig, dataset: ChartDataset): TerseSpec {
  const ref = (item: Assignment): TerseFieldRef => ({ field: `fid:${item.field}`,
    ...(dataset.fields.find(f => f.id === item.field)?.type === "number" ? { aggregate: item.aggregate } : {}),
    ...(item.timeUnit !== "none" ? { timeUnit: item.timeUnit } : {}), sort: "ascending" });
  const c = config.channels;
  const x = [c.facetX, c.x].filter((f): f is Assignment => f !== null).map(ref);
  const y = [c.facetY, c.y].filter((f): f is Assignment => f !== null).map(ref);
  return { mark: config.mark, name: config.title, x, y, color: c.color ? ref(c.color) : undefined, details: c.tooltip.map(ref),
    aggregate: true, stack: config.style.stack, config: { timezoneDisplayOffset: 0 },
    filters: config.filters.map(f => f.kind === "oneOf" ? { field: `fid:${f.field}`, oneOf: f.values } : f.kind === "range" ? { field: `fid:${f.field}`, range: [f.min, f.max] } : { field: `fid:${f.field}`, timeRange: [f.min, f.max] }),
    layout: { useSvg: true, showActions: false, interactiveScale: false, background: "#ffffff", zeroScale: true,
      format: { numberFormat: config.style.numberFormat, timeFormat: c.x?.timeUnit === "quarter" ? "%Y Q%q" : c.x?.timeUnit === "year" ? "%Y" : "%Y-%m-%d" } } };
}
export function graphicTheme(config: ChartConfig) {
  const s = config.style, font = s.font === "serif" ? "Georgia, SimSun, serif" : "Arial, Microsoft YaHei, sans-serif";
  const theme = { font, background: "#ffffff", view: { stroke: null }, mark: { color: palettes[s.palette][0] },
    axis: { labelFont: font, titleFont: font, labelFontSize: s.fontSize, titleFontSize: s.fontSize,
      labels: s.axes, ticks: s.axes, domain: s.axes, titleOpacity: s.axes ? 1 : 0, grid: s.grid, gridColor: "#edecef", labelColor: "#63616c", titleColor: "#63616c" },
    legend: { disable: !s.legend, labelFont: font, titleFont: font, labelFontSize: s.fontSize, titleFontSize: s.fontSize, orient: s.legendPosition },
    header: { labelFont: font, titleFont: font, labelFontSize: s.fontSize }, range: { category: palettes[s.palette] }, area: { opacity: 0.85 } } satisfies VegaGlobalConfig;
  return { light: theme, dark: theme };
}
