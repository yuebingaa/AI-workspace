import { defineTool } from "./contracts";
import { z } from "zod";
import { StudioValidationError } from "@/core/schemas/errors";
import { getEdsWorkspaceReports } from "@/core/eds";
import type { EdsCellValue } from "@/core/eds";
import type { HarnessToolContext, HarnessRawWorkbook } from "./contracts";
import type { RawWorkbookIndex } from "../raw-workbook-engine";
import { indexRawWorkbook, publicRawWorkbookProfile, queryRawWorkbook } from "../raw-workbook-engine";

export const analyzeEdsReports = defineTool({
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
    throw new StudioValidationError("原始工作簿不可用", ["请重新导入 XLSX 文件后继续分析"]);
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

export const scanEdsRawWorkbook = defineTool({
  name: "scanEdsRawWorkbook",
  description: "完整扫描本次授权的 EDS 原始工作簿全部工作表与全部数据行，建立字段、类型、缺失值、数值范围和高频值概况。计算在服务端完成，不把整份文件塞进模型上下文。只读。",
  mode: "readOnly",
  schema: z.object({}).strict(),
  execute: (_args, context) => {
    const index = indexedRawWorkbook(context);
    return {
      summary: `已扫描 ${index.sheets.length} 张工作表，自动表头后排除全空白行的 ${index.scannedDataRowCount} 条记录、${index.scannedCellCount} 个单元格；不据此推断原文件空行数。数据版本 ${index.datasetVersion.slice(0, 16)}。`,
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

export const queryEdsRawWorkbook = defineTool({
  name: "queryEdsRawWorkbook",
  description: "对已完整扫描的原始工作簿执行确定性结构化查询。支持跨表(*)或单表筛选、返回带工作表/行号的原始记录，以及分组后的 count/sum/average/minimum/maximum/distinctCount；所有匹配和计算覆盖完整数据行，最多只向模型返回 30 条结果。列可用表头名、A/B 等列号，特殊字段 $sheet 和 $row 表示来源表与原始行号。只读。",
  mode: "readOnly",
  schema: rawWorkbookQuerySchema,
  execute: (args, context) => {
    const index = indexedRawWorkbook(context);
    try {
      const result = queryRawWorkbook(index, args);
      return {
        summary: `已检查 ${result.sheets.length} 张表自动表头后排除全空白行的 ${result.scannedDataRowCount} 条记录，命中 ${result.matchedRowCount} 条，返回 ${result.returnedCount} 条${result.mode === "aggregate" ? "聚合结果" : "可溯源原始记录"}；不代表原文件空行统计。`,
        data: result,
      };
    } catch (error) {
      throw new StudioValidationError("EDS 原始数据查询失败", [error instanceof Error ? error.message : "查询条件无效"]);
    }
  },
});

export const inspectEdsRawWorkbook = defineTool({
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

export const readEdsRawRows = defineTool({
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
