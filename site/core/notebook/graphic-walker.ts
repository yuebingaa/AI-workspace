import { initialConfig, restoreConfig, type Assignment, type ChartConfig, type ChartDataset } from "@/core/chart-editor/config";
import type { NotebookTable } from "./contracts";
import type { NotebookCell } from "./definition";

export type NotebookChartCell = Extract<NotebookCell, { kind: "chart" }>;
export const notebookChartMarks = ["bar", "line", "area"] as const;
export function supportsNotebookGraphicWalker(cell: NotebookChartCell) {
  return Boolean(cell.graphicWalker) || (cell.valueFields.length === 1 && notebookChartMarks.some(mark => mark === cell.chartType));
}
/** Receives only the current, authorized upstream/receipt table; never fetches data. */
export function notebookChartDataset(cell: NotebookChartCell, table: NotebookTable): ChartDataset {
  return { id: `notebook:${cell.id}:${cell.inputCellId}`, name: cell.title,
    fields: table.fields.map(field => ({ id: field.name, name: field.label, type: field.type })),
    rows: table.rows, totalRows: table.rows.length, truncated: table.truncated };
}
export function notebookChartConfig(cell: NotebookChartCell, dataset: ChartDataset): ChartConfig {
  if (cell.graphicWalker) return cell.graphicWalker;
  const base = initialConfig(dataset);
  const field = (name: string): Assignment => ({ field: name, aggregate: "sum", timeUnit: "none" });
  return { ...base, title: cell.title, mark: cell.chartType === "line" || cell.chartType === "area" ? cell.chartType : "bar",
    channels: { x: field(cell.categoryField), y: field(cell.valueFields[0]), color: null, facetX: null, facetY: null, tooltip: [] },
    style: { ...base.style, stack: "none" } };
}
export function validateNotebookChartConfig(config: ChartConfig, dataset: ChartDataset): ChartConfig {
  const valid = restoreConfig(JSON.stringify(config), dataset);
  if (!valid.channels.x || !valid.channels.y) throw Error("请先选择 X 轴和 Y 轴字段。");
  if (!notebookChartMarks.some(mark => mark === valid.mark)) throw Error("Notebook 当前支持柱状图、折线图和面积图；散点图暂留在独立编辑器。");
  if (!valid.title.trim() || valid.title.trim().length > 120) throw Error("Notebook 图表标题需要 1–120 个字符。");
  return { ...valid, title: valid.title.trim() };
}
export function notebookChartFields(config: ChartConfig): string[] {
  const { x, y, color, facetX, facetY, tooltip } = config.channels;
  return [...new Set([...([x, y, color, facetX, facetY, ...tooltip].filter(Boolean) as Assignment[]).map(item => item.field), ...config.filters.map(item => item.field)])];
}
