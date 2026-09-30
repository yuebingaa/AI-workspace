import { normalize, type IChannelScales, type IMutField, type VegaGlobalConfig } from "@kanaries/graphic-walker";
import type { DataTable } from "@/core/datasets/table-contracts";
import { parseChartDefinitionV2, type ChartDefinitionV2 } from "../definition";
import { materializedFacetGrid } from "./facet-layout";
export { assertMaterializedWorkflow } from "./materialized-workflow";

/** Rendering adapter only. The host supplies the already verified, complete result.
 * First slice uses discrete X values (including UTC date buckets); no continuous
 * time-axis or client-side date drilling, filtering, sorting or business aggregation.
 */
export function materializedGraphicWalker(value: ChartDefinitionV2, table: DataTable) {
  const definition = parseChartDefinitionV2(value), { encoding, presentation } = definition;
  if (table.truncated || table.rows.length > 1000) throw Error("图表渲染需要完整的已计算结果。");
  const outputs = [...definition.data.dimensions, ...definition.data.measures].map(item => item.as);
  if (JSON.stringify(table.fields.map(field => field.name)) !== JSON.stringify(outputs)) throw Error("图表结果字段不匹配。");
  const fields: IMutField[] = table.fields.map(field => ({ fid: field.name, name: field.label,
    analyticType: field.name === encoding.y ? "measure" : "dimension", semanticType: field.name === encoding.y ? "quantitative" : "nominal" }));
  const grid = materializedFacetGrid(definition, table);
  const chart = normalize({ mark: definition.mark,
    x: [...(encoding.facetX ? [`fid:${encoding.facetX}`] : []), `fid:${encoding.x}`],
    y: [...(encoding.facetY ? [`fid:${encoding.facetY}`] : []), `fid:${encoding.y}`],
    ...(encoding.color ? { color: `fid:${encoding.color}` } : {}), details: encoding.tooltip.map(field => `fid:${field}`),
    aggregate: false, stack: presentation.stack, layout: { useSvg: true, showActions: false, interactiveScale: false, zeroScale: true,
      format: { numberFormat: presentation.numberFormat } } }, fields);
  // 0.5.2's public categorical scale accepts string[]. Do not cast nullable or
  // numeric categories to strings (NULL and a literal "NULL" must not merge).
  // Wider dimension types remain computable, but this first renderer is narrower.
  const orderedValues = [...new Set(table.rows.map(row => row[encoding.x]))];
  if (!orderedValues.every((value): value is string => typeof value === "string")) throw Error("首批 V2 绘图仅支持非空文本或纯日期 X 轴；请查看计算结果表。");
  const scales: IChannelScales = { column: { domain: orderedValues } };
  const palettes = { muted: ["#7d91c8", "#9e8fb8", "#93b8aa", "#d1ae7b", "#bc9095"], blue: ["#315b8c", "#5b8fc4", "#8bb6d8", "#b5d3e8"], warm: ["#bb7657", "#d49d68", "#ddb987", "#aaa17c"] };
  const theme = { font: "Arial, Microsoft YaHei, sans-serif", background: "#ffffff", view: { stroke: null },
    axis: { labels: presentation.axes, ticks: presentation.axes, domain: presentation.axes, titleOpacity: presentation.axes ? 1 : 0,
      grid: presentation.grid, gridColor: "#edecef", labelColor: "#63616c", titleColor: "#63616c" },
    legend: { disable: !presentation.legend }, range: { category: palettes[presentation.palette] }, area: { opacity: 0.85 } } satisfies VegaGlobalConfig;
  return { chart, scales, theme: { light: theme, dark: theme }, title: presentation.title, grid };
}
