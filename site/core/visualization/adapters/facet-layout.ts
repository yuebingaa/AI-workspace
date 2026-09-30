import type { DataTable } from "@/core/datasets/table-contracts";
import type { ChartDefinitionV2 } from "../definition";
import { visualizationCapabilities } from "../capabilities";

/** Layout only; never filters, aggregates, samples or edits materialized rows. */
export function materializedFacetGrid(definition: ChartDefinitionV2, table: DataTable) {
  const count = (name?: string) => {
    if (!name) return 1;
    const values = table.rows.map(row => row[name]);
    if (!values.every(value => typeof value === "string")) throw Error("分面仅支持非空文本或纯日期；计算结果仍可在图表数据中查看。");
    return Math.max(1, new Set(values).size);
  };
  const columns = count(definition.encoding.facetX), rows = count(definition.encoding.facetY);
  if (columns * rows > visualizationCapabilities.maxFacetPanels) throw Error(`分面网格超过 ${visualizationCapabilities.maxFacetPanels} 个小图，请筛选分面字段；完整计算结果仍可在“图表数据”中查看。`);
  return { columns, rows, enabled: Boolean(definition.encoding.facetX || definition.encoding.facetY) };
}

export function materializedFacetSize(size: { width: number; height: number }, grid: ReturnType<typeof materializedFacetGrid>) {
  // Same public auto-size/view configuration used by the existing editor.
  // Reserve headers/legend space; scroll inside the plot rather than shrinking tiny facets.
  return { width: Math.max(260, Math.floor((size.width - 160) / grid.columns)), height: Math.max(200, Math.floor((size.height - 100) / grid.rows)) };
}
