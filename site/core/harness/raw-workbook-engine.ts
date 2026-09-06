import type { EdsCellValue, EdsWorkbookSheet } from "@/core/eds";

const MAX_PROFILE_VALUES = 500;
const MAX_TOP_VALUES = 5;
const RAW_INDEX_CACHE_TTL_MS = 30 * 60 * 1_000;
const RAW_INDEX_CACHE_MAX_ENTRIES = 4;

export type RawWorkbookScalar = string | number | boolean | null;

export interface RawWorkbookColumnProfile {
  column: string;
  header: string;
  inferredType: "empty" | "text" | "number" | "boolean" | "date" | "mixed";
  nonEmptyCount: number;
  emptyCount: number;
  distinctCount: number;
  distinctCountExact: boolean;
  minimum?: number;
  maximum?: number;
  average?: number;
  topValues: Array<{ value: RawWorkbookScalar; count: number }>;
}

export interface RawWorkbookSheetIndex {
  name: string;
  source: EdsWorkbookSheet;
  rowCount: number;
  columnCount: number;
  headerRow: number;
  dataRowNumbers: number[];
  columns: RawWorkbookColumnProfile[];
}

export interface RawWorkbookIndex {
  datasetVersion: string;
  sheets: RawWorkbookSheetIndex[];
  scannedRowCount: number;
  scannedDataRowCount: number;
  scannedCellCount: number;
}

const rawWorkbookIndexCache = new Map<string, { index: RawWorkbookIndex; expiresAt: number }>();

export type RawWorkbookFilterOperator = "equals" | "notEquals" | "contains" | "startsWith" | "greaterThan" | "greaterThanOrEqual" | "lessThan" | "lessThanOrEqual" | "between" | "in" | "isEmpty" | "isNotEmpty";

export interface RawWorkbookFilter {
  column: string;
  operator: RawWorkbookFilterOperator;
  value?: string | number | boolean;
  values?: Array<string | number | boolean>;
}

export interface RawWorkbookAggregation {
  operation: "count" | "sum" | "average" | "minimum" | "maximum" | "distinctCount";
  column?: string;
  alias: string;
}

export interface RawWorkbookOrder {
  field: string;
  direction: "ascending" | "descending";
}

export interface RawWorkbookQuery {
  mode: "rows" | "aggregate";
  sheetName: string;
  select?: string[];
  filters?: RawWorkbookFilter[];
  groupBy?: string[];
  aggregations?: RawWorkbookAggregation[];
  orderBy?: RawWorkbookOrder[];
  offset?: number;
  limit?: number;
}

export interface RawWorkbookQueryResult {
  datasetVersion: string;
  scanComplete: true;
  mode: "rows" | "aggregate";
  sheets: string[];
  scannedDataRowCount: number;
  matchedRowCount: number;
  returnedCount: number;
  hasMore: boolean;
  nextOffset?: number;
  rows?: Array<{ source: { sheet: string; rowNumber: number }; values: Record<string, RawWorkbookScalar> }>;
  groups?: Array<Record<string, RawWorkbookScalar>>;
}

interface ResolvedColumn {
  reference: string;
  header: string;
  index: number;
}

interface QueryRow {
  sheet: RawWorkbookSheetIndex;
  rowNumber: number;
  row: EdsCellValue[];
}

function columnLabel(index: number): string {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + value % 26) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function columnIndex(label: string): number | undefined {
  if (!/^[A-Z]{1,3}$/u.test(label)) return undefined;
  let value = 0;
  for (const character of label) value = value * 26 + character.charCodeAt(0) - 64;
  return value - 1;
}

function normalizedText(value: EdsCellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  return String(value).normalize("NFKC").trim();
}

function normalizedKey(value: EdsCellValue): string {
  if (value === null || value === undefined || normalizedText(value) === "") return "null:";
  if (value instanceof Date) return `date:${value.toISOString()}`;
  return `${typeof value}:${normalizedText(value).toLocaleLowerCase("zh-CN")}`;
}

function outputValue(value: EdsCellValue): RawWorkbookScalar {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  return value;
}

function populated(value: EdsCellValue): boolean {
  return normalizedText(value) !== "";
}

function detectHeaderRow(sheet: EdsWorkbookSheet): number {
  const knownHeaders = new Set(["line", "instance", "issuedescription", "dt(s)", "工作日", "班次"]);
  const candidates = sheet.data.slice(0, 20).map((row, rowIndex) => {
    const values = row.map((value) => normalizedText(value)).filter(Boolean);
    const strings = row.filter((value) => typeof value === "string" && normalizedText(value) !== "").length;
    const unique = new Set(values.map((value) => value.replace(/\s+/gu, "").toLocaleLowerCase("zh-CN"))).size;
    const known = values.filter((value) => knownHeaders.has(value.replace(/\s+/gu, "").toLocaleLowerCase("zh-CN"))).length;
    const usable = values.length >= 2 && unique >= Math.ceil(values.length * 0.6);
    return { rowIndex, usable, score: known * 1_000 + strings * 4 + unique - rowIndex };
  }).filter((candidate) => candidate.usable);
  return candidates.sort((left, right) => right.score - left.score)[0]?.rowIndex ?? 0;
}

function uniqueHeaders(row: EdsCellValue[], columnCount: number): string[] {
  const used = new Map<string, number>();
  return Array.from({ length: columnCount }, (_, index) => {
    const fallback = `列 ${columnLabel(index)}`;
    const base = normalizedText(row[index]) || fallback;
    const key = base.toLocaleLowerCase("zh-CN");
    const occurrence = (used.get(key) ?? 0) + 1;
    used.set(key, occurrence);
    return occurrence === 1 ? base : `${base} (${occurrence})`;
  });
}

function inferType(typeCounts: Record<"text" | "number" | "boolean" | "date", number>): RawWorkbookColumnProfile["inferredType"] {
  const present = Object.entries(typeCounts).filter(([, count]) => count > 0).map(([type]) => type);
  return present.length === 0 ? "empty" : present.length === 1 ? present[0] as RawWorkbookColumnProfile["inferredType"] : "mixed";
}

function profileSheet(sheet: EdsWorkbookSheet): RawWorkbookSheetIndex {
  const columnCount = sheet.data.reduce((maximum, row) => Math.max(maximum, row.length), 0);
  const headerIndex = detectHeaderRow(sheet);
  const headers = uniqueHeaders(sheet.data[headerIndex] ?? [], columnCount);
  const dataRowNumbers = sheet.data.flatMap((row, index) => (
    index > headerIndex && row.some(populated) ? [index + 1] : []
  ));
  const columns = Array.from({ length: columnCount }, (_, index): RawWorkbookColumnProfile => {
    const typeCounts = { text: 0, number: 0, boolean: 0, date: 0 };
    let nonEmptyCount = 0;
    let numericCount = 0;
    let numericSum = 0;
    let minimum = Number.POSITIVE_INFINITY;
    let maximum = Number.NEGATIVE_INFINITY;
    let distinctOverflow = false;
    const distinct = new Set<string>();
    const counts = new Map<string, { value: RawWorkbookScalar; count: number }>();
    for (const rowNumber of dataRowNumbers) {
      const value = sheet.data[rowNumber - 1]?.[index];
      if (!populated(value)) continue;
      nonEmptyCount += 1;
      if (value instanceof Date) typeCounts.date += 1;
      else if (typeof value === "number") {
        typeCounts.number += 1;
        if (Number.isFinite(value)) {
          numericCount += 1;
          numericSum += value;
          minimum = Math.min(minimum, value);
          maximum = Math.max(maximum, value);
        }
      } else if (typeof value === "boolean") typeCounts.boolean += 1;
      else typeCounts.text += 1;
      const key = normalizedKey(value);
      if (distinct.size < MAX_PROFILE_VALUES || distinct.has(key)) distinct.add(key);
      else distinctOverflow = true;
      const current = counts.get(key);
      if (current) current.count += 1;
      else if (counts.size < MAX_PROFILE_VALUES) counts.set(key, { value: outputValue(value), count: 1 });
    }
    return {
      column: columnLabel(index),
      header: headers[index],
      inferredType: inferType(typeCounts),
      nonEmptyCount,
      emptyCount: dataRowNumbers.length - nonEmptyCount,
      distinctCount: distinct.size,
      distinctCountExact: !distinctOverflow,
      ...(numericCount > 0 ? {
        minimum,
        maximum,
        average: numericSum / numericCount,
      } : {}),
      topValues: [...counts.values()].sort((left, right) => right.count - left.count).slice(0, MAX_TOP_VALUES),
    };
  });
  return {
    name: sheet.sheet,
    source: sheet,
    rowCount: sheet.data.length,
    columnCount,
    headerRow: headerIndex + 1,
    dataRowNumbers,
    columns,
  };
}

export function indexRawWorkbook(sheets: EdsWorkbookSheet[], datasetVersion: string): RawWorkbookIndex {
  const now = Date.now();
  for (const [key, cached] of rawWorkbookIndexCache) {
    if (cached.expiresAt <= now) rawWorkbookIndexCache.delete(key);
  }
  const cached = rawWorkbookIndexCache.get(datasetVersion);
  if (cached) {
    cached.expiresAt = now + RAW_INDEX_CACHE_TTL_MS;
    rawWorkbookIndexCache.delete(datasetVersion);
    rawWorkbookIndexCache.set(datasetVersion, cached);
    return cached.index;
  }
  const indexedSheets = sheets.map(profileSheet);
  const index = {
    datasetVersion,
    sheets: indexedSheets,
    scannedRowCount: indexedSheets.reduce((total, sheet) => total + sheet.rowCount, 0),
    scannedDataRowCount: indexedSheets.reduce((total, sheet) => total + sheet.dataRowNumbers.length, 0),
    scannedCellCount: indexedSheets.reduce((total, sheet) => total + sheet.dataRowNumbers.length * sheet.columnCount, 0),
  };
  rawWorkbookIndexCache.set(datasetVersion, { index, expiresAt: now + RAW_INDEX_CACHE_TTL_MS });
  while (rawWorkbookIndexCache.size > RAW_INDEX_CACHE_MAX_ENTRIES) {
    const oldest = rawWorkbookIndexCache.keys().next().value as string | undefined;
    if (!oldest) break;
    rawWorkbookIndexCache.delete(oldest);
  }
  return index;
}

function normalizeReference(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLocaleLowerCase("zh-CN");
}

function resolveColumn(sheet: RawWorkbookSheetIndex, reference: string): ResolvedColumn {
  const normalized = normalizeReference(reference);
  const byHeader = sheet.columns.filter((column) => normalizeReference(column.header) === normalized);
  if (byHeader.length === 1) return { reference, header: byHeader[0].header, index: columnIndex(byHeader[0].column) ?? 0 };
  const byLetter = columnIndex(reference.trim().toLocaleUpperCase("en-US"));
  if (byLetter !== undefined && byLetter < sheet.columnCount) {
    return { reference, header: sheet.columns[byLetter].header, index: byLetter };
  }
  throw new Error(`工作表“${sheet.name}”不存在列“${reference}”`);
}

function specialValue(row: QueryRow, reference: string): EdsCellValue {
  if (reference === "$sheet") return row.sheet.name;
  if (reference === "$row") return row.rowNumber;
  return row.row[resolveColumn(row.sheet, reference).index];
}

function comparable(value: EdsCellValue): string | number | boolean | null {
  if (!populated(value)) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = normalizedText(value);
  const numeric = Number(text);
  return text !== "" && Number.isFinite(numeric) ? numeric : text.toLocaleLowerCase("zh-CN");
}

function compare(left: EdsCellValue, right: string | number | boolean | undefined): number {
  const a = comparable(left);
  const b = comparable(right);
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "zh-CN", { numeric: true });
}

function matchesFilter(row: QueryRow, filter: RawWorkbookFilter): boolean {
  const value = specialValue(row, filter.column);
  const empty = !populated(value);
  switch (filter.operator) {
    case "isEmpty": return empty;
    case "isNotEmpty": return !empty;
    case "equals": return compare(value, filter.value) === 0;
    case "notEquals": return compare(value, filter.value) !== 0;
    case "contains": return normalizedText(value).toLocaleLowerCase("zh-CN").includes(String(filter.value ?? "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN"));
    case "startsWith": return normalizedText(value).toLocaleLowerCase("zh-CN").startsWith(String(filter.value ?? "").normalize("NFKC").trim().toLocaleLowerCase("zh-CN"));
    case "greaterThan": return compare(value, filter.value) > 0;
    case "greaterThanOrEqual": return compare(value, filter.value) >= 0;
    case "lessThan": return compare(value, filter.value) < 0;
    case "lessThanOrEqual": return compare(value, filter.value) <= 0;
    case "between": return compare(value, filter.values?.[0]) >= 0 && compare(value, filter.values?.[1]) <= 0;
    case "in": return Boolean(filter.values?.some((candidate) => compare(value, candidate) === 0));
  }
}

function selectedSheets(index: RawWorkbookIndex, sheetName: string): RawWorkbookSheetIndex[] {
  if (sheetName === "*") return index.sheets;
  const sheet = index.sheets.find((candidate) => candidate.name === sheetName);
  if (!sheet) throw new Error(`工作表不存在：“${sheetName}”`);
  return [sheet];
}

function assertReferences(sheets: RawWorkbookSheetIndex[], references: string[]): void {
  for (const reference of references) {
    if (reference === "$sheet" || reference === "$row") continue;
    for (const sheet of sheets) resolveColumn(sheet, reference);
  }
}

function scalarForOutput(value: unknown): RawWorkbookScalar {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return String(value);
}

function sortRecords(records: Array<Record<string, RawWorkbookScalar>>, orders: RawWorkbookOrder[]): void {
  records.sort((left, right) => {
    for (const order of orders) {
      const result = compare(left[order.field], right[order.field] ?? undefined);
      if (result !== 0) return order.direction === "descending" ? -result : result;
    }
    return 0;
  });
}

export function queryRawWorkbook(index: RawWorkbookIndex, query: RawWorkbookQuery): RawWorkbookQueryResult {
  const sheets = selectedSheets(index, query.sheetName);
  const filters = query.filters ?? [];
  const groupBy = query.groupBy ?? [];
  const aggregations = query.aggregations ?? [];
  const select = query.select?.length ? query.select : sheets[0]?.columns.slice(0, 12).map((column) => column.header) ?? [];
  const references = [
    ...filters.map((filter) => filter.column),
    ...(query.mode === "rows" ? select : groupBy),
    ...aggregations.flatMap((aggregation) => aggregation.column ? [aggregation.column] : []),
    ...(query.mode === "rows" ? (query.orderBy ?? []).map((order) => order.field) : []),
  ];
  assertReferences(sheets, references);
  if (query.mode === "aggregate" && aggregations.length === 0) throw new Error("聚合查询至少需要一个聚合指标");
  const aliases = aggregations.map((aggregation) => aggregation.alias);
  if (new Set([...groupBy, ...aliases].map(normalizeReference)).size !== groupBy.length + aliases.length) {
    throw new Error("分组字段与聚合别名不能重复");
  }
  if (query.mode === "aggregate") {
    const outputFields = new Set([...groupBy, ...aliases].map(normalizeReference));
    const unknownOrder = (query.orderBy ?? []).find((order) => !outputFields.has(normalizeReference(order.field)));
    if (unknownOrder) throw new Error(`聚合排序字段不存在：“${unknownOrder.field}”`);
  }

  const matched: QueryRow[] = [];
  const scannedDataRowCount = sheets.reduce((total, sheet) => total + sheet.dataRowNumbers.length, 0);
  for (const sheet of sheets) {
    for (const rowNumber of sheet.dataRowNumbers) {
      const row: QueryRow = { sheet, rowNumber, row: sheet.source.data[rowNumber - 1] ?? [] };
      if (filters.every((filter) => matchesFilter(row, filter))) matched.push(row);
    }
  }

  const offset = Math.max(0, query.offset ?? 0);
  const limit = Math.max(1, Math.min(30, query.limit ?? 20));
  if (query.mode === "rows") {
    const orderedRows = [...matched];
    if (query.orderBy?.length) orderedRows.sort((left, right) => {
      for (const order of query.orderBy ?? []) {
        const result = compare(specialValue(left, order.field), outputValue(specialValue(right, order.field)) ?? undefined);
        if (result !== 0) return order.direction === "descending" ? -result : result;
      }
      return left.rowNumber - right.rowNumber;
    });
    const records = orderedRows.map((row) => ({
      source: { sheet: row.sheet.name, rowNumber: row.rowNumber },
      values: Object.fromEntries(select.map((reference) => [
        reference,
        outputValue(specialValue(row, reference)),
      ])),
    }));
    const rows = records.slice(offset, offset + limit);
    return {
      datasetVersion: index.datasetVersion,
      scanComplete: true,
      mode: "rows",
      sheets: sheets.map((sheet) => sheet.name),
      scannedDataRowCount,
      matchedRowCount: matched.length,
      returnedCount: rows.length,
      hasMore: offset + rows.length < records.length,
      ...(offset + rows.length < records.length ? { nextOffset: offset + rows.length } : {}),
      rows,
    };
  }

  type AggregateState = { count: number; numericCount: number; sum: number; minimum?: number; maximum?: number; distinct?: Set<string> };
  const groups = new Map<string, { dimensions: Record<string, RawWorkbookScalar>; states: Map<string, AggregateState> }>();
  for (const row of matched) {
    const dimensionValues = groupBy.map((reference) => outputValue(specialValue(row, reference)));
    const key = JSON.stringify(dimensionValues);
    let group = groups.get(key);
    if (!group) {
      group = { dimensions: Object.fromEntries(groupBy.map((reference, indexValue) => [reference, dimensionValues[indexValue]])), states: new Map() };
      groups.set(key, group);
    }
    for (const aggregation of aggregations) {
      const state = group.states.get(aggregation.alias) ?? { count: 0, numericCount: 0, sum: 0 };
      state.count += 1;
      const value = aggregation.column ? specialValue(row, aggregation.column) : null;
      const numeric = typeof comparable(value) === "number" ? comparable(value) as number : undefined;
      if (numeric !== undefined) {
        state.numericCount += 1;
        state.sum += numeric;
        state.minimum = state.minimum === undefined ? numeric : Math.min(state.minimum, numeric);
        state.maximum = state.maximum === undefined ? numeric : Math.max(state.maximum, numeric);
      }
      if (aggregation.operation === "distinctCount") {
        state.distinct ??= new Set<string>();
        if (populated(value)) state.distinct.add(normalizedKey(value));
      }
      group.states.set(aggregation.alias, state);
    }
  }
  const records = [...groups.values()].map((group) => {
    const measures = aggregations.map((aggregation) => {
      const state = group.states.get(aggregation.alias) ?? { count: 0, numericCount: 0, sum: 0 };
      const value = aggregation.operation === "count" ? state.count
        : aggregation.operation === "sum" ? state.sum
          : aggregation.operation === "average" ? (state.numericCount ? state.sum / state.numericCount : null)
            : aggregation.operation === "minimum" ? state.minimum ?? null
              : aggregation.operation === "maximum" ? state.maximum ?? null
                : state.distinct?.size ?? 0;
      return [aggregation.alias, scalarForOutput(value)] as const;
    });
    return { ...group.dimensions, ...Object.fromEntries(measures) };
  });
  sortRecords(records, query.orderBy ?? []);
  const selected = records.slice(offset, offset + limit);
  return {
    datasetVersion: index.datasetVersion,
    scanComplete: true,
    mode: "aggregate",
    sheets: sheets.map((sheet) => sheet.name),
    scannedDataRowCount,
    matchedRowCount: matched.length,
    returnedCount: selected.length,
    hasMore: offset + selected.length < records.length,
    ...(offset + selected.length < records.length ? { nextOffset: offset + selected.length } : {}),
    groups: selected,
  };
}

export function publicRawWorkbookProfile(index: RawWorkbookIndex) {
  return {
    datasetVersion: index.datasetVersion.slice(0, 16),
    scanComplete: true as const,
    scannedRowCount: index.scannedRowCount,
    scannedDataRowCount: index.scannedDataRowCount,
    scannedCellCount: index.scannedCellCount,
    sheets: index.sheets.map((sheet) => ({
      name: sheet.name,
      rowCount: sheet.rowCount,
      dataRowCount: sheet.dataRowNumbers.length,
      columnCount: sheet.columnCount,
      headerRow: sheet.headerRow,
      columns: sheet.columns.map((column) => ({
        column: column.column,
        header: column.header,
        inferredType: column.inferredType,
        nonEmptyCount: column.nonEmptyCount,
        emptyCount: column.emptyCount,
        distinctCount: column.distinctCount,
        distinctCountExact: column.distinctCountExact,
        ...(column.minimum !== undefined ? { minimum: column.minimum, maximum: column.maximum, average: column.average } : {}),
        topValues: column.topValues,
      })),
    })),
    access: "session-memory-cache" as const,
  };
}
