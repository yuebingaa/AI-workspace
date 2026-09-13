import type { AppSpec, ChartType } from "@/core/models";
import type { HarnessPublicRequest } from "@/core/harness/contracts";
import { retailOrdersDataSource } from "@/fixtures/retail-orders";

export const LAB_PAGE_ID = "page_visualization_lab";
export const LAB_CHART_CONTAINER_ID = "visualization_lab_charts";
export interface VisualizationCase {
  id: string;
  name: string;
  description: string;
  prompt: string;
  expected?: { types: ChartType[]; groupBy: "month" | "region" | "category"; order: "month" | "descending" | "any" };
}

export const visualizationCases: VisualizationCase[] = [
  { id: "monthly-line", name: "月度收入趋势", description: "折线图 · 时间排序与汇总", prompt: "在当前空白页面创建一张折线图，展示 retail_orders 全部数据按月份 month 汇总的收入 revenue（求和，单位人民币元），覆盖全部 12 个月，月份升序。请生成图表变更预览。", expected: { types: ["line"], groupBy: "month", order: "month" } },
  { id: "region-bar", name: "区域收入比较", description: "柱状图 · 完整分组与降序", prompt: "在当前空白页面创建一张柱状图，比较 retail_orders 全部 4 个区域 region 的总收入 revenue（求和，单位人民币元），按收入从高到低排列，不做筛选。请生成图表变更预览。", expected: { types: ["bar"], groupBy: "region", order: "descending" } },
  { id: "category-donut", name: "品类收入占比", description: "环形图 · 占比与数据口径", prompt: "在当前空白页面创建一张环形图，展示 retail_orders 全部数据中 4 个品类 category 的收入 revenue 占比，数值使用收入求和，单位人民币元，不做筛选。请生成图表变更预览。", expected: { types: ["donut"], groupBy: "category", order: "any" } },
  { id: "monthly-area", name: "月度收入面积", description: "面积图 · 数值与月份覆盖", prompt: "在当前空白页面创建一张面积图，展示 retail_orders 全部数据按月份 month 汇总的收入 revenue（求和，单位人民币元），覆盖全部 12 个月并按月份升序，不做累计。请生成图表变更预览。", expected: { types: ["area"], groupBy: "month", order: "month" } },
  { id: "region-pie", name: "区域收入构成", description: "饼图 · 分组与数值", prompt: "在当前空白页面创建一张饼图，展示 retail_orders 全部 4 个区域 region 的收入 revenue 构成，使用收入求和，单位人民币元，不做筛选。请生成图表变更预览。", expected: { types: ["pie"], groupBy: "region", order: "any" } },
  { id: "auto-region", name: "让 Agent 选择图表", description: "自主选图 · 比较任务", prompt: "我想直观比较 retail_orders 全部 4 个区域 region 的总收入 revenue（求和，单位人民币元），快速看出高低，按总收入从高到低展示，不做筛选。请选择合适的图表，在当前空白页面创建一张并生成变更预览。", expected: { types: ["bar"], groupBy: "region", order: "descending" } },
  { id: "custom", name: "自定义测试", description: "自由提问 · 人工核对需求", prompt: "用 retail_orders 数据在当前空白页面创建一张图表，展示我关心的趋势或差异，并生成变更预览。" },
];

export function createLabAppSpec(): AppSpec {
  return { id: "app_visualization_lab", siteId: "site_visualization_lab", schemaVersion: "1.0",
    dataSources: [structuredClone(retailOrdersDataSource)], navigation: [{ id: "nav_lab", title: "可视化测试", pageId: LAB_PAGE_ID }],
    pages: [{ id: LAB_PAGE_ID, title: "可视化测试画布", route: "/visualization-lab", root: { id: "visualization_lab_root", type: "PageRoot", props: {},
      children: [{ id: LAB_CHART_CONTAINER_ID, type: "DashboardGrid", props: {}, children: [] }] } }] };
}

export function createLabRequest(instruction: string, idempotencyKey: string): HarnessPublicRequest {
  return { instruction: instruction.trim(), idempotencyKey, pageId: LAB_PAGE_ID,
    dataSourceId: retailOrdersDataSource.id, appSpec: createLabAppSpec(), recipes: [] };
}

/** Only an unchanged preset has a known answer. Edited prompts require human assessment. */
export function caseForInstruction(caseId: string, instruction: string): VisualizationCase | undefined {
  const selected = visualizationCases.find((item) => item.id === caseId);
  return selected?.prompt.trim() === instruction.trim() ? selected : undefined;
}
