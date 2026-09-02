import { parse } from "csv-parse";
import type {
  DataFieldType,
  DataQualityAnomaly,
  DataRecipe,
  DataRow,
  DataSourceDefinition,
  DataSourceField,
  DataValue,
} from "@/core/models";
import { StudioValidationError } from "@/core/schemas";
import {
  CSV_UPLOAD_LIMITS,
  type DatasetFieldMapping,
  type DatasetUploadResponse,
  type CsvUploadLimits,
  type SensitiveFieldSummary,
  type UploadedDatasetDescriptor,
} from "../contracts";

export interface ParseCsvUploadInput {
  stream: ReadableStream<Uint8Array>;
  originalFileName: string;
  mimeType: string;
  now?: () => Date;
  id?: () => string;
  limits?: Partial<CsvUploadLimits>;
}

export class CsvDatasetError extends StudioValidationError {
  constructor(message: string, issues: string[], readonly status = 400) {
    super(message, issues);
    this.name = "CsvDatasetError";
  }
}

const ALLOWED_MIME_TYPES = new Set([
  "",
  "text/csv",
  "application/csv",
  "text/plain",
  "application/vnd.ms-excel",
]);

const BOOLEAN_TRUE = new Set(["true", "yes", "y", "是"]);
const BOOLEAN_FALSE = new Set(["false", "no", "n", "否"]);
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu;
const DATE_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[T\s].*)?$/u;

function safeOriginalFileName(value: string): string {
  const decoded = (() => {
    try { return decodeURIComponent(value); } catch { return value; }
  })().normalize("NFKC").trim();
  if (!decoded || decoded.length > 255 || decoded.includes("..") || /[/\\\u0000-\u001f]/u.test(decoded)) {
    throw new CsvDatasetError("CSV 文件名不合法", ["文件名不得包含路径、控制字符或路径穿越片段"]);
  }
  if (!decoded.toLocaleLowerCase("en-US").endsWith(".csv")) {
    throw new CsvDatasetError("CSV 文件类型不支持", ["当前仅允许上传 .csv 文件"]);
  }
  return decoded;
}

function validateMimeType(mimeType: string): void {
  const normalized = mimeType.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
  if (!ALLOWED_MIME_TYPES.has(normalized)) {
    throw new CsvDatasetError("CSV MIME 类型不合法", [`不支持的内容类型：${normalized || "未提供"}`], 415);
  }
}

function validateFileHeader(bytes: Uint8Array): void {
  const startsWith = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  if (startsWith(0x50, 0x4b, 0x03, 0x04) || startsWith(0x50, 0x4b, 0x05, 0x06)) {
    throw new CsvDatasetError("拒绝压缩或 Office 文件", ["检测到 ZIP/Office 文件头，当前仅支持纯文本 CSV"], 415);
  }
  if (startsWith(0xd0, 0xcf, 0x11, 0xe0) || startsWith(0x1f, 0x8b) || startsWith(0x52, 0x61, 0x72, 0x21)) {
    throw new CsvDatasetError("拒绝二进制伪装文件", ["文件头不是纯文本 CSV"], 415);
  }
}

function validateTextBytes(bytes: Uint8Array): void {
  if (bytes.includes(0)) throw new CsvDatasetError("CSV 包含 NUL 字符", ["检测到二进制或损坏内容"], 415);
  const invalidControl = bytes.some((byte) => byte < 0x20 && ![0x09, 0x0a, 0x0d].includes(byte));
  if (invalidControl) throw new CsvDatasetError("CSV 包含二进制控制字符", ["文件不是受支持的 UTF-8 CSV 文本"], 415);
}

function normalizeHeaders(headers: string[]): { mappings: DatasetFieldMapping[]; names: string[]; labels: string[] } {
  const used = new Map<string, number>();
  const mappings = headers.map((rawHeader, index) => {
    const originalName = rawHeader.normalize("NFKC").trim();
    const ascii = originalName
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/gu, "")
      .replace(/[^A-Za-z0-9_]+/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .replace(/_+/gu, "_");
    let base = ascii || `field_${index + 1}`;
    if (!/^[A-Za-z]/u.test(base)) base = `field_${base}`;
    base = base.slice(0, 108);
    const occurrence = (used.get(base) ?? 0) + 1;
    used.set(base, occurrence);
    const normalizedName = occurrence === 1 ? base : `${base}_${occurrence}`.slice(0, 120);
    return { index, originalName, normalizedName };
  });
  return {
    mappings,
    names: mappings.map((mapping) => mapping.normalizedName),
    labels: mappings.map((mapping) => mapping.originalName || `未命名字段 ${mapping.index + 1}`),
  };
}

function primitiveCandidate(value: string): DataFieldType {
  const normalized = value.trim().toLocaleLowerCase("en-US");
  if (BOOLEAN_TRUE.has(normalized) || BOOLEAN_FALSE.has(normalized)) return "boolean";
  if (NUMBER_PATTERN.test(normalized) && Number.isFinite(Number(normalized))) return "number";
  if (DATE_PATTERN.test(normalized) && !Number.isNaN(Date.parse(normalized))) return "date";
  return "string";
}

function inferField(values: Array<string | null>): { type: DataFieldType; conflictCount: number } {
  const candidates = values.filter((value): value is string => value !== null).map(primitiveCandidate);
  if (candidates.length === 0) return { type: "string", conflictCount: 0 };
  const counts = new Map<DataFieldType, number>();
  candidates.forEach((candidate) => counts.set(candidate, (counts.get(candidate) ?? 0) + 1));
  if (counts.size === 1) return { type: candidates[0], conflictCount: 0 };
  const dominant = [...counts.entries()].sort((left, right) => right[1] - left[1])[0];
  return { type: "string", conflictCount: candidates.length - dominant[1] };
}

function convertValue(value: string | null, type: DataFieldType): DataValue {
  if (value === null) return null;
  const trimmed = value.trim();
  if (type === "number") return Number(trimmed);
  if (type === "boolean") return BOOLEAN_TRUE.has(trimmed.toLocaleLowerCase("en-US"));
  if (type === "date") return new Date(trimmed).toISOString();
  return value;
}

function sensitiveCategories(label: string, values: Array<string | null>): DataSourceField["sensitiveCategories"] {
  const categories = new Set<NonNullable<DataSourceField["sensitiveCategories"]>[number]>();
  const key = label.toLocaleLowerCase("zh-CN");
  if (/姓名|名字|客户名|联系人|name/u.test(key)) categories.add("name");
  if (/电话|手机|手机号|tel|phone|mobile/u.test(key)) categories.add("phone");
  if (/邮箱|邮件|email|e-mail/u.test(key)) categories.add("email");
  if (/身份证|证件号|national.?id|id.?card/u.test(key)) categories.add("nationalId");
  if (/地址|住址|address/u.test(key)) categories.add("address");
  const samples = values.filter((value): value is string => value !== null).slice(0, 200).map((value) => value.trim());
  if (samples.some((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value))) categories.add("email");
  if (samples.some((value) => /^(?:\+?86[- ]?)?1[3-9]\d{9}$/u.test(value.replace(/[()]/gu, "")))) categories.add("phone");
  if (samples.some((value) => /^(?:\d{17}[\dXx]|\d{15})$/u.test(value))) categories.add("nationalId");
  return categories.size ? [...categories] : undefined;
}

function quartile(sorted: number[], ratio: number): number {
  const position = (sorted.length - 1) * ratio;
  const base = Math.floor(position);
  const remainder = position - base;
  return sorted[base] + (sorted[base + 1] === undefined ? 0 : remainder * (sorted[base + 1] - sorted[base]));
}

function numericOutlierCount(values: number[]): number {
  if (values.length < 4) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const q1 = quartile(sorted, 0.25);
  const q3 = quartile(sorted, 0.75);
  const spread = q3 - q1;
  if (spread === 0) return 0;
  const low = q1 - spread * 1.5;
  const high = q3 + spread * 1.5;
  return sorted.filter((value) => value < low || value > high).length;
}

function supportedAggregations(type: DataFieldType): DataSourceField["supportedAggregations"] {
  return type === "number"
    ? ["none", "sum", "average", "count", "countDistinct", "min", "max"]
    : type === "date"
      ? ["none", "count", "countDistinct", "min", "max"]
      : ["none", "count", "countDistinct"];
}

function buildDataset(
  rawRows: Array<Array<string | null>>,
  headers: ReturnType<typeof normalizeHeaders>,
  originalFileName: string,
  now: Date,
  idFactory: () => string,
  retentionMs: number,
): DatasetUploadResponse {
  const columnValues = headers.names.map((_, index) => rawRows.map((row) => row[index] ?? null));
  const inferred = columnValues.map(inferField);
  const fields: DataSourceField[] = headers.names.map((name, index) => ({
    name,
    label: headers.labels[index],
    originalName: headers.mappings[index].originalName,
    type: inferred[index].type,
    aggregatable: true,
    supportedAggregations: supportedAggregations(inferred[index].type),
    nullCount: columnValues[index].filter((value) => value === null).length,
    nullRate: rawRows.length ? columnValues[index].filter((value) => value === null).length / rawRows.length : 0,
    uniqueCount: new Set(columnValues[index].filter((value): value is string => value !== null)).size,
    typeConflictCount: inferred[index].conflictCount,
    ...(sensitiveCategories(headers.labels[index], columnValues[index])
      ? { sensitiveCategories: sensitiveCategories(headers.labels[index], columnValues[index]) }
      : {}),
  }));
  const rows: DataRow[] = rawRows.map((rawRow) => Object.fromEntries(headers.names.map((name, index) => [
    name,
    convertValue(rawRow[index] ?? null, inferred[index].type),
  ])));
  const nullCellCount = rawRows.reduce((total, row) => total + row.filter((value) => value === null).length, 0);
  const duplicateRowCount = rows.length - new Set(rows.map((row) => JSON.stringify(headers.names.map((name) => row[name])))).size;
  const typeConflictCount = inferred.reduce((total, item) => total + item.conflictCount, 0);
  const anomalies: DataQualityAnomaly[] = [];
  fields.forEach((field) => {
    if ((field.typeConflictCount ?? 0) > 0) anomalies.push({
      field: field.name,
      kind: "type-conflict",
      count: field.typeConflictCount ?? 0,
      message: `字段“${field.label}”存在 ${field.typeConflictCount} 个类型冲突值`,
    });
    if (field.type === "number") {
      const count = numericOutlierCount(rows.map((row) => row[field.name]).filter((value): value is number => typeof value === "number"));
      if (count > 0) anomalies.push({ field: field.name, kind: "numeric-outlier", count, message: `字段“${field.label}”检测到 ${count} 个统计异常值` });
    }
  });
  const totalCells = Math.max(1, rows.length * fields.length);
  const nullRate = nullCellCount / totalCells;
  const duplicateRate = rows.length ? duplicateRowCount / rows.length : 0;
  const conflictRate = typeConflictCount / totalCells;
  const anomalyRate = anomalies.reduce((total, item) => total + item.count, 0) / totalCells;
  const qualityScore = Math.max(0, Math.round(100 - nullRate * 30 - duplicateRate * 20 - conflictRate * 30 - anomalyRate * 20));
  const datasetId = `dataset_upload_${idFactory().replace(/[^A-Za-z0-9_-]/gu, "")}`;
  const recipeId = `recipe_upload_${idFactory().replace(/[^A-Za-z0-9_-]/gu, "")}`;
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + retentionMs).toISOString();
  const sensitiveFields: SensitiveFieldSummary[] = fields
    .filter((field) => field.sensitiveCategories?.length)
    .map((field) => ({ field: field.name, label: field.label, categories: field.sensitiveCategories ?? [] }));
  const aiAccessPolicy = sensitiveFields.length ? "pending" as const : "not-required" as const;
  const source: DataSourceDefinition = {
    id: datasetId,
    name: originalFileName.replace(/\.csv$/iu, ""),
    rowCount: rows.length,
    columnCount: fields.length,
    qualityScore,
    updatedAt: createdAt,
    sourceType: "csv",
    fields,
    expiresAt,
    ephemeral: true,
    aiAccessPolicy,
    quality: { nullCellCount, nullRate, duplicateRowCount, typeConflictCount, anomalies },
  };
  const recipe: DataRecipe = {
    id: recipeId,
    name: `${source.name} 标准预览配方`,
    sourceDatasetId: datasetId,
    outputDatasetId: `output_${datasetId}`,
    status: "ready",
    steps: [
      { id: `step_select_${idFactory().slice(0, 24)}`, type: "selectFields", fields: headers.names },
      { id: `step_limit_${idFactory().slice(0, 24)}`, type: "limit", count: Math.min(10_000, Math.max(1, rows.length)) },
    ],
  };
  const dataset: UploadedDatasetDescriptor = {
    datasetId,
    originalFileName,
    source,
    recipe,
    fieldMappings: headers.mappings,
    sensitiveFields,
    aiAccessPolicy,
    createdAt,
    expiresAt,
    retentionMinutes: Math.round(retentionMs / 60_000),
    persistenceNotice: "上传数据仅保存在当前服务进程内，服务重启或到期后会失效。",
  };
  return { dataset, rows };
}

export async function parseCsvUpload(input: ParseCsvUploadInput): Promise<DatasetUploadResponse> {
  const limits = { ...CSV_UPLOAD_LIMITS, ...input.limits };
  const originalFileName = safeOriginalFileName(input.originalFileName);
  validateMimeType(input.mimeType);
  const reader = input.stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const rawRows: Array<Array<string | null>> = [];
  const headerState: { value: string[] | null } = { value: null };
  let bytesRead = 0;
  let headerChecked = false;
  let initialBytes = new Uint8Array();
  let parserError: unknown;
  const parser = parse({
    bom: true,
    relax_column_count: false,
    skip_empty_lines: false,
    max_record_size: limits.maxCellChars * limits.maxColumns + limits.maxColumns,
    on_record(record: unknown) {
      if (!Array.isArray(record) || !record.every((value) => typeof value === "string")) {
        throw new CsvDatasetError("CSV 记录格式不合法", ["解析器返回了非文本单元格"]);
      }
      if (record.length === 0 || record.length > limits.maxColumns) {
        throw new CsvDatasetError("CSV 字段数量超限", [`检测到 ${record.length} 个字段，最多允许 ${limits.maxColumns} 个`], 413);
      }
      const oversized = record.findIndex((value) => value.length > limits.maxCellChars);
      if (oversized >= 0) {
        throw new CsvDatasetError("CSV 单元格文本超限", [`第 ${oversized + 1} 列超过 ${limits.maxCellChars} 个字符`], 413);
      }
      if (headerState.value && record.length !== headerState.value.length) {
        throw new CsvDatasetError("CSV 行列数不一致", [`数据行包含 ${record.length} 列，表头包含 ${headerState.value.length} 列`]);
      }
      return record;
    },
  });
  const completed = new Promise<void>((resolve, reject) => {
    parser.on("data", (record: string[]) => {
      if (!headerState.value) {
        headerState.value = record;
        return;
      }
      if (rawRows.length >= limits.maxRows) {
        parser.destroy(new CsvDatasetError("CSV 数据行数超限", [`最多允许 ${limits.maxRows.toLocaleString("zh-CN")} 行`], 413));
        return;
      }
      rawRows.push(record.map((value) => value.trim() === "" ? null : value));
    });
    parser.once("end", resolve);
    parser.once("error", reject);
  });

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > limits.maxFileBytes) throw new CsvDatasetError("CSV 文件大小超限", [`文件超过 ${limits.maxFileBytes} 字节`], 413);
      if (!headerChecked) {
        const needed = Math.max(0, 4 - initialBytes.length);
        const next = value.slice(0, needed);
        const merged = new Uint8Array(initialBytes.length + next.length);
        merged.set(initialBytes);
        merged.set(next, initialBytes.length);
        initialBytes = merged;
        if (initialBytes.length >= 4) {
          validateFileHeader(initialBytes);
          validateTextBytes(initialBytes);
          headerChecked = true;
        }
      }
      if (headerChecked) validateTextBytes(value);
      const text = decoder.decode(value, { stream: true });
      if (text && !parser.write(text)) {
        await new Promise<void>((resolve, reject) => {
          parser.once("drain", resolve);
          parser.once("error", reject);
        });
      }
    }
    if (!headerChecked) {
      validateFileHeader(initialBytes);
      validateTextBytes(initialBytes);
    }
    const tail = decoder.decode();
    parser.end(tail);
    await completed;
  } catch (error) {
    parserError = error;
    parser.destroy(error instanceof Error ? error : undefined);
    await reader.cancel().catch(() => undefined);
    await completed.catch(() => undefined);
  } finally {
    reader.releaseLock();
  }
  if (parserError) {
    if (parserError instanceof CsvDatasetError) throw parserError;
    if (parserError instanceof TypeError && /encoded data/u.test(parserError.message)) {
      throw new CsvDatasetError("CSV 编码不受支持", ["仅支持 UTF-8 或 UTF-8 BOM，请先转换文件编码"], 415);
    }
    throw new CsvDatasetError("CSV 解析失败", [parserError instanceof Error ? parserError.message : "文件内容不符合 CSV 规则"]);
  }
  if (!headerState.value || headerState.value.length === 0) throw new CsvDatasetError("CSV 缺少表头", ["文件必须包含至少一个字段名"]);
  if (rawRows.length === 0) throw new CsvDatasetError("CSV 没有数据行", ["文件必须包含至少一行数据"]);
  const headers = normalizeHeaders(headerState.value);
  return buildDataset(
    rawRows,
    headers,
    originalFileName,
    input.now?.() ?? new Date(),
    input.id ?? (() => crypto.randomUUID().replaceAll("-", "")),
    limits.retentionMs,
  );
}
