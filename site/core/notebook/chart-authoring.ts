import { z } from "zod";
import { configSchema, initialConfig } from "@/core/chart-editor/config";
import { notebookCellSchema, notebookIdentifierSchema, notebookTitleSchema, type NotebookCell } from "./definition";

const channel = configSchema.shape.channels.shape;
/** One authoring contract for the model and the official editor; host IDs are derived, never guessed. */
export const notebookChartAuthoringSchema = z.object({
  id: notebookIdentifierSchema, inputCellId: notebookIdentifierSchema, title: notebookTitleSchema,
  mark: z.enum(["bar", "line", "area"]),
  channels: z.object({ x: channel.x.unwrap(), y: channel.y.unwrap(),
    color: channel.color.default(null), facetX: channel.facetX.default(null), facetY: channel.facetY.default(null),
    tooltip: channel.tooltip.default([]) }).strict(),
  filters: configSchema.shape.filters.optional(), style: configSchema.shape.style.partial().optional(),
}).strict();
export type NotebookChartAuthoring = z.infer<typeof notebookChartAuthoringSchema>;

export function authorNotebookChart(input: NotebookChartAuthoring, previous?: NotebookCell) {
  const args = notebookChartAuthoringSchema.parse(input);
  if (previous && (previous.kind !== "chart" || previous.id !== args.id)) throw Error("图表配置不能替换其他类型单元。");
  const datasetId = `notebook:${args.id}:${args.inputCellId}`;
  const prior = previous?.kind === "chart" && previous.inputCellId === args.inputCellId ? previous.graphicWalker : undefined;
  const base = prior ?? initialConfig({ id: datasetId, name: args.title, fields: [], rows: [], totalRows: 0 });
  const graphicWalker = configSchema.parse({ ...base, datasetId, title: args.title, mark: args.mark,
    channels: args.channels, filters: args.filters ?? prior?.filters ?? [], style: { ...base.style, ...args.style } });
  return notebookCellSchema.parse({ id: args.id, kind: "chart", title: args.title, inputCellId: args.inputCellId,
    chartType: args.mark, categoryField: args.channels.x.field, valueFields: [args.channels.y.field], graphicWalker });
}

export const notebookChartAuthoringGuidance = "创建或修改单指标柱/线/面积图优先用 charts 数组（而非 cells 内的旧 chart）："
  + "每项 id/inputCellId/title/mark/channels；channels.x/y 含 field、aggregate、timeUnit，color/facetX/facetY 可选，tooltip 为数组。"
  + "field 用实际字段 ID；aggregate 支持 sum/mean/count/distinctCount/min/max/median，日期 timeUnit 支持 none/year/quarter/month/day。"
  + "filters 和 style 可选，修改同一数据源时省略则保留；channels 整体替换，省略 color/分面表示清空。"
  + "主机自动生成 graphicWalker 配置与绑定 ID，AI 和官方图表编辑器共用它；先核实数据粒度，已汇总指标避免重复平均。"
  + "编辑后仍须真实试运行并提交草稿；不要声称运行成功就等于图形已视觉验收。旧多指标/饼环可保留 cells 兼容格式。";
