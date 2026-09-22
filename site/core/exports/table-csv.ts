import { dataTableSchema, dataValueSchema, type DataTable } from "@/core/datasets/table-contracts";

export const MAX_CSV_EXPORT_BYTES = 4 * 1024 * 1024;

export interface TableCsv {
  content: string;
  rowCount: number;
  columnCount: number;
  protectedCellCount: number;
  byteCount: number;
}

// This changes dangerous text, not the underlying table. It is a conservative
// spreadsheet-viewing precaution, not a promise about every CSV consumer or
// spreadsheet save/reopen cycle. In particular, CSV has no typed-cell contract.
function needsFormulaProtection(text: string): boolean {
  return /^[\t\r\n]/u.test(text) || /^[\s\p{Cc}\p{Cf}]*[=+\-@＝＋－＠]/u.test(text);
}

/** Serialize exactly the supplied materialized rows; never fetch a full result. */
export function createTableCsv(table: DataTable): TableCsv {
  const parsed = dataTableSchema.safeParse(table);
  if (!parsed.success) throw new Error("CSV 数据表结构无效；只支持合法字段和文本、有限数值、布尔值或空值。");
  // Preserve legitimate own keys such as __proto__: record parsers may omit
  // those in their cloned output. Read only explicitly declared own values.
  const { fields, rows } = table;
  if (new Set(fields.map((field) => field.name)).size !== fields.length) throw new Error("CSV 字段名称重复，无法明确导出列。");

  let protectedCellCount = 0;
  const encode = (value: string | number | boolean | null | undefined): string => {
    let text = value == null ? "" : String(value);
    if (typeof value === "string" && needsFormulaProtection(text)) {
      text = `'${text}`;
      protectedCellCount += 1;
    }
    return `"${text.replaceAll('"', '""')}"`;
  };
  const encoder = new TextEncoder();
  const chunks = ["\ufeff"];
  let byteCount = 3;
  const appendRow = (values: (string | number | boolean | null | undefined)[]) => {
    const line = `${values.map(encode).join(",")}\r\n`;
    byteCount += encoder.encode(line).byteLength;
    if (byteCount > MAX_CSV_EXPORT_BYTES) throw new Error("CSV 导出超过 4 MiB 限制，请缩小当前结果后重试。");
    chunks.push(line);
  };
  appendRow(fields.map((field) => field.name));
  for (const row of rows) appendRow(fields.map((field) => {
    if (!Object.hasOwn(row, field.name)) return undefined;
    const value = row[field.name];
    if (!dataValueSchema.safeParse(value).success) throw new Error("CSV 数据表结构无效；只支持合法字段和文本、有限数值、布尔值或空值。");
    return value;
  }));
  return { content: chunks.join(""), rowCount: rows.length, columnCount: fields.length, protectedCellCount, byteCount };
}

/** Fixed prefix/suffix keep arbitrary titles away from paths and device names. */
export function csvPreviewFilename(title: string): string {
  const cleaned = title.normalize("NFKC")
    .replace(/[\p{Cc}\p{Cf}]/gu, "")
    .replace(/[<>:"/\\|?*.]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim();
  let short = "";
  for (const character of cleaned) {
    if (short.length + character.length > 80) break;
    short += character;
  }
  return `notebook-${short.trim() || "result"}-preview.csv`;
}
