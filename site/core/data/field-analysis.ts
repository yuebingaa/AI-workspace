import type { DataRow, DataSourceDefinition, DataValue, FieldAnalysis } from "@/core/models";

function distinctKey(value: Exclude<DataValue, null>): string {
  return `${typeof value}:${String(value)}`;
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
    const numbers = field.type === "number"
      ? nonNullValues.filter((value): value is number => typeof value === "number" && Number.isFinite(value))
      : [];
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
        average: numbers.reduce((total, value) => total + value, 0) / numbers.length,
      } : {}),
      samples: [...distinct.values()].slice(0, 5),
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
      fields.map((field) => [field, row[field] ?? null]),
    )),
  };
}
