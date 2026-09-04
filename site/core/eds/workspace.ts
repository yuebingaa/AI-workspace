import { z } from "zod";
import type { ChangeSetExecutionState } from "@/core/changesets";
import type { AppPage, AppSpec, DataBinding, DataProduct, DataRow, DataSourceDefinition, DataSourceField, LocalDataRuntime } from "@/core/models";
import { assertValidAppSpecDataBindings, validateRuntimeRows } from "@/core/data";
import { appSpecSchema, dataProductSchema } from "@/core/schemas";
import { toProjectIsoDateTime } from "@/core/time/project-iso";
import { EDS_RULE_VERSION, EDS_TEMPLATE_VERSION } from "./built-in";
import { edsChartItemSchema, type EdsAnalysisResponse } from "./contracts";

export const EDS_WORKSPACE_VERSION = 1 as const;
export const EDS_WORKSPACE_PAGE_ID = "page_eds_analysis";
export const EDS_OVERVIEW_DATA_SOURCE_ID = "dataset_eds_overview";
export const EDS_BREAKDOWN_DATA_SOURCE_ID = "dataset_eds_breakdown";

const summarySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  shift: z.string().min(1).max(50),
  inputRows: z.number().int().nonnegative(),
  matchedRows: z.number().int().nonnegative(),
  issueCount: z.literal(14),
  channelCount: z.literal(20),
  totalOccurrences: z.number().int().nonnegative(),
  totalMinutes: z.number().finite().nonnegative(),
}).strict();

const workspaceReportSchema = z.object({
  summary: summarySchema,
  issueSummary: z.array(edsChartItemSchema).length(14),
  lineSummary: z.array(edsChartItemSchema).min(1).max(20),
}).strict();

type EdsWorkspaceReport = z.infer<typeof workspaceReportSchema>;

function validateReport(
  report: EdsWorkspaceReport,
  context: z.RefinementCtx,
  pathPrefix: Array<string | number> = [],
): void {
  const count = (items: Array<{ count: number }>) => items.reduce((total, item) => total + item.count, 0);
  const minutes = (items: Array<{ minutes: number }>) => items.reduce((total, item) => total + item.minutes, 0);
  const closeEnough = (left: number, right: number) => Math.abs(left - right) <= Math.max(1e-8, Math.abs(right) * 1e-10);
  if (report.summary.matchedRows !== report.summary.totalOccurrences) {
    context.addIssue({ code: "custom", path: [...pathPrefix, "summary", "totalOccurrences"], message: "异常次数必须等于命中记录数" });
  }
  for (const [key, items] of [["issueSummary", report.issueSummary], ["lineSummary", report.lineSummary]] as const) {
    if (count(items) !== report.summary.totalOccurrences) {
      context.addIssue({ code: "custom", path: [...pathPrefix, key], message: "分类次数合计必须等于总异常次数" });
    }
    if (!closeEnough(minutes(items), report.summary.totalMinutes)) {
      context.addIssue({ code: "custom", path: [...pathPrefix, key], message: "分类时长合计必须等于总异常时长" });
    }
    if (new Set(items.map((item) => item.label)).size !== items.length) {
      context.addIssue({ code: "custom", path: [...pathPrefix, key], message: "分类标签不能重复" });
    }
  }
}

export const edsWorkspaceSnapshotSchema = z.object({
  version: z.literal(EDS_WORKSPACE_VERSION),
  generatedAt: z.iso.datetime(),
  summary: summarySchema,
  issueSummary: z.array(edsChartItemSchema).length(14),
  lineSummary: z.array(edsChartItemSchema).min(1).max(20),
  reports: z.array(workspaceReportSchema).min(2).max(20).optional(),
  configuration: z.object({
    templateVersion: z.literal(EDS_TEMPLATE_VERSION),
    ruleVersion: z.literal(EDS_RULE_VERSION),
  }).strict(),
}).strict().superRefine((snapshot, context) => {
  validateReport(snapshot, context);
  if (snapshot.reports) {
    snapshot.reports.forEach((report, index) => validateReport(report, context, ["reports", index]));
    const keys = snapshot.reports.map((report) => `${report.summary.date}\u0000${report.summary.shift}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: "custom", path: ["reports"], message: "日期和班次组合不能重复" });
    }
    const active = snapshot.reports.find((report) => (
      report.summary.date === snapshot.summary.date && report.summary.shift === snapshot.summary.shift
    ));
    if (!active || JSON.stringify(active) !== JSON.stringify({
      summary: snapshot.summary,
      issueSummary: snapshot.issueSummary,
      lineSummary: snapshot.lineSummary,
    })) {
      context.addIssue({ code: "custom", path: ["reports"], message: "当前报告必须与报告集合中的对应日期和班次完全一致" });
    }
  }
});

export type EdsWorkspaceSnapshot = z.infer<typeof edsWorkspaceSnapshotSchema>;

function generatedAt(clock: () => Date): string {
  let now: Date;
  try {
    now = clock();
  } catch {
    throw new Error("EDS 工作区时钟必须返回有效 Date。");
  }
  const serialized = toProjectIsoDateTime(now);
  if (!serialized) throw new Error("EDS 工作区时钟必须返回有效 Date。");
  return serialized;
}

export function createEdsWorkspaceSnapshot(
  result: EdsAnalysisResponse,
  clock: () => Date = () => new Date(),
): EdsWorkspaceSnapshot {
  return edsWorkspaceSnapshotSchema.parse({
    version: EDS_WORKSPACE_VERSION,
    generatedAt: generatedAt(clock),
    summary: {
      date: result.summary.date,
      shift: result.summary.shift,
      inputRows: result.summary.inputRows,
      matchedRows: result.summary.matchedRows,
      issueCount: result.summary.issueCount,
      channelCount: result.summary.channelCount,
      totalOccurrences: result.summary.totalOccurrences,
      totalMinutes: result.summary.totalMinutes,
    },
    issueSummary: result.issueSummary,
    lineSummary: result.lineSummary,
    configuration: {
      templateVersion: result.configuration.templateVersion,
      ruleVersion: result.configuration.ruleVersion,
    },
  });
}

function reportFromResult(result: EdsAnalysisResponse): EdsWorkspaceReport {
  return workspaceReportSchema.parse({
    summary: {
      date: result.summary.date,
      shift: result.summary.shift,
      inputRows: result.summary.inputRows,
      matchedRows: result.summary.matchedRows,
      issueCount: result.summary.issueCount,
      channelCount: result.summary.channelCount,
      totalOccurrences: result.summary.totalOccurrences,
      totalMinutes: result.summary.totalMinutes,
    },
    issueSummary: result.issueSummary,
    lineSummary: result.lineSummary,
  });
}

function reportsFromSnapshot(snapshot: EdsWorkspaceSnapshot): EdsWorkspaceReport[] {
  return snapshot.reports ?? [{
    summary: snapshot.summary,
    issueSummary: snapshot.issueSummary,
    lineSummary: snapshot.lineSummary,
  }];
}

export function createEdsWorkspaceSnapshotForResults(
  results: EdsAnalysisResponse[],
  activeResultIndex = 0,
  clock: () => Date = () => new Date(),
): EdsWorkspaceSnapshot {
  if (results.length < 1 || results.length > 20) throw new Error("EDS 工作区报告数量必须为 1–20 份。");
  if (!Number.isInteger(activeResultIndex) || activeResultIndex < 0 || activeResultIndex >= results.length) {
    throw new Error("EDS 工作区当前报告索引无效。");
  }
  const reports = results.map(reportFromResult);
  const active = reports[activeResultIndex];
  return edsWorkspaceSnapshotSchema.parse({
    version: EDS_WORKSPACE_VERSION,
    generatedAt: generatedAt(clock),
    ...active,
    ...(reports.length > 1 ? { reports } : {}),
    configuration: {
      templateVersion: results[activeResultIndex].configuration.templateVersion,
      ruleVersion: results[activeResultIndex].configuration.ruleVersion,
    },
  });
}

export function getEdsWorkspaceReports(snapshot: EdsWorkspaceSnapshot): EdsWorkspaceReport[] {
  const parsed = edsWorkspaceSnapshotSchema.parse(snapshot);
  return structuredClone(reportsFromSnapshot(parsed));
}

export function selectEdsWorkspaceReport(snapshot: EdsWorkspaceSnapshot, reportIndex: number): EdsWorkspaceSnapshot {
  const parsed = edsWorkspaceSnapshotSchema.parse(snapshot);
  const reports = reportsFromSnapshot(parsed);
  if (!Number.isInteger(reportIndex) || reportIndex < 0 || reportIndex >= reports.length) {
    throw new Error("EDS 工作区报告索引无效。");
  }
  return edsWorkspaceSnapshotSchema.parse({ ...parsed, ...reports[reportIndex] });
}

const stringField = (name: string, label: string, type: "string" | "date" = "string"): DataSourceField => ({
  name,
  label,
  type,
  aggregatable: false,
  supportedAggregations: ["none", "count", "countDistinct"],
  nullCount: 0,
  nullRate: 0,
});

const numberField = (name: string, label: string): DataSourceField => ({
  name,
  label,
  type: "number" as const,
  aggregatable: true,
  supportedAggregations: ["none", "sum", "average", "count", "countDistinct", "min", "max"],
  nullCount: 0,
  nullRate: 0,
});

export function createEdsWorkspaceDataSources(snapshot: EdsWorkspaceSnapshot): DataSourceDefinition[] {
  const parsed = edsWorkspaceSnapshotSchema.parse(snapshot);
  const reports = reportsFromSnapshot(parsed);
  return [
    {
      id: EDS_OVERVIEW_DATA_SOURCE_ID,
      name: "EDS 分析总览",
      rowCount: reports.length,
      columnCount: 14,
      qualityScore: 100,
      updatedAt: parsed.generatedAt,
      sourceType: "json",
      aiAccessPolicy: "not-required",
      fields: [
        stringField("work_date", "工作日期", "date"),
        stringField("shift", "班次"),
        numberField("input_rows", "输入明细行数"),
        numberField("matched_rows", "命中记录行数"),
        numberField("total_occurrences", "异常次数"),
        numberField("total_minutes", "异常分钟数"),
        numberField("issue_count", "异常类型数"),
        numberField("channel_count", "统计通道数"),
        stringField("template_version", "报表模板版本"),
        stringField("rule_version", "统计规则版本"),
        stringField("top_line", "异常次数最多线体"),
        numberField("top_line_occurrences", "最高线体异常次数"),
        stringField("top_issue", "累计时间最长异常类型"),
        numberField("top_issue_minutes", "最长异常累计分钟"),
      ],
    },
    {
      id: EDS_BREAKDOWN_DATA_SOURCE_ID,
      name: "EDS 线体与异常分类汇总",
      rowCount: reports.reduce((total, report) => total + report.lineSummary.length + report.issueSummary.length, 0),
      columnCount: 6,
      qualityScore: 100,
      updatedAt: parsed.generatedAt,
      sourceType: "json",
      aiAccessPolicy: "not-required",
      fields: [
        stringField("work_date", "工作日期", "date"),
        stringField("shift", "班次"),
        stringField("view", "汇总视图"),
        stringField("category", "分类名称"),
        numberField("occurrences", "异常次数"),
        numberField("minutes", "异常分钟数"),
      ],
    },
  ];
}

export function createEdsWorkspaceRuntime(snapshot: EdsWorkspaceSnapshot): LocalDataRuntime {
  const parsed = edsWorkspaceSnapshotSchema.parse(snapshot);
  const reports = reportsFromSnapshot(parsed);
  const overviewRows: DataRow[] = reports.map((report) => {
    const topLine = [...report.lineSummary].sort((a, b) => b.count - a.count)[0];
    const topIssue = [...report.issueSummary].sort((a, b) => b.minutes - a.minutes)[0];
    return {
      work_date: report.summary.date,
      shift: report.summary.shift,
      input_rows: report.summary.inputRows,
      matched_rows: report.summary.matchedRows,
      total_occurrences: report.summary.totalOccurrences,
      total_minutes: report.summary.totalMinutes,
      issue_count: report.summary.issueCount,
      channel_count: report.summary.channelCount,
      template_version: parsed.configuration.templateVersion,
      rule_version: parsed.configuration.ruleVersion,
      top_line: topLine.label,
      top_line_occurrences: topLine.count,
      top_issue: topIssue.label,
      top_issue_minutes: topIssue.minutes,
    };
  });
  const breakdownRows: DataRow[] = reports.flatMap((report) => [
    ...report.lineSummary.map((item) => ({ work_date: report.summary.date, shift: report.summary.shift, view: "线体", category: item.label, occurrences: item.count, minutes: item.minutes })),
    ...report.issueSummary.map((item) => ({ work_date: report.summary.date, shift: report.summary.shift, view: "异常分类", category: item.label, occurrences: item.count, minutes: item.minutes })),
  ]);
  const sources = createEdsWorkspaceDataSources(parsed);
  validateRuntimeRows(sources[0], overviewRows);
  validateRuntimeRows(sources[1], breakdownRows);
  return { rowsByDataSourceId: {
    [EDS_OVERVIEW_DATA_SOURCE_ID]: overviewRows,
    [EDS_BREAKDOWN_DATA_SOURCE_ID]: breakdownRows,
  } };
}

export function mergeEdsWorkspaceRuntime(
  runtime: LocalDataRuntime,
  snapshot: EdsWorkspaceSnapshot | null,
): LocalDataRuntime {
  if (!snapshot) return structuredClone(runtime);
  return {
    rowsByDataSourceId: {
      ...structuredClone(runtime.rowsByDataSourceId),
      ...createEdsWorkspaceRuntime(snapshot).rowsByDataSourceId,
    },
  };
}

function binding(dataSourceId: string, field: string, overrides: Partial<DataBinding> = {}): DataBinding {
  return {
    dataSourceId,
    field,
    aggregation: "sum",
    groupBy: null,
    filters: [],
    sort: [],
    limit: 20,
    format: { style: "number", decimals: 0 },
    ...overrides,
  };
}

function insight(snapshot: EdsWorkspaceSnapshot): string {
  const topLine = [...snapshot.lineSummary].sort((a, b) => b.count - a.count)[0];
  const topIssue = [...snapshot.issueSummary].sort((a, b) => b.minutes - a.minutes)[0];
  return `异常次数最多的线体为 ${topLine.label}（${topLine.count} 次）；累计时间最长的异常为“${topIssue.label}”（${topIssue.minutes.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 分钟）。`;
}

export function createEdsWorkspacePage(snapshot: EdsWorkspaceSnapshot): AppPage {
  const parsed = edsWorkspaceSnapshotSchema.parse(snapshot);
  const hitRate = parsed.summary.inputRows === 0 ? 0 : parsed.summary.matchedRows / parsed.summary.inputRows * 100;
  const scopeFilters: DataBinding["filters"] = [
    { field: "work_date", operator: "equals", value: parsed.summary.date },
    { field: "shift", operator: "equals", value: parsed.summary.shift },
  ];
  return {
    id: EDS_WORKSPACE_PAGE_ID,
    title: "EDS 异常分析",
    route: "/eds-analysis",
    root: {
      id: "page_eds_analysis_root",
      type: "PageRoot",
      props: {},
      children: [
        {
          id: "page_eds_analysis_header",
          type: "PageHeader",
          props: {
            eyebrow: "EDS OPERATIONS",
            title: "飞达异常分析看板",
            description: "基于内置模板和固定统计规则生成；仅展示可持久化的派生汇总。",
            dateRange: `${parsed.summary.date} · ${parsed.summary.shift}`,
          },
        },
        {
          id: "page_eds_analysis_insight",
          type: "InsightBanner",
          props: { title: "自动分析洞察", description: insight(parsed), actionLabel: "汇总已进入 AI 上下文" },
        },
        {
          id: "page_eds_analysis_metrics",
          type: "MetricGrid",
          props: { columns: 4 },
          children: [
            { id: "eds_metric_input", type: "MetricCard", props: { label: "输入明细", trend: "完整输入行数", binding: binding(EDS_OVERVIEW_DATA_SOURCE_ID, "input_rows", { filters: scopeFilters }) } },
            { id: "eds_metric_matched", type: "MetricCard", props: { label: "命中记录", trend: `命中率 ${hitRate.toFixed(1)}%`, binding: binding(EDS_OVERVIEW_DATA_SOURCE_ID, "matched_rows", { filters: scopeFilters }) } },
            { id: "eds_metric_occurrences", type: "MetricCard", props: { label: "异常次数", trend: "与命中记录一致", binding: binding(EDS_OVERVIEW_DATA_SOURCE_ID, "total_occurrences", { filters: scopeFilters }) } },
            { id: "eds_metric_minutes", type: "MetricCard", props: { label: "异常时间", trend: `约 ${(parsed.summary.totalMinutes / 60).toFixed(2)} 小时`, binding: binding(EDS_OVERVIEW_DATA_SOURCE_ID, "total_minutes", { filters: scopeFilters, format: { style: "number", decimals: 2, suffix: " 分钟" } }) } },
          ],
        },
        {
          id: "page_eds_analysis_charts",
          type: "DashboardGrid",
          props: {},
          children: [
            {
              id: "eds_chart_lines",
              type: "BarChart",
              props: {
                title: "各线体异常次数",
                subtitle: `${parsed.lineSummary.length} 条线体 · 按次数降序`,
                binding: binding(EDS_BREAKDOWN_DATA_SOURCE_ID, "occurrences", {
                  groupBy: "category",
                  filters: [...scopeFilters, { field: "view", operator: "equals", value: "线体" }],
                  sort: [{ field: "occurrences", direction: "desc" }],
                  limit: 10,
                }),
              },
            },
            {
              id: "eds_data_boundary",
              type: "DataHealth",
              props: {
                title: "规则版本与数据边界",
                subtitle: `汇总生成于 ${new Date(parsed.generatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
                score: 100,
                items: [
                  { label: "报表模板", value: parsed.configuration.templateVersion, status: "ok" },
                  { label: "统计规则", value: parsed.configuration.ruleVersion, status: "ok" },
                  { label: "AI / 本地存储", value: "仅派生汇总", status: "ok" },
                ],
              },
            },
          ],
        },
        {
          id: "eds_chart_issues",
          type: "BarChart",
          props: {
            title: "异常类型累计时间 Top 8",
            subtitle: "14 类异常完整数据见下方表格 · 单位分钟",
            binding: binding(EDS_BREAKDOWN_DATA_SOURCE_ID, "minutes", {
              groupBy: "category",
              filters: [...scopeFilters, { field: "view", operator: "equals", value: "异常分类" }],
              sort: [{ field: "minutes", direction: "desc" }],
              limit: 8,
              format: { style: "number", decimals: 1 },
            }),
          },
        },
        {
          id: "eds_summary_table",
          type: "DataTable",
          props: {
            title: "线体与异常分类明细",
            subtitle: "共 24 条派生汇总，不含原始工作簿行",
            actionLabel: "派生汇总",
            binding: binding(EDS_BREAKDOWN_DATA_SOURCE_ID, "occurrences", {
              filters: scopeFilters,
              sort: [{ field: "occurrences", direction: "desc" }],
              limit: 40,
              columns: [
                { field: "view", label: "视图", aggregation: "none", format: { style: "text" } },
                { field: "category", label: "分类", aggregation: "none", format: { style: "text" } },
                { field: "occurrences", label: "异常次数", aggregation: "sum", format: { style: "number", decimals: 0 } },
                { field: "minutes", label: "异常分钟", aggregation: "sum", format: { style: "number", decimals: 2 } },
              ],
            }),
          },
        },
      ],
    },
  };
}

function upsertById<T extends { id: string }>(items: T[], additions: T[]): T[] {
  const ids = new Set(additions.map((item) => item.id));
  return [...items.filter((item) => !ids.has(item.id)), ...additions];
}

export function installEdsWorkspaceInAppSpec(appSpec: AppSpec, snapshot: EdsWorkspaceSnapshot): AppSpec {
  const parsed = edsWorkspaceSnapshotSchema.parse(snapshot);
  const page = createEdsWorkspacePage(parsed);
  const next = appSpecSchema.parse({
    ...appSpec,
    dataSources: upsertById(appSpec.dataSources, createEdsWorkspaceDataSources(parsed)),
    navigation: upsertById(appSpec.navigation, [{ id: "nav_eds_analysis", title: page.title, pageId: page.id }]),
    pages: upsertById(appSpec.pages, [page]),
  });
  assertValidAppSpecDataBindings(next);
  return next;
}

export function installEdsWorkspaceInDataProduct(dataProduct: DataProduct, snapshot: EdsWorkspaceSnapshot): DataProduct {
  const sources = createEdsWorkspaceDataSources(snapshot);
  return dataProductSchema.parse({
    ...dataProduct,
    name: "EDS 飞达异常分析",
    datasets: upsertById(dataProduct.datasets, sources.map((source) => ({
      id: source.id,
      name: source.name,
      rowCount: source.rowCount,
      columnCount: source.columnCount,
      qualityScore: source.qualityScore,
      sensitiveFieldCount: 0,
      aiAccessPolicy: "not-required" as const,
    }))),
    appSpec: installEdsWorkspaceInAppSpec(dataProduct.appSpec, snapshot),
  });
}

export function installEdsWorkspaceInExecution(
  execution: ChangeSetExecutionState,
  snapshot: EdsWorkspaceSnapshot,
): ChangeSetExecutionState {
  return {
    ...execution,
    present: installEdsWorkspaceInAppSpec(execution.present, snapshot),
    preview: execution.preview ? {
      ...execution.preview,
      appSpec: installEdsWorkspaceInAppSpec(execution.preview.appSpec, snapshot),
    } : null,
    history: execution.history.map((entry) => ({
      ...entry,
      appSpec: installEdsWorkspaceInAppSpec(entry.appSpec, snapshot),
    })),
  };
}

export function isEdsWorkspaceDataSourceId(id: string): boolean {
  return id === EDS_OVERVIEW_DATA_SOURCE_ID || id === EDS_BREAKDOWN_DATA_SOURCE_ID;
}

export function createEdsAuditSummary(snapshot: EdsWorkspaceSnapshot): string {
  const parsed = edsWorkspaceSnapshotSchema.parse(snapshot);
  const reports = reportsFromSnapshot(parsed).map((report) => {
    const lineText = report.lineSummary.map((item) => `${item.label}:${item.count}次/${item.minutes.toFixed(2)}分钟`).join("，");
    const issueText = report.issueSummary.map((item) => `${item.label}:${item.count}次/${item.minutes.toFixed(2)}分钟`).join("，");
    return `${report.summary.date} ${report.summary.shift}｜输入${report.summary.inputRows}行｜命中${report.summary.matchedRows}行｜异常${report.summary.totalOccurrences}次/${report.summary.totalMinutes.toFixed(2)}分钟｜线体[${lineText}]｜异常分类[${issueText}]`;
  }).join("｜报告分隔｜");
  return `生成 EDS 分析看板｜${reportsFromSnapshot(parsed).length}份派生汇总（不含原始行）｜${reports}｜模板${parsed.configuration.templateVersion}｜规则${parsed.configuration.ruleVersion}`;
}
