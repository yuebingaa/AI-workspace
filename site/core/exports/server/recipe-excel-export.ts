import writeXlsxFile, { type SheetData } from "write-excel-file/node";
import { executeDataRecipe } from "@/core/data";
import type {
  DataRecipe,
  DataRow,
  DataSourceDefinition,
  DataValue,
  RecipeFieldSchema,
} from "@/core/models";
import { StudioValidationError } from "@/core/schemas";

export interface ExcelExportLimits {
  maxRows: number;
  maxColumns: number;
  maxFileBytes: number;
  maxCellTextLength: number;
  timeoutMs: number;
}

export const EXCEL_EXPORT_LIMITS: ExcelExportLimits = {
  maxRows: 10_000,
  maxColumns: 100,
  maxFileBytes: 10 * 1024 * 1024,
  maxCellTextLength: 32_000,
  timeoutMs: 8_000,
} as const;

export interface ExcelSheetDefinition {
  sheet: string;
  data: SheetData;
  columns: Array<{ width: number }>;
}

export interface GeneratedRecipeExcel {
  buffer: Buffer;
  fileName: string;
  rowCount: number;
  fieldCount: number;
  sizeBytes: number;
  generatedAt: string;
}

export interface GenerateRecipeExcelInput {
  recipe: DataRecipe;
  source: DataSourceDefinition;
  rows: DataRow[];
  requestedFileName?: string;
  now?: () => Date;
  limits?: Partial<ExcelExportLimits>;
  writer?: (sheets: ExcelSheetDefinition[]) => Promise<Buffer>;
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

export function sanitizeExcelFileName(requested: string | undefined, fallback: string): string {
  const raw = (requested?.trim() || fallback.trim()).normalize("NFKC");
  if (!raw || raw.includes("..") || /[/\\]/u.test(raw) || /^[A-Za-z]:/u.test(raw)) {
    throw new StudioValidationError("Excel 文件名不合法", ["文件名不得包含路径、盘符或路径穿越字符"]);
  }
  const withoutExtension = raw.replace(/\.xlsx$/iu, "");
  const cleaned = withoutExtension
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, "_")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 80);
  if (!cleaned || WINDOWS_RESERVED_NAME.test(cleaned)) {
    throw new StudioValidationError("Excel 文件名不合法", ["文件名为空或使用了系统保留名称"]);
  }
  return `${cleaned}.xlsx`;
}

export function escapeExcelFormulaText(value: string): string {
  const safe = value.slice(0, EXCEL_EXPORT_LIMITS.maxCellTextLength);
  return /^\s*[=+\-@]/u.test(safe) ? `'${safe}` : safe;
}

function parseDate(value: DataValue, field: string): Date {
  const text = String(value);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(text);
  const parsed = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    throw new StudioValidationError("Excel 日期字段无效", [`字段“${field}”包含无法导出的日期值`]);
  }
  return parsed;
}

function dataCell(value: DataValue | undefined, field: RecipeFieldSchema) {
  if (value === null || value === undefined) return null;
  if (field.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new StudioValidationError("Excel 数值字段无效", [`字段“${field.name}”包含非有限数值`]);
    }
    return { value, type: Number };
  }
  if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new StudioValidationError("Excel 布尔字段无效", [`字段“${field.name}”包含非布尔值`]);
    return { value, type: Boolean };
  }
  if (field.type === "date") return { value: parseDate(value, field.name), type: Date, format: "yyyy-mm-dd" };
  return { value: escapeExcelFormulaText(String(value)), type: String };
}

function filterSummary(recipe: DataRecipe): string {
  const filters = recipe.steps.filter((step) => step.type === "filter");
  return filters.length
    ? filters.map((step) => `${step.field} ${step.operator} ${String(step.value)}`).join("；")
    : "无筛选条件";
}

function buildSheets(
  recipe: DataRecipe,
  source: DataSourceDefinition,
  rows: DataRow[],
  fields: RecipeFieldSchema[],
  generatedAt: string,
): ExcelSheetDefinition[] {
  const header = fields.map((field) => ({
    value: escapeExcelFormulaText(field.label || field.name),
    type: String,
    fontWeight: "bold" as const,
    backgroundColor: "#E8F3EF",
  }));
  const analysisData: SheetData = [
    header,
    ...rows.map((row) => fields.map((field) => dataCell(row[field.name], field))),
  ];
  const explanationRows: Array<[string, string | number]> = [
    ["项目", "内容"],
    ["数据源", `${source.name}（${source.id}）`],
    ["数据配方", `${recipe.name}（${recipe.id}）`],
    ["筛选条件", filterSummary(recipe)],
    ["生成时间", generatedAt],
    ["导出行数", rows.length],
    ["字段数量", fields.length],
    ["字段", fields.map((field) => `${field.label}(${field.name}:${field.type})`).join("、")],
  ];
  const explanationData: SheetData = explanationRows.map(([label, value], index) => [
    { value: escapeExcelFormulaText(label), type: String, ...(index === 0 ? { fontWeight: "bold" as const, backgroundColor: "#E8F3EF" } : {}) },
    typeof value === "number"
      ? { value, type: Number }
      : { value: escapeExcelFormulaText(value), type: String, wrap: true, ...(index === 0 ? { fontWeight: "bold" as const, backgroundColor: "#E8F3EF" } : {}) },
  ]);
  return [
    { sheet: "分析结果", data: analysisData, columns: fields.map(() => ({ width: 20 })) },
    { sheet: "导出说明", data: explanationData, columns: [{ width: 18 }, { width: 72 }] },
  ];
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new StudioValidationError("Excel 导出超时", [`生成时间超过 ${timeoutMs} ms`])), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function generateDataRecipeExcel(input: GenerateRecipeExcelInput): Promise<GeneratedRecipeExcel> {
  const limits = { ...EXCEL_EXPORT_LIMITS, ...input.limits };
  const execution = executeDataRecipe(input.recipe, input.source, input.rows);
  if (!execution.success) throw new StudioValidationError("Excel 配方执行失败", [execution.error]);
  if (execution.rows.length > limits.maxRows) {
    throw new StudioValidationError("Excel 导出行数超限", [`配方结果 ${execution.rows.length} 行，最多允许 ${limits.maxRows} 行`]);
  }
  if (execution.fields.length === 0 || execution.fields.length > limits.maxColumns) {
    throw new StudioValidationError("Excel 导出列数超限", [`配方结果 ${execution.fields.length} 列，最多允许 ${limits.maxColumns} 列`]);
  }
  const now = input.now?.() ?? new Date();
  const generatedAt = now.toISOString();
  const dateSuffix = generatedAt.slice(0, 10).replaceAll("-", "");
  const fileName = sanitizeExcelFileName(input.requestedFileName, `${input.recipe.name}_${dateSuffix}`);
  const sheets = buildSheets(input.recipe, input.source, execution.rows, execution.fields, generatedAt);
  const writer = input.writer ?? (async (definitions) => writeXlsxFile(definitions).toBuffer());
  const buffer = await withTimeout(writer(sheets), limits.timeoutMs);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new StudioValidationError("Excel 导出失败", ["生成器未返回有效文件"]);
  if (buffer.length > limits.maxFileBytes) {
    throw new StudioValidationError("Excel 文件大小超限", [`生成文件 ${buffer.length} 字节，最多允许 ${limits.maxFileBytes} 字节`]);
  }
  return {
    buffer,
    fileName,
    rowCount: execution.rows.length,
    fieldCount: execution.fields.length,
    sizeBytes: buffer.length,
    generatedAt,
  };
}
