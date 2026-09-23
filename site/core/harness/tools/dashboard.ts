import type { HarnessToolContext } from "./contracts";
import { compactNodes, EDS_TABLE_FIELDS, findAppNode } from "./dashboard-context";
import { StudioValidationError } from "@/core/schemas/errors";
import { defineTool } from "./contracts";
import { z } from "zod";
import { modelPlanDraftSchema, compileModelPlanDraft } from "@/core/ai/operation-output";
import type { HarnessToolExecutionResult } from "../contracts";
import { previewChangeSet, createExecutionState } from "@/core/changesets";
import { assertSemanticPreviewBindings } from "@/core/semantic/bindings";
import { CHART_TYPES, BAR_CHART_COLORS } from "@/core/models";
import { sanitizeHarnessText } from "../security";
import { EDS_BREAKDOWN_DATA_SOURCE_ID } from "@/core/eds";

function uniqueAppNodeId(context: HarnessToolContext, prefix: string): string {
  const token = context.id().replace(/[^A-Za-z0-9_-]/gu, "_").slice(-48) || String(Math.trunc(context.now()));
  const stem = `${prefix}_${token}`.slice(0, 112);
  const occupied = new Set(context.request.appSpec.pages.flatMap((page) => compactNodes(page.root).map((node) => node.id)));
  if (!occupied.has(stem)) return stem;
  for (let index = 2; index <= 999; index += 1) {
    const candidate = `${stem.slice(0, 112 - String(index).length - 1)}_${index}`;
    if (!occupied.has(candidate)) return candidate;
  }
  throw new StudioValidationError("Harness 节点 ID 生成失败", ["当前页面可用的唯一节点 ID 已耗尽"]);
}

export const inspectAppSpec = defineTool({
  name: "inspectAppSpec",
  description: "检查 AppSpec 页面、组件树和可用数据源。只读。",
  mode: "readOnly",
  schema: z.object({ pageId: z.string().min(1).max(120).optional() }).strict(),
  execute: ({ pageId }, context) => {
    const pages = pageId
      ? context.request.appSpec.pages.filter((page) => page.id === pageId)
      : context.request.appSpec.pages;
    if (!pages.length) throw new StudioValidationError("Harness AppSpec 校验失败", [`页面不存在：${pageId}`]);
    return {
      summary: `已检查 ${pages.length} 个页面和 ${pages.reduce((total, page) => total + compactNodes(page.root).length, 0)} 个节点。`,
      data: {
        pages: pages.map((page) => ({ id: page.id, title: page.title, route: page.route, nodes: compactNodes(page.root) })),
        dataSourceIds: context.request.appSpec.dataSources.map((source) => source.id),
      },
    };
  },
});

function previewModelDraft(
  draft: z.infer<typeof modelPlanDraftSchema>,
  context: HarnessToolContext,
): HarnessToolExecutionResult {
  const changeSet = compileModelPlanDraft(draft, context.request.instruction, {
    now: context.now,
    idFactory: context.id,
  });
  const preview = previewChangeSet(createExecutionState(context.request.appSpec), changeSet, context.request.role);
  if (!preview.preview) throw new StudioValidationError("Harness ChangeSet 预览失败", ["未生成有效预览"]);
  if (context.request.semanticModel) assertSemanticPreviewBindings(context.request.semanticModel, context.request.appSpec, preview.preview.appSpec);
  return {
    summary: `已生成 ${changeSet.operations.length} 项待确认变更，正式 AppSpec 尚未修改。`,
    data: {
      changeSetId: changeSet.id,
      operationCount: changeSet.operations.length,
      operationTypes: changeSet.operations.map((operation) => operation.type),
      affectedPages: [...new Set(changeSet.operations.map((operation) => operation.pageId))],
    },
    pendingChangeSet: changeSet,
  };
}

export const createEdsLineIssueChartPreview = defineTool({
  name: "createEdsLineIssueChartPreview",
  description: "为指定 EDS 线体生成异常类型图表的待确认预览，支持柱状图、折线图、面积图、饼图和环形图。只需提供线体、指标和图表类型，服务端负责安全的数据绑定与当前日期/班次筛选；绝不自动应用。",
  mode: "changePreview",
  schema: z.object({
    line: z.string().trim().min(1).max(100),
    metric: z.enum(["occurrences", "minutes"]),
    chartType: z.enum(CHART_TYPES).optional(),
  }).strict(),
  execute: ({ line, metric, chartType = "bar" }, context) => {
    const workspace = context.request.edsWorkspace;
    if (!workspace) throw new StudioValidationError("EDS 图表预览失败", ["当前工作区没有 EDS 派生汇总"]);
    if (!workspace.lineIssueSummary?.length) {
      throw new StudioValidationError("EDS 图表预览失败", ["当前派生汇总缺少线体与异常类型交叉维度，请重新导入工作簿"]);
    }
    const selectedLine = workspace.lineSummary.find((item) => item.label.toLocaleLowerCase("zh-CN") === line.toLocaleLowerCase("zh-CN"))?.label;
    if (!selectedLine) throw new StudioValidationError("EDS 图表预览失败", [`线体不存在：${sanitizeHarnessText(line)}`]);
    const page = context.request.appSpec.pages.find((candidate) => candidate.id === context.request.pageId);
    const parent = page ? compactNodes(page.root).find((node) => node.type === "DashboardGrid") : undefined;
    if (!page || !parent) throw new StudioValidationError("EDS 图表预览失败", ["当前页面缺少分析图表组"]);
    const isMinutes = metric === "minutes";
    const chartTypeLabel = { bar: "柱状图", line: "折线图", area: "面积图", pie: "饼图", donut: "环形图" }[chartType];
    const safeLineId = selectedLine.replace(/[^A-Za-z0-9_-]/gu, "_").slice(0, 60) || "line";
    const nodeId = uniqueAppNodeId(context, `eds_chart_${safeLineId}_${metric}_${chartType}`);
    return previewModelDraft({
      message: `增加 ${selectedLine} 异常类型${isMinutes ? "时长" : "次数"}${chartTypeLabel}。`,
      operations: [{
        type: "addNode",
        pageId: page.id,
        parentId: parent.id,
        node: {
          id: nodeId,
          type: "BarChart",
          props: {
            title: `${selectedLine} 异常类型${isMinutes ? "时长" : "分布"}`,
            subtitle: `${workspace.summary.date} · ${workspace.summary.shift} · 按${isMinutes ? "分钟" : "次数"}降序`,
            chartType,
            binding: {
              dataSourceId: "dataset_eds_breakdown",
              field: metric,
              aggregation: "sum",
              groupBy: "category",
              filters: [
                { field: "work_date", operator: "equals", value: workspace.summary.date },
                { field: "shift", operator: "equals", value: workspace.summary.shift },
                { field: "view", operator: "equals", value: "线体异常分类" },
                { field: "line", operator: "equals", value: selectedLine },
              ],
              sort: [{ field: metric, direction: "desc" }],
              limit: 14,
              format: { style: "number", decimals: isMinutes ? 2 : 0, ...(isMinutes ? { suffix: " 分钟" } : {}) },
            },
          },
        },
      }],
    }, context);
  },
});

export const createEdsBreakdownChartPreview = defineTool({
  name: "createEdsBreakdownChartPreview",
  description: "根据当前 EDS 派生汇总生成分类图表的待确认预览。支持按异常类型或线体汇总异常次数/分钟，并输出柱状图、折线图、面积图、饼图或环形图；日期、班次、汇总视图、排序和字段绑定均由服务端安全生成。",
  mode: "changePreview",
  schema: z.object({
    dimension: z.enum(["issue", "line"]),
    metric: z.enum(["occurrences", "minutes"]),
    chartType: z.enum(CHART_TYPES),
    limit: z.number().int().min(3).max(14).optional(),
  }).strict(),
  execute: ({ dimension, metric, chartType, limit }, context) => {
    const workspace = context.request.edsWorkspace;
    if (!workspace) throw new StudioValidationError("EDS 图表预览失败", ["当前工作区没有 EDS 派生汇总"]);
    const page = context.request.appSpec.pages.find((candidate) => candidate.id === context.request.pageId);
    const parent = page ? compactNodes(page.root).find((node) => node.type === "DashboardGrid") : undefined;
    if (!page || !parent) throw new StudioValidationError("EDS 图表预览失败", ["当前页面缺少分析图表组"]);
    const dimensionLabel = dimension === "issue" ? "异常类型" : "线体";
    const metricLabel = metric === "minutes" ? "异常分钟" : "异常次数";
    const chartTypeLabel = { bar: "柱状图", line: "折线图", area: "面积图", pie: "饼图", donut: "环形图" }[chartType];
    const chartLimit = limit ?? (chartType === "pie" || chartType === "donut" ? 8 : 10);
    const nodeId = uniqueAppNodeId(context, `eds_chart_${dimension}_${metric}_${chartType}`);
    return previewModelDraft({
      message: `增加${dimensionLabel}${metricLabel}${chartTypeLabel}。`,
      operations: [{
        type: "addNode",
        pageId: page.id,
        parentId: parent.id,
        node: {
          id: nodeId,
          type: "BarChart",
          props: {
            title: `${dimensionLabel}${metricLabel}${chartType === "pie" || chartType === "donut" ? "占比" : ""}`,
            subtitle: `${workspace.summary.date} · ${workspace.summary.shift} · Top ${chartLimit}`,
            chartType,
            color: "green",
            showValues: chartType === "pie" || chartType === "donut",
            binding: {
              dataSourceId: "dataset_eds_breakdown",
              field: metric,
              aggregation: "sum",
              groupBy: "category",
              filters: [
                { field: "work_date", operator: "equals", value: workspace.summary.date },
                { field: "shift", operator: "equals", value: workspace.summary.shift },
                { field: "view", operator: "equals", value: dimension === "issue" ? "异常分类" : "线体" },
              ],
              sort: [{ field: metric, direction: "desc" }],
              limit: chartLimit,
              format: { style: "number", decimals: metric === "minutes" ? 2 : 0, ...(metric === "minutes" ? { suffix: " 分钟" } : {}) },
            },
          },
        },
      }],
    }, context);
  },
});

const edsTableFieldSchema = z.enum(EDS_TABLE_FIELDS);

const edsTableColumnDefinitions = {
  view: { field: "view", label: "视图", aggregation: "none", format: { style: "text" } },
  line: { field: "line", label: "线体", aggregation: "none", format: { style: "text" } },
  category: { field: "category", label: "异常分类", aggregation: "none", format: { style: "text" } },
  occurrences: { field: "occurrences", label: "异常次数", aggregation: "sum", format: { style: "number", decimals: 0 } },
  minutes: { field: "minutes", label: "异常分钟", aggregation: "sum", format: { style: "number", decimals: 2 } },
} as const;

const updateEdsTablePreviewSchema = z.object({
  nodeId: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(100).optional(),
  subtitle: z.string().trim().max(240).optional(),
  actionLabel: z.string().trim().min(1).max(40).optional(),
  visibleColumns: z.array(edsTableFieldSchema).min(1).max(EDS_TABLE_FIELDS.length).optional(),
  sort: z.array(z.object({
    field: edsTableFieldSchema,
    direction: z.enum(["asc", "desc"]),
  }).strict()).min(1).max(4).optional(),
  density: z.enum(["comfortable", "compact"]).optional(),
  stripedRows: z.boolean().optional(),
  accentColor: z.enum(BAR_CHART_COLORS).optional(),
}).strict().superRefine((args, validation) => {
  const updates = Object.entries(args).filter(([key, value]) => key !== "nodeId" && value !== undefined);
  if (updates.length === 0) validation.addIssue({ code: "custom", message: "至少需要提供一项表格修改" });
  if (args.visibleColumns && new Set(args.visibleColumns).size !== args.visibleColumns.length) {
    validation.addIssue({ code: "custom", path: ["visibleColumns"], message: "显示字段不能重复" });
  }
  if (args.sort && new Set(args.sort.map((item) => item.field)).size !== args.sort.length) {
    validation.addIssue({ code: "custom", path: ["sort"], message: "多级排序字段不能重复" });
  }
});

export const updateEdsTablePreview = defineTool({
  name: "updateEdsTablePreview",
  description: "调整当前 EDS 派生表格的多级排序、显示字段、标题和样式，并生成待确认 ChangeSet。sort 数组顺序就是排序优先级；line=线体、category=异常分类、occurrences=次数、minutes=分钟。只修改现有组件，绝不自动应用。",
  mode: "changePreview",
  schema: updateEdsTablePreviewSchema,
  execute: (args, context) => {
    const page = context.request.appSpec.pages.find((candidate) => candidate.id === context.request.pageId);
    const node = page ? findAppNode(page.root, args.nodeId) : undefined;
    if (!page || !node) throw new StudioValidationError("EDS 表格预览失败", [`当前页面不存在组件：${sanitizeHarnessText(args.nodeId)}`]);
    if (node.type !== "DataTable" || node.props.binding.dataSourceId !== EDS_BREAKDOWN_DATA_SOURCE_ID) {
      throw new StudioValidationError("EDS 表格预览失败", ["只允许调整绑定 EDS 派生汇总的现有表格"]);
    }

    const props: Record<string, unknown> = {};
    if (args.title !== undefined) props.title = args.title;
    if (args.subtitle !== undefined) props.subtitle = args.subtitle;
    if (args.actionLabel !== undefined) props.actionLabel = args.actionLabel;
    if (args.density !== undefined) props.density = args.density;
    if (args.stripedRows !== undefined) props.stripedRows = args.stripedRows;
    if (args.accentColor !== undefined) props.accentColor = args.accentColor;
    if (args.visibleColumns || args.sort) {
      const fields = args.visibleColumns ?? (node.props.binding.columns ?? []).map((column) => column.field)
        .filter((field): field is (typeof EDS_TABLE_FIELDS)[number] => EDS_TABLE_FIELDS.includes(field as (typeof EDS_TABLE_FIELDS)[number]));
      props.binding = {
        ...node.props.binding,
        ...(args.sort ? { sort: args.sort } : {}),
        ...(args.visibleColumns ? {
          columns: fields.map((field) => structuredClone(edsTableColumnDefinitions[field])),
        } : {}),
      };
    }

    return previewModelDraft({
      message: `已生成“${args.title ?? node.props.title}”表格调整预览，等待确认后应用。`,
      operations: [{ type: "updateNodeProps", pageId: page.id, nodeId: node.id, props }],
    }, context);
  },
});

export const createChangeSetPreview = defineTool({
  name: "createChangeSetPreview",
  description: "把模型操作编译并校验为待确认 ChangeSet。只生成预览，绝不应用正式状态。",
  mode: "changePreview",
  schema: modelPlanDraftSchema,
  execute: previewModelDraft,
});
