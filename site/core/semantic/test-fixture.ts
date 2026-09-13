import type { DataRow, DataSourceDefinition } from "@/core/models";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { SemanticModel } from "./contracts";

export function semanticFixture() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  const source: DataSourceDefinition = { id: "semantic_sales", name: "合成销售表", rowCount: 3, columnCount: 2, qualityScore: 100,
    updatedAt: "2026-09-10T00:00:00.000Z", sourceType: "local-fixture", fields: [
      { name: "region", label: "地区", type: "string", aggregatable: true, supportedAggregations: ["none", "count", "countDistinct", "min", "max"] },
      { name: "amount", label: "销售金额", type: "number", aggregatable: true, supportedAggregations: ["none", "sum", "average", "count", "countDistinct", "min", "max"] },
    ] };
  const rows: DataRow[] = [{ region: "华东", amount: 100 }, { region: "华东", amount: 50 }, { region: "华南", amount: 80 }];
  const product = structuredClone(demoFixtureResult.data.dataProduct);
  product.appSpec.dataSources.push(source);
  product.datasets.push({ id: source.id, name: source.name, rowCount: 3, columnCount: 2, qualityScore: 100, workspaceId: "page_home" });
  const model: SemanticModel = { id: "sales_model", version: 1, name: "销售分析", description: "按地区分析销售收入", sourceDatasetId: source.id,
    dimensions: [{ key: "area", label: "销售区域", field: "region", description: "订单所属地区" }],
    measures: [
      { key: "revenue", label: "销售额", field: "amount", aggregation: "sum", description: "原始销售金额合计" },
      { key: "average_sale", label: "平均金额", field: "amount", aggregation: "average", description: "按每行订单平均" },
    ] };
  return { product, source, rows, model };
}
