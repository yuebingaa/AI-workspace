import { z } from "zod";
import { compileModelPlanDraft, modelPlanDraftSchema } from "@/core/ai/operation-output";
import { createExecutionState, previewChangeSet } from "@/core/changesets";
import { EDS_BREAKDOWN_DATA_SOURCE_ID, getEdsWorkspaceReports } from "@/core/eds";
import type { EdsCellValue, EdsWorkbookSheet } from "@/core/eds";
import {
  analyzeDataSourceFields,
  executeDataRecipe,
  recipeWithStepCount,
} from "@/core/data";
import { BAR_CHART_COLORS, CHART_TYPES } from "@/core/models";
import type { AppNode, LocalDataRuntime } from "@/core/models";
import { studioCapabilities } from "@/core/permissions";
import { StudioValidationError } from "@/core/schemas";
import type {
  HarnessEditableNodeSummary,
  HarnessRequest,
  HarnessSemanticIntentDecision,
  HarnessToolExecutionResult,
  HarnessToolName,
} from "./contracts";
import { jsonByteLength, sanitizeHarnessText } from "./security";
import { resolveHarnessPageDataSourceIds } from "./context-selector";
import {
  indexRawWorkbook,
  publicRawWorkbookProfile,
  queryRawWorkbook,
  type RawWorkbookIndex,
} from "./raw-workbook-engine";

export const MAX_HARNESS_TOOL_RESULT_BYTES = 6_000;
export const DEFAULT_HARNESS_TOOL_RESULT_ENTRIES = 16;

export class HarnessToolArgumentsError extends StudioValidationError {
  constructor(
    readonly toolName: HarnessToolName,
    readonly issueSummary: string[],
  ) {
    super("Harness 工具参数校验失败", [
      `工具 ${toolName} 的参数不符合定义`,
      ...issueSummary,
    ]);
    this.name = "HarnessToolArgumentsError";
  }
}

export interface HarnessToolContext {
  request: HarnessRequest;
  dataRuntime: LocalDataRuntime;
  now(): number;
  id(): string;
  resultBudgetChars?: number;
  resultBudgetEntries?: number;
  excelExporter?: HarnessExcelExporter;
  rawWorkbook?: HarnessRawWorkbook;
}

export interface HarnessRawWorkbook {
  fileName: string;
  contentHash: string;
  sheets: EdsWorkbookSheet[];
}

export interface HarnessExcelExporterArgs {
  recipeId: string;
  fileName?: string;
}

export type HarnessExcelExporter = (
  args: HarnessExcelExporterArgs,
  context: HarnessToolContext,
) => Promise<HarnessToolExecutionResult>;

interface HarnessToolDefinition<Name extends HarnessToolName, Args> {
  name: Name;
  description: string;
  mode: "readOnly" | "changePreview";
  schema: z.ZodType<Args>;
  execute(args: Args, context: HarnessToolContext): HarnessToolExecutionResult | Promise<HarnessToolExecutionResult>;
}

function defineTool<Name extends HarnessToolName, Args>(definition: HarnessToolDefinition<Name, Args>) {
  return definition;
}

function sourceAndRows(context: HarnessToolContext, dataSourceId: string) {
  const source = context.request.appSpec.dataSources.find((candidate) => candidate.id === dataSourceId);
  if (!source) throw new StudioValidationError("Harness 数据源校验失败", [`数据源不存在：${dataSourceId}`]);
  const rows = context.dataRuntime.rowsByDataSourceId[dataSourceId];
  if (!rows) throw new StudioValidationError("Harness 数据源校验失败", [`数据源没有可用的服务端运行数据：${dataSourceId}`]);
  return { source, rows };
}

function recipeContext(context: HarnessToolContext, recipeId: string, stepCount?: number) {
  const recipe = context.request.recipes.find((candidate) => candidate.id === recipeId);
  if (!recipe) throw new StudioValidationError("Harness 配方校验失败", [`数据配方不存在：${recipeId}`]);
  const { source, rows } = sourceAndRows(context, recipe.sourceDatasetId);
  return { recipe: stepCount === undefined ? recipe : recipeWithStepCount(recipe, stepCount), source, rows };
}

function compactNodes(node: AppNode): Array<{ id: string; type: AppNode["type"]; childCount: number }> {
  return [
    { id: node.id, type: node.type, childCount: node.children?.length ?? 0 },
    ...(node.children?.flatMap(compactNodes) ?? []),
  ];
}

function findAppNode(node: AppNode, nodeId: string): AppNode | undefined {
  if (node.id === nodeId) return node;
  for (const child of node.children ?? []) {
    const match = findAppNode(child, nodeId);
    if (match) return match;
  }
  return undefined;
}

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

const analyzeEdsReports = defineTool({
  name: "analyzeEdsReports",
  description: "读取 EDS 工作区中全部日期/班次的派生汇总，返回 KPI、主要线体、主要异常类别、指定线体的异常分类和跨班次差异。只读；不接触原始工作簿或逐行明细。",
  mode: "readOnly",
  schema: z.object({}).strict(),
  execute: (_args, context) => {
    if (!context.request.edsWorkspace) {
      throw new StudioValidationError("EDS AI 分析失败", ["当前工作区没有已校验的 EDS 派生报告"]);
    }
    const reports = getEdsWorkspaceReports(context.request.edsWorkspace);
    const baseline = reports[0];
    const includeExpandedRankings = reports.length <= 4;
    const knownLines = [...new Set(reports.flatMap((report) => report.lineSummary.map((item) => item.label)))];
    const currentInstruction = context.request.instruction.toLocaleLowerCase("zh-CN");
    const previousInstruction = context.request.conversationContext?.previousInstruction?.toLocaleLowerCase("zh-CN") ?? "";
    const currentMentionedLines = knownLines.filter((line) => currentInstruction.includes(line.toLocaleLowerCase("zh-CN")));
    const previousMentionedLines = knownLines.filter((line) => previousInstruction.includes(line.toLocaleLowerCase("zh-CN")));
    const mentionedLines = currentMentionedLines.length > 0 ? currentMentionedLines : previousMentionedLines;
    const summaries = reports.map((report, index) => {
      const topLines = [...report.lineSummary].sort((left, right) => right.count - left.count).slice(0, includeExpandedRankings ? 3 : 1);
      const topIssues = [...report.issueSummary].sort((left, right) => right.minutes - left.minutes).slice(0, includeExpandedRankings ? 5 : 1);
      return {
        date: report.summary.date,
        shift: report.summary.shift,
        current: report.summary.date === context.request.edsWorkspace?.summary.date
          && report.summary.shift === context.request.edsWorkspace?.summary.shift,
        inputRows: report.summary.inputRows,
        matchedRows: report.summary.matchedRows,
        hitRatePercent: report.summary.inputRows === 0 ? 0 : report.summary.matchedRows / report.summary.inputRows * 100,
        totalOccurrences: report.summary.totalOccurrences,
        totalMinutes: report.summary.totalMinutes,
        deltaFromFirst: index === 0 ? null : {
          occurrences: report.summary.totalOccurrences - baseline.summary.totalOccurrences,
          minutes: report.summary.totalMinutes - baseline.summary.totalMinutes,
          hitRatePercentagePoints: (
            report.summary.inputRows === 0 ? 0 : report.summary.matchedRows / report.summary.inputRows * 100
          ) - (baseline.summary.inputRows === 0 ? 0 : baseline.summary.matchedRows / baseline.summary.inputRows * 100),
        },
        topLines: topLines.map((item) => ({ label: item.label, occurrences: item.count, minutes: item.minutes })),
        topIssues: topIssues.map((item) => ({ label: item.label, occurrences: item.count, minutes: item.minutes })),
        requestedLineIssues: mentionedLines.flatMap((line) => (report.lineIssueSummary ?? [])
          .filter((item) => item.line === line)
          .sort((left, right) => right.count - left.count || right.minutes - left.minutes)
          .map((item) => ({ line: item.line, label: item.label, occurrences: item.count, minutes: item.minutes }))),
      };
    });
    return {
      summary: `已读取 ${reports.length} 份 EDS 派生报告，包含各班次 KPI、主要线体、主要异常类别及相对首份报告的差异；未读取原始行。`,
      data: {
        reportCount: reports.length,
        baseline: { date: baseline.summary.date, shift: baseline.summary.shift },
        reports: summaries,
        templateVersion: context.request.edsWorkspace.configuration.templateVersion,
        ruleVersion: context.request.edsWorkspace.configuration.ruleVersion,
        lineIssueBreakdownAvailable: reports.every((report) => Boolean(report.lineIssueSummary?.length)),
        chartBindingHint: {
          dataSourceId: "dataset_eds_breakdown",
          measure: "occurrences",
          groupBy: "category",
          filters: "work_date=当前日期；shift=当前班次；view=线体异常分类；line=目标线体",
        },
        rawRowsIncluded: false,
      },
    };
  },
});

function workbookColumnLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + value % 26) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function rawCellValue(value: EdsCellValue): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  return value;
}

function attachedRawWorkbook(context: HarnessToolContext): HarnessRawWorkbook {
  if (!context.request.rawWorkbookManifest || !context.rawWorkbook) {
    throw new StudioValidationError("EDS 原始数据访问不可用", ["请重新导入原始工作簿，并勾选“允许 AI 完整扫描原始数据”"]);
  }
  const actualSheets = context.rawWorkbook.sheets.map((sheet) => ({
    name: sheet.sheet,
    rowCount: sheet.data.length,
    columnCount: sheet.data.reduce((maximum, row) => Math.max(maximum, row.length), 0),
  }));
  const declared = context.request.rawWorkbookManifest.sheets;
  if (context.rawWorkbook.fileName !== context.request.rawWorkbookManifest.fileName
    || context.rawWorkbook.contentHash !== context.request.rawWorkbookManifest.contentHash
    || JSON.stringify(actualSheets) !== JSON.stringify(declared)) {
    throw new StudioValidationError("EDS 原始数据访问校验失败", ["随请求上传的工作簿与服务端清单不一致"]);
  }
  return context.rawWorkbook;
}

const rawWorkbookIndexes = new WeakMap<HarnessRawWorkbook, RawWorkbookIndex>();

function indexedRawWorkbook(context: HarnessToolContext): RawWorkbookIndex {
  const workbook = attachedRawWorkbook(context);
  const cached = rawWorkbookIndexes.get(workbook);
  if (cached) return cached;
  const indexed = indexRawWorkbook(workbook.sheets, workbook.contentHash);
  rawWorkbookIndexes.set(workbook, indexed);
  return indexed;
}

const scanEdsRawWorkbook = defineTool({
  name: "scanEdsRawWorkbook",
  description: "完整扫描本次授权的 EDS 原始工作簿全部工作表与全部数据行，建立字段、类型、缺失值、数值范围和高频值概况。计算在服务端完成，不把整份文件塞进模型上下文。只读。",
  mode: "readOnly",
  schema: z.object({}).strict(),
  execute: (_args, context) => {
    const index = indexedRawWorkbook(context);
    return {
      summary: `已完整扫描 ${index.sheets.length} 张工作表、${index.scannedDataRowCount} 条数据行和 ${index.scannedCellCount} 个数据单元格；结果绑定数据版本 ${index.datasetVersion.slice(0, 16)}。`,
      data: publicRawWorkbookProfile(index),
    };
  },
});

const rawWorkbookScalarSchema = z.union([z.string().max(300), z.number().finite(), z.boolean()]);
const rawWorkbookFilterSchema = z.object({
  column: z.string().trim().min(1).max(100),
  operator: z.enum(["equals", "notEquals", "contains", "startsWith", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "between", "in", "isEmpty", "isNotEmpty"]),
  value: rawWorkbookScalarSchema.optional(),
  values: z.array(rawWorkbookScalarSchema).min(1).max(50).optional(),
}).strict().superRefine((filter, issue) => {
  if (["equals", "notEquals", "contains", "startsWith", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"].includes(filter.operator) && filter.value === undefined) {
    issue.addIssue({ code: "custom", path: ["value"], message: "该筛选操作需要 value" });
  }
  if (filter.operator === "between" && filter.values?.length !== 2) {
    issue.addIssue({ code: "custom", path: ["values"], message: "between 需要两个边界值" });
  }
  if (filter.operator === "in" && !filter.values?.length) {
    issue.addIssue({ code: "custom", path: ["values"], message: "in 需要至少一个候选值" });
  }
});
const rawWorkbookAggregationSchema = z.object({
  operation: z.enum(["count", "sum", "average", "minimum", "maximum", "distinctCount"]),
  column: z.string().trim().min(1).max(100).optional(),
  alias: z.string().trim().min(1).max(80),
}).strict().superRefine((aggregation, issue) => {
  if (aggregation.operation !== "count" && !aggregation.column) {
    issue.addIssue({ code: "custom", path: ["column"], message: "该聚合操作需要 column" });
  }
});
const rawWorkbookQuerySchema = z.object({
  mode: z.enum(["rows", "aggregate"]),
  sheetName: z.string().trim().min(1).max(100),
  select: z.array(z.string().trim().min(1).max(100)).min(1).max(20).optional(),
  filters: z.array(rawWorkbookFilterSchema).max(8).optional(),
  groupBy: z.array(z.string().trim().min(1).max(100)).max(3).optional(),
  aggregations: z.array(rawWorkbookAggregationSchema).min(1).max(8).optional(),
  orderBy: z.array(z.object({
    field: z.string().trim().min(1).max(100),
    direction: z.enum(["ascending", "descending"]),
  }).strict()).max(3).optional(),
  offset: z.number().int().min(0).max(50_000).optional(),
  limit: z.number().int().min(1).max(30).optional(),
}).strict().superRefine((query, issue) => {
  if (query.mode === "aggregate" && !query.aggregations?.length) {
    issue.addIssue({ code: "custom", path: ["aggregations"], message: "聚合查询需要 aggregations" });
  }
  if (query.mode === "rows" && (query.groupBy?.length || query.aggregations?.length)) {
    issue.addIssue({ code: "custom", path: ["mode"], message: "rows 模式不能包含分组或聚合" });
  }
});

const queryEdsRawWorkbook = defineTool({
  name: "queryEdsRawWorkbook",
  description: "对已完整扫描的原始工作簿执行确定性结构化查询。支持跨表(*)或单表筛选、返回带工作表/行号的原始记录，以及分组后的 count/sum/average/minimum/maximum/distinctCount；所有匹配和计算覆盖完整数据行，最多只向模型返回 30 条结果。列可用表头名、A/B 等列号，特殊字段 $sheet 和 $row 表示来源表与原始行号。只读。",
  mode: "readOnly",
  schema: rawWorkbookQuerySchema,
  execute: (args, context) => {
    const index = indexedRawWorkbook(context);
    try {
      const result = queryRawWorkbook(index, args);
      return {
        summary: `已在 ${result.sheets.length} 张工作表中完整检查 ${result.scannedDataRowCount} 条数据行，命中 ${result.matchedRowCount} 条，返回 ${result.returnedCount} 条${result.mode === "aggregate" ? "聚合结果" : "可溯源原始记录"}。`,
        data: result,
      };
    } catch (error) {
      throw new StudioValidationError("EDS 原始数据查询失败", [error instanceof Error ? error.message : "查询条件无效"]);
    }
  },
});

const inspectEdsRawWorkbook = defineTool({
  name: "inspectEdsRawWorkbook",
  description: "列出本次请求附带的 EDS 原始工作簿、工作表、真实行列数，并返回每张表开头的少量单元格用于识别表头。只读。",
  mode: "readOnly",
  schema: z.object({}).strict(),
  execute: (_args, context) => {
    const workbook = attachedRawWorkbook(context);
    return {
      summary: `已检查本次请求附带的原始工作簿，共 ${workbook.sheets.length} 张工作表；原始文件仍只在本次请求内存中使用。`,
      data: {
        fileName: workbook.fileName,
        sheets: workbook.sheets.map((sheet) => {
          const columnCount = sheet.data.reduce((maximum, row) => Math.max(maximum, row.length), 0);
          return {
            name: sheet.sheet,
            rowCount: sheet.data.length,
            columnCount,
            headerPreview: sheet.data.slice(0, 4).map((row, rowIndex) => ({
              rowNumber: rowIndex + 1,
              cells: Object.fromEntries(row.slice(0, 16).map((value, columnIndex) => [
                workbookColumnLabel(columnIndex),
                rawCellValue(value),
              ])),
            })),
          };
        }),
        access: "session-memory-cache",
      },
    };
  },
});

const readEdsRawRows = defineTool({
  name: "readEdsRawRows",
  description: "按工作表、起始行和列范围读取 EDS 原始单元格的真实值。行列均从 1 开始；单次最多 20 行、20 列。只读。",
  mode: "readOnly",
  schema: z.object({
    sheetName: z.string().trim().min(1).max(100),
    startRow: z.number().int().min(1).max(50_000).default(1),
    rowCount: z.number().int().min(1).max(20).default(10),
    startColumn: z.number().int().min(1).max(100).default(1),
    columnCount: z.number().int().min(1).max(20).default(12),
  }).strict(),
  execute: ({ sheetName, startRow, rowCount, startColumn, columnCount }, context) => {
    const workbook = attachedRawWorkbook(context);
    const sheet = workbook.sheets.find((candidate) => candidate.sheet === sheetName);
    if (!sheet) throw new StudioValidationError("EDS 原始数据读取失败", [`工作表不存在：${sheetName}`]);
    const rowStartIndex = startRow - 1;
    const columnStartIndex = startColumn - 1;
    const selected = sheet.data.slice(rowStartIndex, rowStartIndex + rowCount);
    const rows = selected.map((row, rowOffset) => ({
      rowNumber: startRow + rowOffset,
      cells: Object.fromEntries(Array.from({ length: columnCount }, (_, columnOffset) => {
        const columnIndex = columnStartIndex + columnOffset;
        return [workbookColumnLabel(columnIndex), rawCellValue(row[columnIndex])];
      })),
    }));
    const endRow = rows.at(-1)?.rowNumber ?? Math.min(startRow, sheet.data.length);
    return {
      summary: `已读取“${sheetName}”第 ${startRow}–${endRow} 行、${workbookColumnLabel(columnStartIndex)}–${workbookColumnLabel(columnStartIndex + columnCount - 1)} 列的原始单元格。`,
      data: {
        sheetName,
        startRow,
        endRow,
        startColumn,
        endColumn: startColumn + columnCount - 1,
        totalRows: sheet.data.length,
        hasMoreRows: rowStartIndex + selected.length < sheet.data.length,
        rows,
      },
    };
  },
});

const inspectDataset = defineTool({
  name: "inspectDataset",
  description: "检查数据源概览、真实行列数、质量和字段名称。只读。",
  mode: "readOnly",
  schema: z.object({ dataSourceId: z.string().min(1).max(120) }).strict(),
  execute: ({ dataSourceId }, context) => {
    const { source, rows } = sourceAndRows(context, dataSourceId);
    return {
      summary: `数据源“${source.name}”包含 ${rows.length} 行、${source.fields.length} 个字段，质量 ${source.qualityScore}%。`,
      data: {
        id: source.id,
        name: source.name,
        rowCount: rows.length,
        columnCount: source.fields.length,
        qualityScore: source.qualityScore,
        fields: source.fields.map((field) => ({ name: field.name, label: field.label, type: field.type })),
        fieldCount: source.fields.length,
      },
    };
  },
});

const inspectFields = defineTool({
  name: "inspectFields",
  description: "分析字段类型、空值、唯一值、数值范围和少量示例。只读。",
  mode: "readOnly",
  schema: z.object({
    dataSourceId: z.string().min(1).max(120),
    fields: z.array(z.string().min(1).max(120)).max(30).optional(),
  }).strict(),
  execute: ({ dataSourceId, fields }, context) => {
    const { source, rows } = sourceAndRows(context, dataSourceId);
    const allowed = fields ? new Set(fields) : null;
    if (allowed) {
      const missing = [...allowed].filter((field) => !source.fields.some((candidate) => candidate.name === field));
      if (missing.length) throw new StudioValidationError("Harness 字段校验失败", [`字段不存在：${missing.join("、")}`]);
    }
    const analyses = analyzeDataSourceFields(source, rows)
      .filter((analysis) => !allowed || allowed.has(analysis.field))
      .map((analysis) => {
        const field = source.fields.find((candidate) => candidate.name === analysis.field);
        const sensitive = field?.sensitiveCategories ?? [];
        const samples = sensitive.length === 0
          ? analysis.samples.slice(0, 3)
          : source.aiAccessPolicy === "masked"
            ? [`[已脱敏：${sensitive.join("/")}]`]
            : [];
        return { ...analysis, samples, sensitiveCategories: sensitive };
      });
    return { summary: `已分析 ${analyses.length} 个字段，输入 ${rows.length} 行。`, data: { dataSourceId, fields: analyses } };
  },
});

const previewDataRecipe = defineTool({
  name: "previewDataRecipe",
  description: "按顺序执行现有 DataRecipe，返回最多 10 行预览、步骤摘要和字段血缘。只读。",
  mode: "readOnly",
  schema: z.object({
    recipeId: z.string().min(1).max(120),
    stepCount: z.number().int().min(1).max(50).optional(),
  }).strict(),
  execute: ({ recipeId, stepCount }, context) => {
    const { recipe, source, rows } = recipeContext(context, recipeId, stepCount);
    const result = executeDataRecipe(recipe, source, rows);
    if (!result.success) throw new StudioValidationError("Harness 配方预览失败", [result.error]);
    return {
      summary: `配方“${recipe.name}”执行成功：${result.steps.length} 步，${rows.length} 行输入，${result.rows.length} 行输出。`,
      data: {
        fields: result.fields,
        outputRowCount: result.rows.length,
        steps: result.steps.map((step) => ({
          stepId: step.stepId,
          stepType: step.stepType,
          inputRowCount: step.inputRowCount,
          outputRowCount: step.outputRowCount,
          durationMs: step.durationMs,
        })),
        lineage: result.lineage,
      },
    };
  },
});

const validateDataRecipe = defineTool({
  name: "validateDataRecipe",
  description: "使用现有 DataRecipe Schema 和本地执行器验证配方。只读。",
  mode: "readOnly",
  schema: z.object({ recipeId: z.string().min(1).max(120) }).strict(),
  execute: ({ recipeId }, context) => {
    const { recipe, source, rows } = recipeContext(context, recipeId);
    const result = executeDataRecipe(recipe, source, rows);
    if (!result.success) throw new StudioValidationError("Harness 配方验证失败", [result.error]);
    return {
      summary: `配方“${recipe.name}”通过 Schema 和 ${result.steps.length} 个执行步骤验证。`,
      data: { valid: true, outputRowCount: result.rows.length, outputFields: result.fields },
    };
  },
});

const exportDataRecipeToExcel = defineTool({
  name: "exportDataRecipeToExcel",
  description: "把已成功预览的 DataRecipe 结果导出为临时 XLSX 下载文件。只导出配方结果，不修改 AppSpec。",
  mode: "readOnly",
  schema: z.object({
    recipeId: z.string().min(1).max(120),
    fileName: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  execute: async (args, context) => {
    if (!context.excelExporter) throw new StudioValidationError("Excel 导出能力不可用", ["服务端没有配置 Excel 导出器"]);
    return context.excelExporter(args, context);
  },
});

const inspectAppSpec = defineTool({
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

const createEdsLineIssueChartPreview = defineTool({
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

const createEdsBreakdownChartPreview = defineTool({
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

const EDS_TABLE_FIELDS = ["view", "line", "category", "occurrences", "minutes"] as const;
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

const updateEdsTablePreview = defineTool({
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

const createChangeSetPreview = defineTool({
  name: "createChangeSetPreview",
  description: "把模型操作编译并校验为待确认 ChangeSet。只生成预览，绝不应用正式状态。",
  mode: "changePreview",
  schema: modelPlanDraftSchema,
  execute: previewModelDraft,
});

export const harnessToolRegistry = {
  analyzeEdsReports,
  scanEdsRawWorkbook,
  queryEdsRawWorkbook,
  inspectEdsRawWorkbook,
  readEdsRawRows,
  inspectDataset,
  inspectFields,
  previewDataRecipe,
  validateDataRecipe,
  exportDataRecipeToExcel,
  inspectAppSpec,
  createEdsBreakdownChartPreview,
  createEdsLineIssueChartPreview,
  updateEdsTablePreview,
  createChangeSetPreview,
} satisfies Record<HarnessToolName, HarnessToolDefinition<HarnessToolName, unknown>>;

interface HarnessToolCatalogOptions {
  names?: HarnessToolName[];
  editableNodes?: HarnessEditableNodeSummary[];
  instruction?: string;
  request?: HarnessRequest;
  semanticIntent?: HarnessSemanticIntentDecision;
}

function stringEnum(values: string[]) {
  return { type: "string", enum: [...new Set(values)] };
}

function relevantProperties(node: HarnessEditableNodeSummary, instruction: string) {
  const titleKeys = new Set(["label", "title", "subtitle", "eyebrow"]);
  const explicitlyNamed = node.editableProperties.filter((property) => instruction.toLocaleLowerCase("zh-CN").includes(property.toLocaleLowerCase("zh-CN")));
  if (node.type === "BarChart" && /颜色|配色|色彩|蓝色|绿色|紫色|橙色|红色|青色/.test(instruction)) {
    return node.editableProperties.includes("color") ? ["color"] : [];
  }
  if (node.type === "BarChart" && /柱顶|顶部(?:数字|数值|标签)|数据标签|显示(?:数字|数值|标签)/.test(instruction)) {
    return node.editableProperties.includes("showValues") ? ["showValues"] : [];
  }
  if (node.type === "BarChart" && /图表类型|切换.{0,8}(?:图|图表)|改成.{0,8}(?:柱状|柱形|条形|折线|曲线|面积|饼|环形)|(?:柱状|柱形|条形|折线|曲线|面积|饼|环形)(?:图|图表)/.test(instruction)) {
    return node.editableProperties.includes("chartType") ? ["chartType"] : [];
  }
  if (instruction.includes("标题")) {
    const titles = node.editableProperties.filter((property) => titleKeys.has(property));
    if (titles.length > 0) return titles;
  }
  if (instruction.includes("描述")) return node.editableProperties.filter((property) => property === "description");
  return explicitlyNamed.length > 0 ? explicitlyNamed : node.editableProperties.filter((property) => property !== "binding").slice(0, 6);
}

function primitivePropertySchema(node: HarnessEditableNodeSummary, property: string) {
  if (node.type === "BarChart" && property === "color") {
    return {
      ...stringEnum([...BAR_CHART_COLORS]),
      description: "柱形颜色：green=绿色、blue=蓝色、violet=紫色、orange=橙色、red=红色、teal=青色。",
    };
  }
  if (node.type === "BarChart" && property === "showValues") return { type: "boolean" };
  if (node.type === "BarChart" && property === "chartType") {
    return {
      ...stringEnum([...CHART_TYPES]),
      description: "图表类型：bar=柱状图、line=折线图、area=面积图、pie=饼图、donut=环形图。",
    };
  }
  const value = node.currentValues[property];
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  return { type: "string", maxLength: 500 };
}

function compactMetricPropsSchema(request: HarnessRequest): Record<string, unknown> {
  const dataSourceIds = resolveHarnessPageDataSourceIds(request);
  const fields = request.appSpec.dataSources
    .filter((source) => dataSourceIds.includes(source.id))
    .flatMap((source) => source.fields.map((field) => field.name));
  return {
    type: "object",
    additionalProperties: false,
    required: ["label", "trend", "binding"],
    properties: {
      label: { type: "string", maxLength: 100 },
      trend: { type: "string", maxLength: 100 },
      isNew: { type: "boolean" },
      binding: {
        type: "object",
        additionalProperties: false,
        required: ["dataSourceId", "field", "aggregation", "groupBy", "filters", "sort", "limit", "format"],
        properties: {
          dataSourceId: stringEnum(dataSourceIds),
          field: stringEnum(fields),
          aggregation: stringEnum(["none", "sum", "average", "count", "countDistinct", "min", "max"]),
          groupBy: { anyOf: [stringEnum(fields), { type: "null" }] },
          filters: { type: "array", maxItems: 0 },
          sort: { type: "array", maxItems: 0 },
          limit: { type: "integer", minimum: 1, maximum: 10_000 },
          format: {
            type: "object",
            additionalProperties: false,
            required: ["style"],
            properties: {
              style: stringEnum(["auto", "text", "number", "currency", "percent"]),
              currency: stringEnum(["CNY", "USD"]),
              notation: stringEnum(["standard", "compact"]),
              decimals: { type: "integer", minimum: 0, maximum: 8 },
              prefix: { type: "string", maxLength: 20 },
              suffix: { type: "string", maxLength: 20 },
            },
          },
        },
      },
    },
  };
}

function requestedChartTypes(instruction: string, semanticIntent?: HarnessSemanticIntentDecision): string[] {
  if (semanticIntent && semanticIntent.chartType !== "auto") return [semanticIntent.chartType];
  if (/环形图|圆环图|甜甜圈图/.test(instruction)) return ["donut"];
  if (/饼(?:状)?图/.test(instruction)) return ["pie"];
  if (/面积图/.test(instruction)) return ["area"];
  if (/折线图|曲线图/.test(instruction)) return ["line"];
  if (/柱状图|柱形图|条形图/.test(instruction)) return ["bar"];
  return [...CHART_TYPES];
}

function compactBarChartPropsSchema(
  request: HarnessRequest,
  instruction = "",
  semanticIntent?: HarnessSemanticIntentDecision,
): Record<string, unknown> {
  const dataSourceIds = resolveHarnessPageDataSourceIds(request);
  const sources = request.appSpec.dataSources.filter((source) => dataSourceIds.includes(source.id));
  const fields = sources.flatMap((source) => source.fields);
  const fieldNames = fields.map((field) => field.name);
  const measureFields = fields.filter((field) => field.type === "number" && field.aggregatable).map((field) => field.name);
  const groupFields = fields.filter((field) => field.type === "string" || field.type === "date").map((field) => field.name);
  const chartTypes = requestedChartTypes(instruction, semanticIntent);
  return {
    type: "object",
    additionalProperties: false,
    required: ["title", "subtitle", "chartType", "binding"],
    properties: {
      title: { type: "string", minLength: 1, maxLength: 100 },
      subtitle: { type: "string", maxLength: 200 },
      chartType: {
        ...stringEnum(chartTypes),
        description: "图表类型：bar=柱状图、line=折线图、area=面积图、pie=饼图、donut=环形图。饼图和环形图适合分类占比，折线图和面积图适合趋势。",
      },
      color: stringEnum([...BAR_CHART_COLORS]),
      showValues: { type: "boolean" },
      binding: {
        type: "object",
        additionalProperties: false,
        required: ["dataSourceId", "field", "aggregation", "groupBy", "filters", "sort", "limit", "format"],
        properties: {
          dataSourceId: stringEnum(dataSourceIds),
          field: stringEnum(measureFields),
          aggregation: stringEnum(["sum", "average", "count", "countDistinct", "min", "max"]),
          groupBy: stringEnum(groupFields),
          filters: {
            type: "array",
            minItems: 1,
            maxItems: 6,
            description: "EDS 线体异常分类图使用 work_date、shift、view=线体异常分类、line=目标线体四个筛选条件。",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["field", "operator", "value"],
              properties: {
                field: stringEnum(fieldNames),
                operator: stringEnum(["equals", "notEquals", "contains", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"]),
                value: { anyOf: [{ type: "string", maxLength: 200 }, { type: "number" }, { type: "boolean" }] },
              },
            },
          },
          sort: {
            type: "array",
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["field", "direction"],
              properties: { field: stringEnum(fieldNames), direction: stringEnum(["asc", "desc"]) },
            },
          },
          limit: { type: "integer", minimum: 1, maximum: 100 },
          format: {
            type: "object",
            additionalProperties: false,
            required: ["style"],
            properties: {
              style: stringEnum(["auto", "text", "number", "currency", "percent"]),
              currency: stringEnum(["CNY", "USD"]),
              notation: stringEnum(["standard", "compact"]),
              decimals: { type: "integer", minimum: 0, maximum: 8 },
              prefix: { type: "string", maxLength: 20 },
              suffix: { type: "string", maxLength: 20 },
            },
          },
        },
      },
    },
  };
}

function compactChangePreviewSchema(options: HarnessToolCatalogOptions): Record<string, unknown> {
  const editableNodes = options.editableNodes ?? [];
  const instruction = options.instruction ?? "";
  const updateVariants = editableNodes.flatMap((node) => {
    const propertyNames = relevantProperties(node, instruction);
    if (propertyNames.length === 0) return [];
    const properties = Object.fromEntries(propertyNames.map((property) => [
      property,
      primitivePropertySchema(node, property),
    ]));
    return [{
      type: "object",
      additionalProperties: false,
      required: ["type", "pageId", "nodeId", "props"],
      properties: {
        type: stringEnum(["updateNodeProps"]),
        pageId: stringEnum([node.pageId]),
        nodeId: stringEnum([node.nodeId]),
        props: {
          type: "object",
          minProperties: 1,
          additionalProperties: false,
          properties,
        },
      },
    }];
  });
  const metricParents = editableNodes.filter((node) => node.type === "MetricGrid");
  const chartParents = editableNodes.filter((node) => node.type === "DashboardGrid");
  const metricProps = options.request ? compactMetricPropsSchema(options.request) : {};
  const chartProps = options.request ? compactBarChartPropsSchema(options.request, instruction, options.semanticIntent) : {};
  const chartOrMetricBeforeAddVerb = /(?:柱状图|柱形图|条形图|图表|图|指标)[^。；]{0,40}(?:增加|添加)/.test(instruction);
  const explicitNewUnit = /(?:增加|添加)\s*(?:一|1|个|张|新的?)/.test(instruction);
  const additionIntent = options.semanticIntent
    ? options.semanticIntent.mode === "changePreview" && options.semanticIntent.changeAction === "add"
    : /生成|创建|新增|插入|加(?:一|个|张)|做(?:一|个|张)|画(?:一|个|张)/.test(instruction)
      || explicitNewUnit
      || (/(?:增加|添加)/.test(instruction) && !chartOrMetricBeforeAddVerb);
  const wantsMetric = options.semanticIntent
    ? options.semanticIntent.componentKind === "metric"
    : /指标|复购/.test(instruction);
  const wantsChart = options.semanticIntent
    ? options.semanticIntent.componentKind === "chart"
      || ["chart", "edsBreakdownChart", "edsLineIssueChart"].includes(options.semanticIntent.changeTarget)
    : /图|图表|柱状|柱形|条形|折线|曲线|面积|饼|环形|分栏/.test(instruction);
  const addMetricVariants = additionIntent && wantsMetric
    ? metricParents.map((parent) => ({
        type: "object",
        additionalProperties: false,
        required: ["type", "pageId", "parentId", "node"],
        properties: {
          type: stringEnum(["addNode"]),
          pageId: stringEnum([parent.pageId]),
          parentId: stringEnum([parent.nodeId]),
          position: { type: "integer", minimum: 0 },
          node: {
            type: "object",
            additionalProperties: false,
            required: ["id", "type", "props"],
            properties: {
              id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,119}$" },
              type: stringEnum(["MetricCard"]),
              props: metricProps,
            },
          },
        },
      }))
    : [];
  const addChartVariants = additionIntent && wantsChart
    ? chartParents.map((parent) => ({
        type: "object",
        additionalProperties: false,
        required: ["type", "pageId", "parentId", "node"],
        properties: {
          type: stringEnum(["addNode"]),
          pageId: stringEnum([parent.pageId]),
          parentId: stringEnum([parent.nodeId]),
          position: { type: "integer", minimum: 0 },
          node: {
            type: "object",
            additionalProperties: false,
            required: ["id", "type", "props"],
            properties: {
              id: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,119}$" },
              type: stringEnum(["BarChart"]),
              props: chartProps,
            },
          },
        },
      }))
    : [];
  const addVariants = [...addChartVariants, ...addMetricVariants];
  const operationVariants = addVariants.length > 0 ? addVariants : updateVariants;
  return {
    type: "object",
    additionalProperties: false,
    required: ["message", "operations"],
    properties: {
      message: { type: "string", minLength: 1, maxLength: 2_000 },
      operations: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: operationVariants.length === 1 ? operationVariants[0] : { oneOf: operationVariants },
      },
    },
  };
}

function scopedToolParameters(tool: (typeof harnessToolRegistry)[HarnessToolName], options: HarnessToolCatalogOptions) {
  if (!options.request) return z.toJSONSchema(tool.schema) as Record<string, unknown>;
  const dataSourceIds = resolveHarnessPageDataSourceIds(options.request);
  const fieldNames = options.request.appSpec.dataSources
    .filter((source) => dataSourceIds.includes(source.id))
    .flatMap((source) => source.fields.map((field) => field.name));
  const recipeIds = options.request.recipes
    .filter((recipe) => dataSourceIds.includes(recipe.sourceDatasetId))
    .map((recipe) => recipe.id);
  if (tool.name === "inspectDataset") {
    return { type: "object", additionalProperties: false, required: ["dataSourceId"], properties: { dataSourceId: stringEnum(dataSourceIds) } };
  }
  if (tool.name === "inspectFields") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["dataSourceId"],
      properties: {
        dataSourceId: stringEnum(dataSourceIds),
        fields: { type: "array", maxItems: 30, items: stringEnum(fieldNames) },
      },
    };
  }
  if (tool.name === "previewDataRecipe") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["recipeId"],
      properties: { recipeId: stringEnum(recipeIds), stepCount: { type: "integer", minimum: 1, maximum: 50 } },
    };
  }
  if (tool.name === "validateDataRecipe") {
    return { type: "object", additionalProperties: false, required: ["recipeId"], properties: { recipeId: stringEnum(recipeIds) } };
  }
  if (tool.name === "exportDataRecipeToExcel") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["recipeId"],
      properties: {
        recipeId: stringEnum(recipeIds),
        fileName: { type: "string", minLength: 1, maxLength: 100, description: "仅文件名，不得包含路径；可省略" },
      },
    };
  }
  if (tool.name === "readEdsRawRows") {
    const sheets = options.request.rawWorkbookManifest?.sheets ?? [];
    return {
      type: "object",
      additionalProperties: false,
      required: ["sheetName", "startRow", "rowCount", "startColumn", "columnCount"],
      properties: {
        sheetName: stringEnum(sheets.map((sheet) => sheet.name)),
        startRow: { type: "integer", minimum: 1, maximum: Math.max(1, ...sheets.map((sheet) => sheet.rowCount)) },
        rowCount: { type: "integer", minimum: 1, maximum: 20 },
        startColumn: { type: "integer", minimum: 1, maximum: Math.max(1, ...sheets.map((sheet) => sheet.columnCount)) },
        columnCount: { type: "integer", minimum: 1, maximum: 20 },
      },
    };
  }
  if (tool.name === "queryEdsRawWorkbook") {
    const sheets = options.request.rawWorkbookManifest?.sheets ?? [];
    return {
      type: "object",
      additionalProperties: false,
      required: ["mode", "sheetName"],
      properties: {
        mode: stringEnum(["rows", "aggregate"]),
        sheetName: stringEnum(["*", ...sheets.map((sheet) => sheet.name)]),
        select: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", minLength: 1, maxLength: 100 } },
        filters: {
          type: "array",
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["column", "operator"],
            properties: {
              column: { type: "string", minLength: 1, maxLength: 100 },
              operator: stringEnum(["equals", "notEquals", "contains", "startsWith", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual", "between", "in", "isEmpty", "isNotEmpty"]),
              value: { anyOf: [{ type: "string", maxLength: 300 }, { type: "number" }, { type: "boolean" }] },
              values: { type: "array", minItems: 1, maxItems: 50, items: { anyOf: [{ type: "string", maxLength: 300 }, { type: "number" }, { type: "boolean" }] } },
            },
          },
        },
        groupBy: { type: "array", maxItems: 3, items: { type: "string", minLength: 1, maxLength: 100 } },
        aggregations: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["operation", "alias"],
            properties: {
              operation: stringEnum(["count", "sum", "average", "minimum", "maximum", "distinctCount"]),
              column: { type: "string", minLength: 1, maxLength: 100 },
              alias: { type: "string", minLength: 1, maxLength: 80 },
            },
          },
        },
        orderBy: {
          type: "array",
          maxItems: 3,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["field", "direction"],
            properties: {
              field: { type: "string", minLength: 1, maxLength: 100 },
              direction: stringEnum(["ascending", "descending"]),
            },
          },
        },
        offset: { type: "integer", minimum: 0, maximum: 50_000 },
        limit: { type: "integer", minimum: 1, maximum: 30 },
      },
    };
  }
  if (tool.name === "createEdsLineIssueChartPreview") {
    const allLines = options.request.edsWorkspace?.lineSummary.map((item) => item.label) ?? [];
    const currentInstruction = options.request.instruction.toLocaleLowerCase("zh-CN");
    const previousInstruction = options.request.conversationContext?.previousInstruction?.toLocaleLowerCase("zh-CN") ?? "";
    const currentLines = allLines.filter((line) => currentInstruction.includes(line.toLocaleLowerCase("zh-CN")));
    const previousLines = allLines.filter((line) => previousInstruction.includes(line.toLocaleLowerCase("zh-CN")));
    const lines = currentLines.length > 0 ? currentLines : previousLines.length > 0 ? previousLines : allLines;
    return {
      type: "object",
      additionalProperties: false,
      required: ["line", "metric", "chartType"],
      properties: {
        line: stringEnum(lines),
        metric: stringEnum(["occurrences", "minutes"]),
        chartType: stringEnum(requestedChartTypes(options.request.instruction)),
      },
    };
  }
  if (tool.name === "createEdsBreakdownChartPreview") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["dimension", "metric", "chartType"],
      properties: {
        dimension: stringEnum(["issue", "line"]),
        metric: stringEnum(["occurrences", "minutes"]),
        chartType: stringEnum(requestedChartTypes(options.request.instruction)),
        limit: { type: "integer", minimum: 3, maximum: 14 },
      },
    };
  }
  if (tool.name === "updateEdsTablePreview") {
    const page = options.request.appSpec.pages.find((candidate) => candidate.id === options.request?.pageId);
    const tableIds = page
      ? compactNodes(page.root)
        .filter((candidate) => candidate.type === "DataTable")
        .map((candidate) => candidate.id)
        .filter((nodeId) => {
          const node = findAppNode(page.root, nodeId);
          return node?.type === "DataTable" && node.props.binding.dataSourceId === EDS_BREAKDOWN_DATA_SOURCE_ID;
        })
      : [];
    return {
      type: "object",
      minProperties: 2,
      additionalProperties: false,
      required: ["nodeId"],
      properties: {
        nodeId: stringEnum(tableIds),
        title: { type: "string", minLength: 1, maxLength: 100 },
        subtitle: { type: "string", maxLength: 240 },
        actionLabel: { type: "string", minLength: 1, maxLength: 40 },
        visibleColumns: {
          type: "array",
          minItems: 1,
          maxItems: EDS_TABLE_FIELDS.length,
          uniqueItems: true,
          description: "按此顺序显示表格字段。view=视图、line=线体、category=异常分类、occurrences=次数、minutes=分钟。",
          items: stringEnum([...EDS_TABLE_FIELDS]),
        },
        sort: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description: "多级排序；数组第一项优先级最高。",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["field", "direction"],
            properties: {
              field: stringEnum([...EDS_TABLE_FIELDS]),
              direction: stringEnum(["asc", "desc"]),
            },
          },
        },
        density: { ...stringEnum(["comfortable", "compact"]), description: "表格行距。" },
        stripedRows: { type: "boolean", description: "是否显示斑马纹行背景。" },
        accentColor: { ...stringEnum([...BAR_CHART_COLORS]), description: "表格按钮和斑马纹的强调色。" },
      },
    };
  }
  return z.toJSONSchema(tool.schema) as Record<string, unknown>;
}

export function harnessToolCatalog(options: HarnessToolCatalogOptions = {}) {
  const names = options.names ? new Set(options.names) : null;
  return Object.values(harnessToolRegistry).filter((tool) => !names || names.has(tool.name)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    mode: tool.mode,
    parameters: tool.name === "createChangeSetPreview" && options.editableNodes
      ? compactChangePreviewSchema(options)
      : scopedToolParameters(tool, options),
  }));
}

function truncateString(value: string, limit = 300) {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function compactValue(value: unknown, maxEntries: number, depth = 0): unknown {
  if (typeof value === "string") return truncateString(value, depth === 0 ? 500 : 220);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 5) return "[已省略深层结果]";
  if (Array.isArray(value)) {
    const items = value.slice(0, maxEntries).map((item) => compactValue(item, Math.max(3, Math.floor(maxEntries / 2)), depth + 1));
    return value.length > maxEntries ? [...items, { truncated: true, omittedCount: value.length - maxEntries }] : items;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  const selected = entries.slice(0, maxEntries).map(([key, child]) => [key, compactValue(child, Math.max(3, Math.floor(maxEntries / 2)), depth + 1)]);
  if (entries.length > maxEntries) selected.push(["truncated", true], ["omittedPropertyCount", entries.length - maxEntries]);
  return Object.fromEntries(selected);
}

export function compactHarnessToolResult(
  result: HarnessToolExecutionResult,
  maxChars = MAX_HARNESS_TOOL_RESULT_BYTES,
  maxEntries = DEFAULT_HARNESS_TOOL_RESULT_ENTRIES,
): HarnessToolExecutionResult {
  if (JSON.stringify(result.data).length <= maxChars) return result;
  let data = compactValue(result.data, maxEntries);
  let pass = 0;
  while (JSON.stringify(data).length > maxChars && pass < 3) {
    data = compactValue(data, Math.max(2, Math.floor(maxEntries / (2 ** (pass + 1)))));
    pass += 1;
  }
  if (JSON.stringify(data).length > maxChars) {
    data = { truncated: true, summaryOnly: truncateString(result.summary, Math.max(80, maxChars - 80)) };
  }
  if (JSON.stringify(data).length > maxChars) {
    throw new StudioValidationError("Harness 工具结果过大", ["工具结果压缩后仍超过上下文预算"]);
  }
  return {
    ...result,
    summary: `${result.summary}（结果已按上下文预算截断）`,
    data,
  };
}

export async function executeHarnessTool(
  rawName: string,
  rawArguments: unknown,
  context: HarnessToolContext,
): Promise<HarnessToolExecutionResult> {
  if (!(rawName in harnessToolRegistry)) {
    throw new StudioValidationError("Harness 工具校验失败", [`不允许调用工具：${sanitizeHarnessText(rawName, "未知工具")}`]);
  }
  const name = rawName as HarnessToolName;
  const tool = harnessToolRegistry[name];
  if (tool.mode === "changePreview" && !studioCapabilities[context.request.role].updateNodeProps) {
    throw new StudioValidationError("Harness 工具权限校验失败", [`${context.request.role} 无权生成修改型工具预览`]);
  }
  const run = async <Args>(definition: HarnessToolDefinition<HarnessToolName, Args>) => {
    const parsed = definition.schema.safeParse(rawArguments);
    if (!parsed.success) {
      const issueSummary = parsed.error.issues.slice(0, 6).map((issue) => {
        const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "$";
        return `${path}:${issue.code}`;
      });
      throw new HarnessToolArgumentsError(name, issueSummary);
    }
    return definition.execute(parsed.data, context);
  };
  const result = await (() => {
    switch (name) {
      case "analyzeEdsReports": return run(analyzeEdsReports);
      case "scanEdsRawWorkbook": return run(scanEdsRawWorkbook);
      case "queryEdsRawWorkbook": return run(queryEdsRawWorkbook);
      case "inspectEdsRawWorkbook": return run(inspectEdsRawWorkbook);
      case "readEdsRawRows": return run(readEdsRawRows);
      case "inspectDataset": return run(inspectDataset);
      case "inspectFields": return run(inspectFields);
      case "previewDataRecipe": return run(previewDataRecipe);
      case "validateDataRecipe": return run(validateDataRecipe);
      case "exportDataRecipeToExcel": return run(exportDataRecipeToExcel);
      case "inspectAppSpec": return run(inspectAppSpec);
      case "createEdsBreakdownChartPreview": return run(createEdsBreakdownChartPreview);
      case "createEdsLineIssueChartPreview": return run(createEdsLineIssueChartPreview);
      case "updateEdsTablePreview": return run(updateEdsTablePreview);
      case "createChangeSetPreview": return run(createChangeSetPreview);
    }
  })();
  const compacted = compactHarnessToolResult(
    result,
    context.resultBudgetChars ?? MAX_HARNESS_TOOL_RESULT_BYTES,
    context.resultBudgetEntries ?? DEFAULT_HARNESS_TOOL_RESULT_ENTRIES,
  );
  if (jsonByteLength(compacted.data) > (context.resultBudgetChars ?? MAX_HARNESS_TOOL_RESULT_BYTES) * 4) {
    throw new StudioValidationError("Harness 工具结果过大", [`工具 ${name} 的结果压缩后仍超过安全字节限制`]);
  }
  return { ...compacted, summary: sanitizeHarnessText(compacted.summary).slice(0, 500) };
}
