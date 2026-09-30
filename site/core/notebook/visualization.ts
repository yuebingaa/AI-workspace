import type { NotebookCell } from "./definition";
import type { DataTable } from "@/core/datasets/table-contracts";
import { chartDefinitionV2Schema, isVisualizationDate, type ChartDefinitionV2 } from "@/core/visualization/definition";

/** Host adapter, not a persisted-format migration. Cancelling/viewing never rewrites old cells. */
export function notebookVisualization(cell: Extract<NotebookCell, { kind: "chart" }>):
  { definition: ChartDefinitionV2; reason?: never } | { definition?: never; reason: string } {
  const unsupported = (reason: string) => ({ reason: `兼容绘图：${reason}；仍使用本次返回的输入，尚未接入完整上游计算。` });
  if (cell.valueFields.length !== 1 || !["bar", "line", "area"].includes(cell.chartType)) return unsupported("多指标、饼图和环图保留原路径");
  const config = cell.graphicWalker;
  const { x, y, color, facetX, facetY, tooltip } = config?.channels ?? { x: null, y: null, color: null, facetX: null, facetY: null, tooltip: [] };
  if (config && (!x || !y)) return unsupported("请先选择 X 轴和 Y 轴");
  if ([x, color, facetX, facetY].some(field => field?.timeUnit === "week") || (y && y.timeUnit !== "none")) return unsupported("此日期粒度暂不支持");
  if (config?.style.stack === "normalize") return unsupported("百分比堆叠保留原路径");
  if ((color && (color.field === x?.field || color.field === y?.field)) || (x && x.field === y?.field)) return unsupported("重复轴字段保留原路径");
  const assigned = [x, y, color, facetX, facetY].filter(field => field !== null);
  if (new Set(assigned.map(field => field.field)).size !== assigned.length) return unsupported("分面与其他通道重复字段，保留原路径");
  if (tooltip.some(field => ![x, y, color, facetX, facetY].some(axis => axis && axis.field === field.field && axis.timeUnit === field.timeUnit
    && (axis !== y || axis.aggregate === field.aggregate)))) return unsupported("额外 Tooltip 字段保留原分组语义");
  const xField = x?.field ?? cell.categoryField, yField = y?.field ?? cell.valueFields[0];
  const style = config?.style;
  const parsed = chartDefinitionV2Schema.safeParse({ schemaVersion: 2, mark: cell.chartType,
    data: { mode: config ? "aggregate" : "rows", timezone: "UTC",
      dimensions: [{ field: xField, as: "viz_x", timeUnit: x?.timeUnit ?? "none" },
        ...(color ? [{ field: color.field, as: "viz_color", timeUnit: color.timeUnit }] : []),
        ...(facetX ? [{ field: facetX.field, as: "viz_facet_x", timeUnit: facetX.timeUnit }] : []),
        ...(facetY ? [{ field: facetY.field, as: "viz_facet_y", timeUnit: facetY.timeUnit }] : [])],
      // GW 0.5.2 count includes NULL. Preserve that meaning instead of mapping it to SQL COUNT(field).
      measures: [{ field: config && y!.aggregate === "count" ? null : yField, as: "viz_y", aggregate: config ? y!.aggregate === "count" ? "countRows" : y!.aggregate : null }],
      filters: config?.filters ?? [],
      orderBy: config ? ["viz_x", ...(color ? ["viz_color"] : []), ...(facetX ? ["viz_facet_x"] : []), ...(facetY ? ["viz_facet_y"] : [])]
        .map(field => ({ field, direction: "ascending", nulls: "last" })) : [],
    },
    encoding: { x: "viz_x", y: "viz_y", ...(color ? { color: "viz_color" } : {}),
      ...(facetX ? { facetX: "viz_facet_x" } : {}), ...(facetY ? { facetY: "viz_facet_y" } : {}),
      tooltip: ["viz_x", ...(color ? ["viz_color"] : []), ...(facetX ? ["viz_facet_x"] : []), ...(facetY ? ["viz_facet_y"] : []), "viz_y"] },
    presentation: { title: cell.title, palette: style?.palette ?? "muted", stack: config ? style!.stack : "none",
      numberFormat: style?.numberFormat ?? ",.2f", axes: style?.axes ?? true, grid: style?.grid ?? true, legend: style?.legend ?? true },
  });
  return parsed.success ? { definition: parsed.data } : unsupported("此筛选或字段配置超出新版计算支持范围");
}

/** Narrow rollout guard: a compatible saved config need not have compatible input values. */
export function notebookVisualizationInputIssue(cell: Extract<NotebookCell, { kind: "chart" }>, definition: ChartDefinitionV2, table: DataTable): string | undefined {
  const x = definition.data.dimensions[0];
  const xType = table.fields.find(field => field.name === x.field)?.type;
  if (!["string", "date"].includes(xType ?? "") || table.rows.some(row => typeof row[x.field] !== "string")) return "当前 X 轴不是非空文本或纯日期";
  for (const channel of [definition.encoding.facetX, definition.encoding.facetY]) {
    const field = definition.data.dimensions.find(dimension => dimension.as === channel)?.field;
    if (field && (!["string", "date"].includes(table.fields.find(item => item.name === field)?.type ?? "")
      || table.rows.some(row => typeof row[field] !== "string"))) return "分面字段需为非空文本或纯日期，保留原处理";
  }
  if (!cell.graphicWalker && table.rows.length > 1000) return "旧图原始行超过 1000 行，请先聚合";
  if (!cell.graphicWalker && new Set(table.rows.map(row => xType === "date" ? String(row[x.field]).slice(0, 10) : row[x.field])).size !== table.rows.length) {
    return "旧图含重复分类，保留原逐行绘图，避免柱或点重叠";
  }
  const selected = new Set([...definition.data.dimensions.map(field => field.field), ...definition.data.filters.map(field => field.field)]);
  if (table.fields.some(field => selected.has(field.name) && field.type === "date"
    && table.rows.some(row => row[field.name] !== null && !isVisualizationDate(row[field.name])))) return "时间戳分桶尚未接入，保留原日期处理";
  // JS aggregation handles NULL differently from SQL (mean, distinct, all-NULL sum, etc.).
  // Keep existing charts honest until their missing-value policy can be explicitly edited.
  if (cell.graphicWalker && definition.data.measures[0].aggregate !== "countRows"
    && table.rows.some(row => row[cell.valueFields[0]] === null)) return "指标含空值，保留原 Graphic Walker 聚合口径";
}
