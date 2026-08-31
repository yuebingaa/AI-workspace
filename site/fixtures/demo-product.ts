import type { AppNode, AppPage, ChangeSet, DataProduct, DataRecipe, DataTableProps } from "@/core/models";
import { changeSetSchema, dataProductSchema, formatSchemaIssues } from "@/core/schemas";

const chartValues = [46, 62, 54, 78, 68, 92, 83, 104, 96, 118, 109, 132];
const chartLabels = chartValues.map((_, index) => `${index + 1}月`);

const baseTable: DataTableProps = {
  title: "区域表现",
  subtitle: "按收入贡献排序",
  actionLabel: "下载 Excel",
  columns: [
    { key: "region", label: "区域" },
    { key: "revenue", label: "收入" },
    { key: "growth", label: "同比增长" },
    { key: "completion", label: "目标完成率" },
  ],
  rows: [
    { region: "华东", revenue: "¥1,248,600", growth: "+18.2%", completion: "92%" },
    { region: "华南", revenue: "¥896,420", growth: "+11.6%", completion: "88%" },
    { region: "华北", revenue: "¥672,180", growth: "+7.4%", completion: "81%" },
  ],
};

function createDashboardRoot(pageId: string, title: string, description: string): AppNode {
  return {
    id: `${pageId}_root`,
    type: "PageRoot",
    props: {},
    children: [
      {
        id: `${pageId}_header`,
        type: "PageHeader",
        props: { eyebrow: title, title: "零售经营分析", description, dateRange: "过去 12 个月" },
      },
      {
        id: `${pageId}_insight`,
        type: "InsightBanner",
        props: {
          title: "AI 洞察",
          description: "华东区本月收入增长最快，但退款率高于均值 1.8%。建议优先检查“家居”品类订单。",
          actionLabel: "查看分析",
        },
      },
      {
        id: `${pageId}_metrics`,
        type: "MetricGrid",
        props: { columns: 3 },
        children: [
          { id: `${pageId}_revenue`, type: "MetricCard", props: { label: "本月收入", value: "¥324.8万", trend: "↗ 14.6%" } },
          { id: `${pageId}_customers`, type: "MetricCard", props: { label: "活跃客户", value: "8,642", trend: "↗ 8.2%" } },
          { id: `${pageId}_average`, type: "MetricCard", props: { label: "平均客单价", value: "¥376", trend: "↗ 5.1%" } },
        ],
      },
      {
        id: `${pageId}_analytics`,
        type: "DashboardGrid",
        props: {},
        children: [
          {
            id: `${pageId}_chart`,
            type: "BarChart",
            props: {
              title: "月度收入趋势",
              subtitle: "收入与目标对比",
              labels: chartLabels,
              values: chartValues,
              yAxis: ["400万", "300万", "200万", "100万", "0"],
            },
          },
          {
            id: `${pageId}_health`,
            type: "DataHealth",
            props: {
              title: "数据健康度",
              subtitle: "最近一次刷新：今天 09:30",
              score: 96,
              items: [
                { label: "完整性", value: "99%", status: "ok" },
                { label: "唯一性", value: "97%", status: "ok" },
                { label: "时效性", value: "92%", status: "warn" },
              ],
            },
          },
        ],
      },
      { id: `${pageId}_table`, type: "DataTable", props: structuredClone(baseTable) },
    ],
  };
}

function createPage(id: string, title: string, description: string): AppPage {
  return { id, title, route: `/${id.replace("page_", "")}`, root: createDashboardRoot(id, title, description) };
}

const appSpec = {
  id: "app_retail_demo",
  siteId: "site_retail_demo",
  schemaVersion: "1.0",
  navigation: [
    { id: "nav_home", title: "经营总览", pageId: "page_home" },
    { id: "nav_sales", title: "销售分析", pageId: "page_sales" },
    { id: "nav_customers", title: "客户洞察", pageId: "page_customers" },
  ],
  pages: [
    createPage("page_home", "经营总览", "用可信数据看清增长、客户与区域机会。"),
    createPage("page_sales", "销售分析", "聚焦收入趋势、目标达成与区域表现。"),
    createPage("page_customers", "客户洞察", "理解客户活跃度、价值与复购机会。"),
  ],
} satisfies DataProduct["appSpec"];

const rawDemoRecipe: DataRecipe = {
  id: "recipe_east_anomalies",
  name: "华东异常订单与复购分析",
  sourceDatasetId: "dataset_retail_orders",
  status: "ready",
  steps: [
    { id: "filter_east", type: "filter", field: "region", operator: "equals", value: "华东" },
    { id: "derive_repeat", type: "derive", field: "is_repeat_customer", expression: "customer_order_count > 1" },
    { id: "export_result", type: "export", format: "xlsx" },
  ],
};

const rawDemoDataProduct: DataProduct = {
  id: "product_retail_demo",
  name: "零售经营分析",
  schemaVersion: "1.0",
  datasets: [{ id: "dataset_retail_orders", name: "retail_orders.csv", rowCount: 12486, columnCount: 18, qualityScore: 96 }],
  recipes: [rawDemoRecipe],
  appSpec,
};

const anomalyTable: DataTableProps = {
  ...baseTable,
  columns: [...baseTable.columns, { key: "anomalies", label: "异常订单" }],
  rows: [
    { ...baseTable.rows[0], anomalies: "37" },
    { ...baseTable.rows[1], anomalies: "18" },
    { ...baseTable.rows[2], anomalies: "12" },
  ],
};

const rawRepurchaseChangeSet: ChangeSet = {
  id: "changeset_repurchase_analysis",
  title: "华东异常订单与复购分析",
  status: "ready",
  operations: [
    {
      id: "operation_recipe",
      type: "updateNodeProps",
      pageId: "page_home",
      nodeId: "page_home_insight",
      label: "创建数据配方",
      description: "筛选华东区异常订单，补充复购客户标记",
      props: { description: "华东异常订单配方已完成预览：共识别 37 条异常订单，并补充复购客户标记。" },
    },
    {
      id: "operation_metric",
      type: "addNode",
      pageId: "page_home",
      parentId: "page_home_metrics",
      label: "新增指标卡",
      description: "在核心指标组中加入“复购率”",
      node: { id: "metric_repurchase", type: "MetricCard", props: { label: "复购率", value: "42.8%", trend: "↗ 3.7%", isNew: true } },
    },
    {
      id: "operation_table",
      type: "updateNodeProps",
      pageId: "page_home",
      nodeId: "page_home_table",
      label: "更新区域表格",
      description: "添加异常订单数与筛选结果",
      props: { columns: anomalyTable.columns, rows: anomalyTable.rows },
    },
    {
      id: "operation_export",
      type: "updateNodeProps",
      pageId: "page_home",
      nodeId: "page_home_table",
      label: "配置导出动作",
      description: "提供当前模拟筛选结果的 Excel 下载入口",
      props: { actionLabel: "下载华东异常订单 Excel" },
    },
  ],
};

export interface DemoFixtures {
  dataProduct: DataProduct;
  repurchaseChangeSet: ChangeSet;
}

export type DemoFixtureResult =
  | { success: true; data: DemoFixtures }
  | { success: false; error: string };

function validateDemoFixtures(): DemoFixtureResult {
  const dataProductResult = dataProductSchema.safeParse(rawDemoDataProduct);
  const changeSetResult = changeSetSchema.safeParse(rawRepurchaseChangeSet);
  const issues = [
    ...(dataProductResult.success ? [] : formatSchemaIssues(dataProductResult.error, "DataProduct fixture")),
    ...(changeSetResult.success ? [] : formatSchemaIssues(changeSetResult.error, "ChangeSet fixture")),
  ];

  if (!dataProductResult.success || !changeSetResult.success) {
    return { success: false, error: `演示数据校验失败：${issues.join("；")}` };
  }

  return {
    success: true,
    data: {
      dataProduct: dataProductResult.data,
      repurchaseChangeSet: changeSetResult.data,
    },
  };
}

export const demoFixtureResult = validateDemoFixtures();
