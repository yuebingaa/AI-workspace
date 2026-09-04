import readExcelFile from "read-excel-file/node";
import writeXlsxFile, { type Cell, type CellObject, type SheetData } from "write-excel-file/node";
import { sanitizeExcelFileName, type GeneratedRecipeExcel } from "@/core/exports/server/recipe-excel-export";
import {
  EDS_DETAIL_COLUMN_INDEXES,
  EdsAnalysisError,
  type EdsAnalysisResult,
  type EdsCellValue,
  type EdsSheetData,
  type EdsWorkbookSheet,
} from "../analysis";
import { EDS_UPLOAD_LIMITS } from "../contracts";
import { validateXlsxArchive } from "./xlsx-archive";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const ALLOWED_XLSX_MIME_TYPES = new Set(["", XLSX_MIME, "application/octet-stream"]);

function edsReportRowHeight(index: number): number {
  if (index === 0) return 20.4;
  if (index === 2) return 52.2;
  if (index === 3) return 34.8;
  if (index === 5) return 18.15;
  return 17.4;
}

const EDS_WORKBOOK_LAYOUT_FEATURE = {
  files: {
    transform: {
      "xl/worksheets/sheet{id}.xml": {
        transformElementAttributes(
          tagName: string,
          attributes: Record<string, string | number>,
          index: number | undefined,
        ): Record<string, string | number> {
          if (tagName === "col" && (index === 0 || index === 1)) return { ...attributes, hidden: 1 };
          if (tagName === "row" && index !== undefined) {
            return {
              ...attributes,
              ht: edsReportRowHeight(index),
              customHeight: 1,
              ...(index >= 1 && index <= 3 ? { hidden: 1 } : {}),
            };
          }
          return attributes;
        },
      },
    },
  },
};

function safeWorkbookName(value: string): string {
  const decoded = (() => {
    try { return decodeURIComponent(value); } catch { return value; }
  })().normalize("NFKC").trim();
  if (!decoded || decoded.length > 255 || decoded.includes("..") || /[/\\\u0000-\u001f]/u.test(decoded)) {
    throw new EdsAnalysisError("XLSX 文件名不合法");
  }
  if (!decoded.toLocaleLowerCase("en-US").endsWith(".xlsx")) throw new EdsAnalysisError("当前仅支持 .xlsx 工作簿", 415);
  return decoded;
}

function validateMimeType(value: string): void {
  const mime = value.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
  if (!ALLOWED_XLSX_MIME_TYPES.has(mime)) throw new EdsAnalysisError("XLSX MIME 类型不支持", 415);
}

function validateWorkbookData(sheets: EdsWorkbookSheet[]): void {
  if (sheets.length === 0 || sheets.length > EDS_UPLOAD_LIMITS.maxSheets) {
    throw new EdsAnalysisError(`工作簿工作表数量必须为 1–${EDS_UPLOAD_LIMITS.maxSheets}`, 413);
  }
  for (const sheet of sheets) {
    if (!sheet.sheet.trim() || sheet.sheet.length > 100) throw new EdsAnalysisError("工作表名称无效");
    if (sheet.data.length > EDS_UPLOAD_LIMITS.maxRowsPerSheet) throw new EdsAnalysisError(`工作表“${sheet.sheet}”超过行数限制`, 413);
    for (const row of sheet.data) {
      if (row.length > EDS_UPLOAD_LIMITS.maxColumns) throw new EdsAnalysisError(`工作表“${sheet.sheet}”超过列数限制`, 413);
      if (row.some((value) => typeof value === "number" && !Number.isFinite(value))) {
        throw new EdsAnalysisError(`工作表“${sheet.sheet}”包含非有限数值`);
      }
      const oversized = row.find((value) => typeof value === "string" && value.length > EDS_UPLOAD_LIMITS.maxCellChars);
      if (oversized !== undefined) throw new EdsAnalysisError(`工作表“${sheet.sheet}”包含超长文本单元格`, 413);
    }
  }
}

export async function readEdsXlsx(input: {
  buffer: Buffer;
  originalFileName: string;
  mimeType?: string;
}): Promise<EdsWorkbookSheet[]> {
  safeWorkbookName(input.originalFileName);
  validateMimeType(input.mimeType ?? "");
  if (input.buffer.length === 0 || input.buffer.length > EDS_UPLOAD_LIMITS.maxFileBytes) {
    throw new EdsAnalysisError(`XLSX 文件大小必须在 1–${EDS_UPLOAD_LIMITS.maxFileBytes} 字节之间`, 413);
  }
  if (input.buffer[0] !== 0x50 || input.buffer[1] !== 0x4b) throw new EdsAnalysisError("文件头不是有效的 XLSX/ZIP", 415);
  validateXlsxArchive(input.buffer);
  try {
    const parsed = await readExcelFile(input.buffer, { trim: false });
    const sheets = parsed.map(({ sheet, data }) => ({ sheet, data: data as EdsSheetData }));
    validateWorkbookData(sheets);
    return sheets;
  } catch (error) {
    if (error instanceof EdsAnalysisError) throw error;
    throw new EdsAnalysisError("XLSX 工作簿无法解析或内容已损坏", 400);
  }
}

const COLORS = {
  green: "#147F61",
  greenLight: "#E4F5EE",
  blueLight: "#DDEBF7",
  yellow: "#FFF2CC",
  redLight: "#F4CCCC",
  red: "#9C0006",
  border: "#7F8C87",
  text: "#24312D",
} as const;

function reportCell(value: EdsCellValue, options: Partial<CellObject> = {}): Cell {
  const base: CellObject = {
    value: value === undefined || value === null ? "" : value,
    type: value instanceof Date ? Date : typeof value === "number" ? Number : typeof value === "boolean" ? Boolean : String,
    fontFamily: "Microsoft YaHei",
    fontSize: 12,
    textColor: COLORS.text,
    align: "center",
    alignVertical: "center",
    wrap: true,
    borderColor: COLORS.border,
    borderStyle: "thin",
    ...options,
  };
  if (value instanceof Date) base.format = "yyyy-mm-dd";
  return base;
}

function spanRow(width: number): Array<null> {
  return Array.from({ length: width }, () => null);
}

function buildReportSheet(result: EdsAnalysisResult): SheetData {
  const rows: SheetData = Array.from({ length: 36 }, () => spanRow(26));
  rows[0][2] = reportCell(new Date(`${result.template.date}T00:00:00.000Z`), { fontWeight: "bold" });
  rows[0][3] = reportCell(result.template.shift, { fontWeight: "bold" });
  rows[0][4] = reportCell("35/36 EDS贴膜报警统计", { columnSpan: 13, fontWeight: "bold", fontSize: 14, backgroundColor: COLORS.greenLight });
  rows[0][17] = reportCell("32/33 EDS贴膜报警统计", { columnSpan: 9, fontWeight: "bold", fontSize: 14, backgroundColor: COLORS.blueLight });
  result.template.channels.forEach((channel) => {
    rows[2][channel.columnIndex] = reportCell(channel.line, { fontSize: 8 });
    rows[3][channel.columnIndex] = reportCell(channel.instance, { fontSize: 8 });
  });
  rows[4][2] = reportCell("异常", { rowSpan: 2, fontWeight: "bold", backgroundColor: COLORS.greenLight });
  rows[4][3] = reportCell("统计项", { rowSpan: 2, fontWeight: "bold", backgroundColor: COLORS.greenLight });
  for (let channelIndex = 0; channelIndex < result.template.channels.length; channelIndex += 2) {
    const channel = result.template.channels[channelIndex];
    rows[4][channel.columnIndex] = reportCell(channel.displayLine, {
      columnSpan: 2,
      fontWeight: "bold",
      backgroundColor: channelIndex % 4 === 0 ? "#FFFFFF" : COLORS.blueLight,
    });
    rows[5][channel.columnIndex] = reportCell(channel.displayChannel, { fontWeight: "bold" });
    rows[5][result.template.channels[channelIndex + 1].columnIndex] = reportCell(result.template.channels[channelIndex + 1].displayChannel, { fontWeight: "bold" });
  }
  rows[4][16] = reportCell("SUM", { rowSpan: 2, fontWeight: "bold", backgroundColor: COLORS.greenLight });
  rows[4][25] = reportCell("SUM", { rowSpan: 2, fontWeight: "bold", backgroundColor: COLORS.blueLight });
  result.template.issues.forEach((issue, issueIndex) => {
    const countRow = 6 + issueIndex * 2;
    const minuteRow = countRow + 1;
    rows[countRow][0] = reportCell(issue.raw, { fontSize: 8 });
    rows[countRow][2] = reportCell(issue.display, { rowSpan: 2, fontWeight: "bold", topBorderStyle: "medium", bottomBorderStyle: "medium" });
    rows[countRow][3] = reportCell("次数", { fontWeight: "bold", topBorderStyle: "medium" });
    rows[minuteRow][3] = reportCell("时间(min)", { backgroundColor: COLORS.yellow, bottomBorderStyle: "medium" });
    for (const columnIndex of [...EDS_DETAIL_COLUMN_INDEXES, 16, 25]) {
      rows[countRow][columnIndex] = reportCell(result.reportRows[issueIndex * 2][columnIndex], {
        fontWeight: columnIndex === 16 || columnIndex === 25 ? "bold" : undefined,
        topBorderStyle: "medium",
      });
      rows[minuteRow][columnIndex] = reportCell(result.reportRows[issueIndex * 2 + 1][columnIndex], {
        format: "0.00",
        fontWeight: columnIndex === 16 || columnIndex === 25 ? "bold" : undefined,
        backgroundColor: columnIndex === 16 || columnIndex === 25 ? "#FFFFFF" : COLORS.yellow,
        bottomBorderStyle: "medium",
      });
    }
  });
  rows[34][2] = reportCell("TTL", { rowSpan: 2, fontWeight: "bold", backgroundColor: COLORS.greenLight });
  rows[34][3] = reportCell("次数", { fontWeight: "bold", backgroundColor: COLORS.greenLight });
  rows[35][3] = reportCell("时间(min)", { fontWeight: "bold", backgroundColor: COLORS.yellow });
  for (const columnIndex of [...EDS_DETAIL_COLUMN_INDEXES, 16, 25]) {
    rows[34][columnIndex] = reportCell(result.reportRows[28][columnIndex], { fontWeight: "bold", backgroundColor: COLORS.greenLight });
    rows[35][columnIndex] = reportCell(result.reportRows[29][columnIndex], { fontWeight: "bold", backgroundColor: COLORS.yellow, format: "0.00" });
  }
  return rows;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new EdsAnalysisError("EDS Excel 导出超时", 504)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function generateEdsReportExcel(
  result: EdsAnalysisResult,
  now = new Date(),
  observeOperation?: (operation: Promise<unknown>) => void,
): Promise<GeneratedRecipeExcel> {
  const fileName = sanitizeExcelFileName(undefined, `EDS飞达异常统计_${result.template.date}_${result.template.shift}`);
  const data = buildReportSheet(result);
  const columns = [
    { width: 2 }, { width: 2 }, { width: 29 }, { width: 14.24 },
    ...Array.from({ length: 21 }, () => ({ width: 9.05 })),
    { width: 10.16 },
  ];
  const writeOperation = writeXlsxFile(
    data,
    {
      sheet: "EDS飞达异常统计",
      columns,
      showGridLines: false,
      stickyRowsCount: 6,
      stickyColumnsCount: 4,
      conditionalFormatting: [
        {
          cellRange: { from: { row: 7, column: 5 }, to: { row: 34, column: 16 } },
          condition: { operator: ">=", value: 5 },
          style: { backgroundColor: COLORS.redLight, textColor: COLORS.red },
        },
        {
          cellRange: { from: { row: 7, column: 18 }, to: { row: 34, column: 25 } },
          condition: { operator: ">=", value: 5 },
          style: { backgroundColor: COLORS.redLight, textColor: COLORS.red },
        },
      ],
    },
    { features: [EDS_WORKBOOK_LAYOUT_FEATURE] },
  ).toBuffer();
  observeOperation?.(writeOperation);
  const buffer = await withTimeout(writeOperation, 8_000);
  if (!Buffer.isBuffer(buffer) || buffer.length === 0 || buffer.length > EDS_UPLOAD_LIMITS.maxFileBytes) {
    throw new EdsAnalysisError("EDS Excel 导出未生成有效文件", 500);
  }
  return {
    buffer,
    fileName,
    rowCount: 30,
    fieldCount: 20,
    sizeBytes: buffer.length,
    generatedAt: now.toISOString(),
  };
}

export const EDS_XLSX_MIME_TYPE = XLSX_MIME;
