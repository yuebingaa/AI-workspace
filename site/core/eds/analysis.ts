import type { EdsChartItem, EdsComparison } from "./contracts";
import {
  EDS_BUILT_IN_DEFINITION,
  EDS_RULE_VERSION,
  EDS_TEMPLATE_VERSION,
  type EdsBuiltInChannel,
  type EdsBuiltInIssue,
} from "./built-in";
import { parseStrictEdsDateKey } from "./date";

export type EdsCellValue = string | number | boolean | Date | null | undefined;
export type EdsSheetData = EdsCellValue[][];

export interface EdsWorkbookSheet {
  sheet: string;
  data: EdsSheetData;
}

export interface EdsIssueDefinition {
  raw: string;
  display: string;
  index: number;
}

export interface EdsChannelDefinition {
  columnIndex: number;
  line: string;
  instance: string;
  displayLine: string;
  displayChannel: string;
}

export interface EdsTemplateDefinition {
  sheetName: string;
  date: string;
  shift: string;
  issues: EdsIssueDefinition[];
  channels: EdsChannelDefinition[];
  targetData: EdsSheetData;
}

export interface EdsReportDefinition {
  sheetName: string;
  issues: readonly EdsBuiltInIssue[];
  channels: readonly EdsBuiltInChannel[];
}

export interface EdsAnalysisResult<TComparison extends EdsComparison | null = EdsComparison | null> {
  template: EdsTemplateDefinition;
  detailRows: number[][];
  reportRows: number[][];
  issueSummary: EdsChartItem[];
  lineSummary: EdsChartItem[];
  comparison: TComparison;
  configuration: {
    templateVersion: typeof EDS_TEMPLATE_VERSION;
    ruleVersion: typeof EDS_RULE_VERSION;
    comparisonMode: "not_requested" | "custom_template";
  };
  summary: {
    date: string;
    shift: string;
    inputRows: number;
    matchedRows: number;
    issueCount: 14;
    channelCount: 20;
    totalOccurrences: number;
    totalMinutes: number;
    sourceSheets: string[];
  };
  warnings: string[];
}

export class EdsAnalysisError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "EdsAnalysisError";
  }
}

export const EDS_DETAIL_COLUMN_INDEXES = Object.freeze([
  4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  17, 18, 19, 20, 21, 22, 23, 24,
]);
export const EDS_REPORT_COLUMN_INDEXES = Object.freeze([...EDS_DETAIL_COLUMN_INDEXES, 16, 25]);

function normalizedText(value: EdsCellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return dateKey(value);
  return String(value).normalize("NFKC").trim();
}

function dateKey(value: EdsCellValue): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new EdsAnalysisError("工作日不是有效日期：无效 Date");
    const key = parseStrictEdsDateKey(value.toISOString());
    if (!key) throw new EdsAnalysisError(`工作日不是有效日期：${value.toISOString()}`);
    return key;
  }
  const text = normalizedText(value);
  const key = parseStrictEdsDateKey(text);
  if (!key) throw new EdsAnalysisError(`工作日格式无法识别或不是有效日期：${text || "空值"}`);
  return key;
}

function normalizedHeader(value: EdsCellValue): string {
  return normalizedText(value).replace(/\s+/gu, "").replaceAll("（", "(").replaceAll("）", ")").toLocaleLowerCase("en-US");
}

const REQUIRED_HEADERS = {
  line: ["line"],
  instance: ["instance"],
  issue: ["issuedescription"],
  duration: ["dt(s)"],
  date: ["工作日"],
  shift: ["班次"],
} as const;

interface SourceSheetIndex {
  name: string;
  rows: EdsSheetData;
  headers: Record<keyof typeof REQUIRED_HEADERS, number>;
  lines: Set<string>;
}

function findHeaderRow(sheet: EdsWorkbookSheet): { rowIndex: number; headers: SourceSheetIndex["headers"] } | null {
  const scanRows = sheet.data.slice(0, 20);
  for (let rowIndex = 0; rowIndex < scanRows.length; rowIndex += 1) {
    const headerValues = scanRows[rowIndex].map(normalizedHeader);
    const matches = Object.entries(REQUIRED_HEADERS).map(([key, aliases]) => [
      key,
      headerValues.flatMap((value, index) => (aliases as readonly string[]).includes(value) ? [index] : []),
    ] as const);
    if (matches.every(([, indexes]) => indexes.length > 0)) {
      const duplicate = matches.find(([, indexes]) => indexes.length > 1);
      if (duplicate) {
        const aliases = REQUIRED_HEADERS[duplicate[0] as keyof typeof REQUIRED_HEADERS];
        throw new EdsAnalysisError(`工作表“${sheet.sheet}”的必需表头“${aliases[0]}”只能出现一次`);
      }
      const entries = matches.map(([key, indexes]) => [key, indexes[0]] as const);
      return { rowIndex, headers: Object.fromEntries(entries) as SourceSheetIndex["headers"] };
    }
  }
  return null;
}

function sourceIndexes(sheets: EdsWorkbookSheet[]): SourceSheetIndex[] {
  const indexes = sheets.flatMap((sheet) => {
    const header = findHeaderRow(sheet);
    if (!header) return [];
    const rows = sheet.data.slice(header.rowIndex + 1).filter((row) => row.some((value) => normalizedText(value) !== ""));
    if (rows.length > 50_000) throw new EdsAnalysisError(`工作表“${sheet.sheet}”超过 50,000 行限制`, 413);
    return [{
      name: sheet.sheet,
      rows,
      headers: header.headers,
      lines: new Set(rows.map((row) => normalizedText(row[header.headers.line])).filter(Boolean)),
    }];
  });
  if (indexes.length < 2) throw new EdsAnalysisError("输入工作簿至少需要两张包含 EDS 必需字段的原始明细表");
  return indexes;
}

function targetSheet(sheets: EdsWorkbookSheet[]): EdsWorkbookSheet {
  const named = sheets.find((sheet) => sheet.sheet === "EDS飞达异常统计");
  if (named) return named;
  const structural = sheets.find((sheet) => (
    sheet.data.length >= 36
    && EDS_DETAIL_COLUMN_INDEXES.every((column) => normalizedText(sheet.data[2]?.[column]) && normalizedText(sheet.data[3]?.[column]))
    && Array.from({ length: 14 }, (_, issue) => normalizedText(sheet.data[6 + issue * 2]?.[0])).every(Boolean)
  ));
  if (!structural) throw new EdsAnalysisError("目标模板缺少“EDS飞达异常统计”工作表或等价的 14×20 布局");
  return structural;
}

export function parseEdsTemplate(sheets: EdsWorkbookSheet[]): EdsTemplateDefinition {
  const target = targetSheet(sheets);
  const issues = Array.from({ length: 14 }, (_, index) => {
    const rowIndex = 6 + index * 2;
    const raw = normalizedText(target.data[rowIndex]?.[0]);
    const display = normalizedText(target.data[rowIndex]?.[2]) || `异常 ${index + 1}`;
    if (!raw) throw new EdsAnalysisError(`目标模板 A${rowIndex + 1} 缺少完整异常名称`);
    return { raw, display, index };
  });
  if (new Set(issues.map((issue) => issue.raw)).size !== 14) throw new EdsAnalysisError("目标模板的 14 类异常必须互不重复");
  const channels: EdsChannelDefinition[] = [];
  EDS_DETAIL_COLUMN_INDEXES.forEach((columnIndex) => {
    const line = normalizedText(target.data[2]?.[columnIndex]);
    const instance = normalizedText(target.data[3]?.[columnIndex]);
    const previous = channels.at(-1);
    const displayLine = normalizedText(target.data[4]?.[columnIndex]) || (previous?.line === line ? previous.displayLine : line);
    const displayChannel = normalizedText(target.data[5]?.[columnIndex]) || instance;
    if (!line || !instance) throw new EdsAnalysisError(`目标模板 ${columnName(columnIndex)}3/${columnName(columnIndex)}4 缺少线体或通道映射`);
    channels.push({ columnIndex, line, instance, displayLine, displayChannel });
  });
  const channelKeys = channels.map((channel) => `${channel.line}\u0000${channel.instance}`);
  if (new Set(channelKeys).size !== 20) throw new EdsAnalysisError("目标模板的 20 个线体/通道映射必须互不重复");
  for (let channelIndex = 0; channelIndex < channels.length; channelIndex += 2) {
    const left = channels[channelIndex];
    const right = channels[channelIndex + 1];
    if (left.line !== right.line || left.displayLine !== right.displayLine) {
      throw new EdsAnalysisError(`目标模板 ${columnName(left.columnIndex)}–${columnName(right.columnIndex)} 列必须成对映射同一线体`);
    }
  }
  return {
    sheetName: target.sheet,
    date: dateKey(target.data[0]?.[2]),
    shift: normalizedText(target.data[0]?.[3]),
    issues,
    channels,
    targetData: target.data,
  };
}

function numeric(value: EdsCellValue): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function columnName(zeroBased: number): string {
  let value = zeroBased + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + (value % 26)) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function sum(values: number[]): number {
  let total = 0;
  for (const value of values) {
    total += value;
    if (!Number.isFinite(total)) throw new EdsAnalysisError("EDS 统计结果超过有限数值范围");
  }
  return total;
}

function closeEnough(left: number | null, right: number): boolean {
  return left !== null && Math.abs(left - right) <= Math.max(1e-8, Math.abs(right) * 1e-10);
}

function compareReport(template: EdsTemplateDefinition, reportRows: number[][]): EdsComparison {
  const mismatches: EdsComparison["mismatches"] = [];
  let coreMatched = 0;
  let reportMatched = 0;
  let coreTotal = 0;
  let reportTotal = 0;
  for (let relativeRow = 0; relativeRow < 30; relativeRow += 1) {
    const sheetRow = 6 + relativeRow;
    for (const columnIndex of EDS_REPORT_COLUMN_INDEXES) {
      const actual = reportRows[relativeRow][columnIndex];
      const expected = numeric(template.targetData[sheetRow]?.[columnIndex]);
      const matched = closeEnough(expected, actual);
      reportTotal += 1;
      if (matched) reportMatched += 1;
      const core = relativeRow < 28 && EDS_DETAIL_COLUMN_INDEXES.includes(columnIndex);
      if (core) {
        coreTotal += 1;
        if (matched) coreMatched += 1;
      }
      if (!matched && mismatches.length < 20) mismatches.push({ cell: `${columnName(columnIndex)}${sheetRow + 1}`, expected, actual });
    }
  }
  return { coreMatched, coreTotal, reportMatched, reportTotal, mismatchCount: reportTotal - reportMatched, mismatches };
}

function validateDefinition(definition: EdsReportDefinition): void {
  if (definition.issues.length !== 14 || new Set(definition.issues.map((issue) => issue.raw)).size !== 14) {
    throw new EdsAnalysisError("服务端内置 EDS 异常规则无效", 500);
  }
  const channelKeys = definition.channels.map((channel) => `${channel.line}\u0000${channel.instance}`);
  if (definition.channels.length !== 20 || new Set(channelKeys).size !== 20) {
    throw new EdsAnalysisError("服务端内置 EDS 通道规则无效", 500);
  }
  if (definition.channels.some((channel, index) => channel.columnIndex !== EDS_DETAIL_COLUMN_INDEXES[index])) {
    throw new EdsAnalysisError("服务端内置 EDS 报表版式无效", 500);
  }
}

function selectionFromSources(
  sources: SourceSheetIndex[],
  definition: EdsReportDefinition,
): { date: string; shift: string; channelSources: SourceSheetIndex[] } {
  const channelSources = definition.channels.map((channel) => {
    const line = normalizedText(channel.line);
    const candidates = sources.filter((source) => source.lines.has(line));
    if (candidates.length !== 1) throw new EdsAnalysisError(`线体“${line}”应且只能匹配一张原始明细表，实际匹配 ${candidates.length} 张`);
    return candidates[0];
  });
  const issueNames = new Set(definition.issues.map((issue) => normalizedText(issue.raw)));
  const channelKeys = new Set(definition.channels.map((channel) => `${normalizedText(channel.line)}\u0000${normalizedText(channel.instance)}`));
  const relevantSources = [...new Set(channelSources)];
  const selections = relevantSources.map((source) => {
    const values = new Set<string>();
    for (const row of source.rows) {
      const line = normalizedText(row[source.headers.line]);
      const instance = normalizedText(row[source.headers.instance]);
      const issue = normalizedText(row[source.headers.issue]);
      if (!issueNames.has(issue) || !channelKeys.has(`${line}\u0000${instance}`)) continue;
      const shift = normalizedText(row[source.headers.shift]);
      if (!shift) throw new EdsAnalysisError(`工作表“${source.name}”存在空班次的目标候选记录`);
      values.add(`${dateKey(row[source.headers.date])}\u0000${shift}`);
    }
    if (values.size === 0) throw new EdsAnalysisError(`工作表“${source.name}”没有匹配内置 EDS 规则的候选记录`);
    return values;
  });
  const common = [...selections[0]].filter((value) => selections.every((values) => values.has(value)));
  if (common.length === 0) throw new EdsAnalysisError("输入工作簿没有两张原始明细表共有的工作日与班次");
  if (common.length > 1) throw new EdsAnalysisError("输入工作簿包含多个共同工作日或班次，请拆分为单一日期和班次后重试");
  const [date, shift] = common[0].split("\u0000");
  return { date, shift, channelSources };
}

function templateFromDefinition(definition: EdsReportDefinition, date: string, shift: string): EdsTemplateDefinition {
  return {
    sheetName: definition.sheetName,
    date,
    shift,
    issues: definition.issues.map((issue, index) => ({
      raw: normalizedText(issue.raw),
      display: normalizedText(issue.display),
      index,
    })),
    channels: definition.channels.map((channel) => ({
      ...channel,
      line: normalizedText(channel.line),
      instance: normalizedText(channel.instance),
      displayLine: normalizedText(channel.displayLine),
      displayChannel: normalizedText(channel.displayChannel),
    })),
    targetData: [],
  };
}

function validateComparisonTemplate(candidate: EdsTemplateDefinition, template: EdsTemplateDefinition): void {
  if (candidate.date !== template.date || candidate.shift !== template.shift) {
    throw new EdsAnalysisError(`验收基准的日期/班次必须为 ${template.date} / ${template.shift}`);
  }
  const sameIssues = candidate.issues.every((issue, index) => issue.raw === template.issues[index].raw);
  const sameChannels = candidate.channels.every((channel, index) => (
    channel.columnIndex === template.channels[index].columnIndex
    && channel.line === template.channels[index].line
    && channel.instance === template.channels[index].instance
  ));
  if (!sameIssues || !sameChannels) {
    throw new EdsAnalysisError(`验收基准与内置模板 ${EDS_TEMPLATE_VERSION} 的异常或通道映射不一致`);
  }
}

export function analyzeEdsWorkbook(sourceSheets: EdsWorkbookSheet[], comparisonSheets: EdsWorkbookSheet[]): EdsAnalysisResult<EdsComparison>;
export function analyzeEdsWorkbook(sourceSheets: EdsWorkbookSheet[], comparisonSheets?: undefined): EdsAnalysisResult<null>;
export function analyzeEdsWorkbook(sourceSheets: EdsWorkbookSheet[], comparisonSheets?: EdsWorkbookSheet[]): EdsAnalysisResult;
export function analyzeEdsWorkbook(
  sourceSheets: EdsWorkbookSheet[],
  comparisonSheets?: EdsWorkbookSheet[],
  definition: EdsReportDefinition = EDS_BUILT_IN_DEFINITION,
): EdsAnalysisResult {
  validateDefinition(definition);
  const sources = sourceIndexes(sourceSheets);
  const { date, shift, channelSources } = selectionFromSources(sources, definition);
  const template = templateFromDefinition(definition, date, shift);
  const comparisonTemplate = comparisonSheets ? parseEdsTemplate(comparisonSheets) : null;
  if (comparisonTemplate) validateComparisonTemplate(comparisonTemplate, template);
  const keys = new Map<string, { count: number; seconds: number }>();
  let matchedRows = 0;
  const issueNames = new Set(template.issues.map((issue) => issue.raw));
  const channelKeys = new Set(template.channels.map((channel) => `${channel.line}\u0000${channel.instance}`));
  for (const source of sources) {
    for (const row of source.rows) {
      const shift = normalizedText(row[source.headers.shift]);
      const line = normalizedText(row[source.headers.line]);
      const instance = normalizedText(row[source.headers.instance]);
      const issue = normalizedText(row[source.headers.issue]);
      if (shift !== template.shift || !issueNames.has(issue) || !channelKeys.has(`${line}\u0000${instance}`)) continue;
      const date = dateKey(row[source.headers.date]);
      if (date !== template.date) continue;
      const duration = numeric(row[source.headers.duration]);
      if (duration === null || duration < 0) throw new EdsAnalysisError(`工作表“${source.name}”存在无法统计的 DT(s) 值`);
      const key = `${line}\u0000${instance}\u0000${issue}`;
      const current = keys.get(key) ?? { count: 0, seconds: 0 };
      current.count += 1;
      current.seconds += duration;
      if (!Number.isFinite(current.seconds)) throw new EdsAnalysisError(`工作表“${source.name}”的 DT(s) 累计值超过有限数值范围`);
      keys.set(key, current);
      matchedRows += 1;
    }
  }
  const detailRows = template.issues.flatMap((issue) => {
    const counts = template.channels.map((channel) => keys.get(`${channel.line}\u0000${channel.instance}\u0000${issue.raw}`)?.count ?? 0);
    const minutes = template.channels.map((channel) => (keys.get(`${channel.line}\u0000${channel.instance}\u0000${issue.raw}`)?.seconds ?? 0) / 60);
    return [counts, minutes];
  });
  const reportRows = Array.from({ length: 30 }, () => Array<number>(26).fill(0));
  detailRows.forEach((values, rowIndex) => {
    EDS_DETAIL_COLUMN_INDEXES.forEach((columnIndex, channelIndex) => { reportRows[rowIndex][columnIndex] = values[channelIndex]; });
    reportRows[rowIndex][16] = sum(values.slice(0, 12));
    reportRows[rowIndex][25] = sum(values.slice(12));
  });
  EDS_DETAIL_COLUMN_INDEXES.forEach((columnIndex, channelIndex) => {
    reportRows[28][columnIndex] = sum(detailRows.filter((_, rowIndex) => rowIndex % 2 === 0).map((row) => row[channelIndex]));
    reportRows[29][columnIndex] = sum(detailRows.filter((_, rowIndex) => rowIndex % 2 === 1).map((row) => row[channelIndex]));
  });
  reportRows[28][16] = sum(reportRows[28].slice(4, 16));
  reportRows[29][16] = sum(reportRows[29].slice(4, 16));
  reportRows[28][25] = sum(reportRows[28].slice(17, 25));
  reportRows[29][25] = sum(reportRows[29].slice(17, 25));
  const issueSummary = template.issues.map((issue, issueIndex) => ({
    label: issue.display,
    count: sum(detailRows[issueIndex * 2]),
    minutes: sum(detailRows[issueIndex * 2 + 1]),
  }));
  const lineGroups = new Map<string, { channels: number[]; label: string }>();
  template.channels.forEach((channel, channelIndex) => {
    const key = channel.displayLine || channel.line;
    const group = lineGroups.get(key) ?? { channels: [], label: key };
    group.channels.push(channelIndex);
    lineGroups.set(key, group);
  });
  const lineSummary = [...lineGroups.values()].map((group) => ({
    label: group.label,
    count: sum(group.channels.map((channel) => reportRows[28][EDS_DETAIL_COLUMN_INDEXES[channel]])),
    minutes: sum(group.channels.map((channel) => reportRows[29][EDS_DETAIL_COLUMN_INDEXES[channel]])),
  }));
  const comparison = comparisonTemplate ? compareReport(comparisonTemplate, reportRows) : null;
  const warnings = comparison && comparison.mismatchCount > 0
    ? [`目标表存在 ${comparison.mismatchCount} 个数值差异，请检查源数据、日期、班次或模板映射。`]
    : [];
  return {
    template,
    detailRows,
    reportRows,
    issueSummary,
    lineSummary,
    comparison,
    configuration: {
      templateVersion: EDS_TEMPLATE_VERSION,
      ruleVersion: EDS_RULE_VERSION,
      comparisonMode: comparison ? "custom_template" : "not_requested",
    },
    summary: {
      date: template.date,
      shift: template.shift,
      inputRows: sources.reduce((total, source) => total + source.rows.length, 0),
      matchedRows,
      issueCount: 14,
      channelCount: 20,
      totalOccurrences: sum(issueSummary.map((item) => item.count)),
      totalMinutes: sum(issueSummary.map((item) => item.minutes)),
      sourceSheets: [...new Set(channelSources.map((source) => source.name))],
    },
    warnings,
  };
}
