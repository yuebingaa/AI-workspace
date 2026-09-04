import type { DataRow, DataSourceDefinition, DataValue, FieldAnalysis } from "@/core/models";
import { StudioValidationError } from "@/core/schemas";

export const MAX_FIELD_SAMPLE_CHARS = 200;
export const MAX_DATA_PREVIEW_CELL_CHARS = 500;

function distinctKey(value: Exclude<DataValue, null>): string {
  return `${typeof value}:${String(value)}`;
}

function boundedDisplayValue(value: Exclude<DataValue, null>, maxChars: number): Exclude<DataValue, null> {
  return typeof value === "string" && value.length > maxChars
    ? `${value.slice(0, maxChars - 1)}…`
    : value;
}

export function analyzeDataSourceFields(
  source: DataSourceDefinition,
  rows: DataRow[],
): FieldAnalysis[] {
  return source.fields.map((field) => {
    const values = rows.map((row) => row[field.name] ?? null);
    const nonNullValues = values.filter((value): value is Exclude<DataValue, null> => value !== null);
    const distinct = new Map<string, Exclude<DataValue, null>>();
    nonNullValues.forEach((value) => distinct.set(distinctKey(value), value));
    if (field.type === "number" && nonNullValues.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      throw new StudioValidationError("字段分析失败", [`数值字段“${field.label}”包含非有限或非数值数据`]);
    }
    const numbers = field.type === "number" ? nonNullValues as number[] : [];
    return {
      field: field.name,
      label: field.label,
      type: field.type,
      nullCount: values.length - nonNullValues.length,
      nullRatio: values.length ? (values.length - nonNullValues.length) / values.length : 0,
      uniqueCount: distinct.size,
      ...(numbers.length ? {
        minimum: Math.min(...numbers),
        maximum: Math.max(...numbers),
        average: numbers.reduce((total, value) => total + value / numbers.length, 0),
      } : {}),
      samples: [...distinct.values()].slice(0, 5).map((value) => boundedDisplayValue(value, MAX_FIELD_SAMPLE_CHARS)),
    };
  });
}

export interface DataPreviewResult {
  fields: string[];
  rows: DataRow[];
}

export function createDataPreview(
  source: DataSourceDefinition,
  rows: DataRow[],
  visibleFields: string[] = source.fields.map((field) => field.name),
  limit = 20,
): DataPreviewResult {
  const allowedFields = new Set(source.fields.map((field) => field.name));
  const fields = visibleFields.filter((field) => allowedFields.has(field));
  return {
    fields,
    rows: rows.slice(0, Math.min(Math.max(limit, 0), 20)).map((row) => Object.fromEntries(
      fields.map((field) => {
        const value = row[field] ?? null;
        return [field, value === null ? null : boundedDisplayValue(value, MAX_DATA_PREVIEW_CELL_CHARS)];
      }),
    )),
  };
}
