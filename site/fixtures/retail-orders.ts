import type { DataRow, DataSourceDefinition, LocalDataRuntime } from "@/core/models";

const numericAggregations = ["none", "sum", "average", "count", "countDistinct", "min", "max"] as const;
const identityAggregations = ["none", "count", "countDistinct"] as const;

export const retailOrdersDataSource: DataSourceDefinition = {
  id: "dataset_retail_orders",
  name: "retail_orders",
  rowCount: 48,
  columnCount: 14,
  qualityScore: 96,
  fields: [
    { name: "order_id", label: "订单 ID", type: "string", aggregatable: false, supportedAggregations: [...identityAggregations] },
    { name: "customer_id", label: "客户 ID", type: "string", aggregatable: false, supportedAggregations: [...identityAggregations] },
    { name: "order_date", label: "订单日期", type: "date", aggregatable: true, supportedAggregations: ["none", "count", "countDistinct", "min", "max"] },
    { name: "month", label: "月份", type: "string", aggregatable: false, supportedAggregations: [...identityAggregations] },
    { name: "region", label: "区域", type: "string", aggregatable: false, supportedAggregations: [...identityAggregations] },
    { name: "category", label: "品类", type: "string", aggregatable: false, supportedAggregations: [...identityAggregations] },
    { name: "revenue", label: "收入", type: "number", aggregatable: true, supportedAggregations: [...numericAggregations] },
    { name: "active_customers", label: "活跃客户数", type: "number", aggregatable: true, supportedAggregations: [...numericAggregations] },
    { name: "average_order_value", label: "平均客单价", type: "number", aggregatable: true, supportedAggregations: [...numericAggregations] },
    { name: "growth_rate", label: "同比增长", type: "number", aggregatable: true, supportedAggregations: [...numericAggregations] },
    { name: "completion_rate", label: "目标完成率", type: "number", aggregatable: true, supportedAggregations: [...numericAggregations] },
    { name: "repurchase_rate", label: "复购率", type: "number", aggregatable: true, supportedAggregations: [...numericAggregations] },
    { name: "anomaly_count", label: "异常订单", type: "number", aggregatable: true, supportedAggregations: [...numericAggregations] },
    { name: "refunded", label: "是否退款", type: "boolean", aggregatable: false, supportedAggregations: [...identityAggregations] },
  ],
};

const monthWeights = [46, 62, 54, 78, 68, 92, 83, 104, 96, 118, 109, 132];
const monthWeightTotal = monthWeights.reduce((total, value) => total + value, 0);
const regions = [
  { name: "华东", revenue: 1_248_600, growth: 0.182, completion: 0.92, anomalies: 37 },
  { name: "华南", revenue: 896_420, growth: 0.116, completion: 0.88, anomalies: 18 },
  { name: "华北", revenue: 672_180, growth: 0.074, completion: 0.81, anomalies: 12 },
  { name: "西部", revenue: 430_800, growth: 0.052, completion: 0.76, anomalies: 9 },
];
const categories = ["家居", "食品", "美妆", "数码"];

export const retailOrderRows: DataRow[] = monthWeights.flatMap((monthWeight, monthIndex) => (
  regions.map((region, regionIndex) => ({
    order_id: `order_${monthIndex + 1}_${regionIndex + 1}`,
    customer_id: `customer_${((monthIndex * regions.length + regionIndex) % 16) + 1}`,
    order_date: `2025-${String(monthIndex + 1).padStart(2, "0")}-15`,
    month: `${String(monthIndex + 1).padStart(2, "0")}月`,
    region: region.name,
    category: categories[(monthIndex + regionIndex) % categories.length],
    revenue: region.revenue * monthWeight / monthWeightTotal,
    active_customers: 8_642 * region.revenue / 3_248_000 / monthWeights.length,
    average_order_value: 376,
    growth_rate: region.growth,
    completion_rate: region.completion,
    repurchase_rate: 0.428,
    anomaly_count: region.anomalies / monthWeights.length,
    refunded: (monthIndex + regionIndex) % 11 === 0,
  }))
));

export const demoLocalDataRuntime: LocalDataRuntime = {
  rowsByDataSourceId: { [retailOrdersDataSource.id]: retailOrderRows },
};
