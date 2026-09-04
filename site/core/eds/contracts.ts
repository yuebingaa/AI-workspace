import { z } from "zod";
import { excelExportArtifactSchema } from "@/core/exports/contracts";
import { EDS_RULE_VERSION, EDS_TEMPLATE_VERSION } from "./built-in";

export const EDS_UPLOAD_LIMITS = {
  maxFileBytes: 10 * 1024 * 1024,
  maxCombinedBytes: 20 * 1024 * 1024,
  maxArchiveEntries: 1_000,
  maxArchiveUncompressedBytes: 64 * 1024 * 1024,
  maxArchiveEntryBytes: 32 * 1024 * 1024,
  maxSheets: 10,
  maxRowsPerSheet: 50_000,
  maxColumns: 100,
  maxCellsPerSheet: 500_000,
  maxSharedStrings: 500_000,
  maxStyles: 100_000,
  maxCellChars: 20_000,
  maxSelections: 20,
} as const;

export const EDS_MAX_RESPONSE_BYTES = 512 * 1024;

export const edsWorkbookSelectionSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  shift: z.string().min(1).max(50),
}).strict();

export const edsSelectionRequiredResponseSchema = z.object({
  error: z.object({
    code: z.literal("EDS_SELECTION_REQUIRED"),
    message: z.string().min(1).max(200),
    selections: z.array(edsWorkbookSelectionSchema).min(2).max(EDS_UPLOAD_LIMITS.maxSelections),
  }).strict(),
}).strict().superRefine((response, context) => {
  const keys = response.error.selections.map((selection) => `${selection.date}\u0000${selection.shift}`);
  if (new Set(keys).size !== keys.length) {
    context.addIssue({ code: "custom", path: ["error", "selections"], message: "可选日期与班次不能重复" });
  }
});

export const edsChartItemSchema = z.object({
  label: z.string().min(1).max(200),
  count: z.number().int().nonnegative(),
  minutes: z.number().finite().nonnegative(),
}).strict();

export const edsComparisonSchema = z.object({
  coreMatched: z.number().int().nonnegative(),
  coreTotal: z.number().int().positive(),
  reportMatched: z.number().int().nonnegative(),
  reportTotal: z.number().int().positive(),
  mismatchCount: z.number().int().nonnegative(),
  mismatches: z.array(z.object({
    cell: z.string().regex(/^[A-Z]+\d+$/u),
    expected: z.number().finite().nullable(),
    actual: z.number().finite(),
  }).strict()).max(20),
}).strict().superRefine((comparison, context) => {
  const addIssue = (path: Array<string | number>, message: string) => context.addIssue({ code: "custom", path, message });
  if (comparison.coreMatched > comparison.coreTotal) addIssue(["coreMatched"], "核心匹配数不能超过核心总数");
  if (comparison.reportMatched > comparison.reportTotal) addIssue(["reportMatched"], "整表匹配数不能超过整表总数");
  if (comparison.mismatchCount !== comparison.reportTotal - comparison.reportMatched) {
    addIssue(["mismatchCount"], "差异数必须等于整表总数减匹配数");
  }
  if (comparison.coreTotal - comparison.coreMatched > comparison.mismatchCount) {
    addIssue(["coreMatched"], "整表差异数不能少于核心差异数");
  }
  if (comparison.mismatches.length !== Math.min(comparison.mismatchCount, 20)) {
    addIssue(["mismatches"], "差异明细必须完整保留前 20 项");
  }
});

export const edsConfigurationSchema = z.object({
  templateVersion: z.literal(EDS_TEMPLATE_VERSION),
  ruleVersion: z.literal(EDS_RULE_VERSION),
  comparisonMode: z.enum(["not_requested", "custom_template"]),
}).strict();

export const edsAnalysisResponseSchema = z.object({
  summary: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    shift: z.string().min(1).max(50),
    inputRows: z.number().int().nonnegative(),
    matchedRows: z.number().int().nonnegative(),
    issueCount: z.literal(14),
    channelCount: z.literal(20),
    totalOccurrences: z.number().int().nonnegative(),
    totalMinutes: z.number().finite().nonnegative(),
    sourceSheets: z.array(z.string().min(1).max(100)).min(1).max(10),
  }).strict(),
  issueSummary: z.array(edsChartItemSchema).length(14),
  lineSummary: z.array(edsChartItemSchema).min(1).max(20),
  configuration: edsConfigurationSchema,
  comparison: edsComparisonSchema.nullable(),
  exportArtifact: excelExportArtifactSchema,
  warnings: z.array(z.string().min(1).max(500)).max(20),
}).strict().superRefine((response, context) => {
  const addIssue = (path: Array<string | number>, message: string) => context.addIssue({ code: "custom", path, message });
  const countSum = (items: Array<{ count: number }>) => items.reduce((total, item) => total + item.count, 0);
  const minuteSum = (items: Array<{ minutes: number }>) => items.reduce((total, item) => total + item.minutes, 0);
  const closeEnough = (left: number, right: number) => (
    Number.isFinite(left) && Math.abs(left - right) <= Math.max(1e-8, Math.abs(right) * 1e-10)
  );
  if (response.configuration.comparisonMode === "custom_template" && !response.comparison) {
    addIssue(["comparison"], "高级验收模式必须包含目标表比对结果");
  }
  if (response.configuration.comparisonMode === "not_requested" && response.comparison) {
    addIssue(["comparison"], "普通分析模式不得返回目标表比对结果");
  }
  if (response.comparison?.coreTotal !== undefined && response.comparison.coreTotal !== 560) {
    addIssue(["comparison", "coreTotal"], "EDS 核心比对总数必须为 560");
  }
  if (response.comparison?.reportTotal !== undefined && response.comparison.reportTotal !== 660) {
    addIssue(["comparison", "reportTotal"], "EDS 整表比对总数必须为 660");
  }
  if (response.summary.matchedRows !== response.summary.totalOccurrences) {
    addIssue(["summary", "totalOccurrences"], "异常次数必须等于命中记录数");
  }
  if (countSum(response.issueSummary) !== response.summary.totalOccurrences) {
    addIssue(["issueSummary"], "异常分类次数合计必须等于总异常次数");
  }
  if (countSum(response.lineSummary) !== response.summary.totalOccurrences) {
    addIssue(["lineSummary"], "线体次数合计必须等于总异常次数");
  }
  if (!closeEnough(minuteSum(response.issueSummary), response.summary.totalMinutes)) {
    addIssue(["issueSummary"], "异常分类时长合计必须等于总异常时长");
  }
  if (!closeEnough(minuteSum(response.lineSummary), response.summary.totalMinutes)) {
    addIssue(["lineSummary"], "线体时长合计必须等于总异常时长");
  }
  if (new Set(response.issueSummary.map((item) => item.label)).size !== response.issueSummary.length) {
    addIssue(["issueSummary"], "异常分类标签不能重复");
  }
  if (new Set(response.lineSummary.map((item) => item.label)).size !== response.lineSummary.length) {
    addIssue(["lineSummary"], "线体标签不能重复");
  }
  if (new Set(response.summary.sourceSheets).size !== response.summary.sourceSheets.length) {
    addIssue(["summary", "sourceSheets"], "来源工作表不能重复");
  }
  if (response.exportArtifact.rowCount !== 30 || response.exportArtifact.fieldCount !== 20) {
    addIssue(["exportArtifact"], "EDS 导出工件必须声明 30 行、20 个统计字段");
  }
});

export type EdsAnalysisResponse = z.infer<typeof edsAnalysisResponseSchema>;
export type EdsWorkbookSelection = z.infer<typeof edsWorkbookSelectionSchema>;
export type EdsSelectionRequiredResponse = z.infer<typeof edsSelectionRequiredResponseSchema>;
export type EdsChartItem = z.infer<typeof edsChartItemSchema>;
export type EdsComparison = z.infer<typeof edsComparisonSchema>;
export type EdsConfiguration = z.infer<typeof edsConfigurationSchema>;
