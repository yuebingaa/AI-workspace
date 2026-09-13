import type { DataRow, DataSourceDefinition } from "@/core/models";
import type { SemanticModel } from "./contracts";

// Resolve sensitivity through physical fields, not output aliases. Neither tool
// observations nor task artifacts may contain hidden values under a new key.
export function semanticResultForAi(model: SemanticModel, source: DataSourceDefinition, rows: DataRow[]) {
  const sensitive = new Set(source.fields.filter((field) => field.sensitiveCategories?.length).map((field) => field.name));
  const hidden = [
    ...model.dimensions.filter((member) => sensitive.has(member.field)),
    ...model.measures.filter((member) => sensitive.has(member.field) && !["count", "countDistinct"].includes(member.aggregation)),
  ];
  const redactedFields = hidden.map((member) => member.key).filter((key) => rows.some((row) => key in row));
  return {
    redactedFields,
    rows: rows.map((row, index) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
      if (!redactedFields.includes(key)) return [key, value];
      const dimension = model.dimensions.some((member) => member.key === key);
      return [key, dimension ? `[${source.aiAccessPolicy === "masked" ? "已脱敏" : "已隐藏敏感字段"}分组 ${index + 1}]` : null];
    }))),
  };
}
