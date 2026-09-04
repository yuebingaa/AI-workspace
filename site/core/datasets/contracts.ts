import { z } from "zod";
import type { DataRecipe, DataRow, DataSourceDefinition, DatasetAiAccessPolicy } from "@/core/models";
import { dataRecipeSchema, dataSourceDefinitionSchema } from "@/core/schemas";

export interface CsvUploadLimits {
  maxFileBytes: number;
  maxRows: number;
  maxColumns: number;
  maxCellChars: number;
  maxCells: number;
  maxDatasets: number;
  retentionMs: number;
}

export const CSV_UPLOAD_LIMITS: CsvUploadLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 100,
  maxCellChars: 20_000,
  maxCells: 2_000_000,
  maxDatasets: 10,
  retentionMs: 30 * 60 * 1_000,
} as const;

export const MAX_DATASET_RESPONSE_BYTES = 32 * 1024 * 1024;

export const sensitiveCategorySchema = z.enum(["name", "phone", "email", "nationalId", "address"]);
export const datasetAiAccessPolicySchema = z.enum(["not-required", "pending", "masked", "exclude-sensitive-samples"]);

export interface DatasetFieldMapping {
  index: number;
  originalName: string;
  normalizedName: string;
}

export interface SensitiveFieldSummary {
  field: string;
  label: string;
  categories: Array<z.infer<typeof sensitiveCategorySchema>>;
}

export interface UploadedDatasetDescriptor {
  datasetId: string;
  originalFileName: string;
  source: DataSourceDefinition;
  recipe: DataRecipe;
  fieldMappings: DatasetFieldMapping[];
  sensitiveFields: SensitiveFieldSummary[];
  aiAccessPolicy: DatasetAiAccessPolicy;
  createdAt: string;
  expiresAt: string;
  retentionMinutes: number;
  persistenceNotice: string;
}

const dataValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
const dataRowSchema: z.ZodType<DataRow> = z.record(z.string(), dataValueSchema);

export const uploadedDatasetDescriptorSchema: z.ZodType<UploadedDatasetDescriptor> = z.object({
  datasetId: z.string().regex(/^dataset_upload_[A-Za-z0-9_-]{16,}$/u),
  originalFileName: z.string().trim().min(1).max(255),
  source: dataSourceDefinitionSchema,
  recipe: dataRecipeSchema,
  fieldMappings: z.array(z.object({
    index: z.number().int().nonnegative(),
    originalName: z.string().max(500),
    normalizedName: z.string().min(1).max(120),
  }).strict()).min(1).max(CSV_UPLOAD_LIMITS.maxColumns),
  sensitiveFields: z.array(z.object({
    field: z.string().min(1).max(120),
    label: z.string().min(1).max(500),
    categories: z.array(sensitiveCategorySchema).min(1).max(5),
  }).strict()).max(CSV_UPLOAD_LIMITS.maxColumns),
  aiAccessPolicy: datasetAiAccessPolicySchema,
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  retentionMinutes: z.number().int().positive(),
  persistenceNotice: z.string().min(1).max(500),
}).strict();

function validateDatasetConsistency(
  dataset: UploadedDatasetDescriptor,
  rows: DataRow[],
  context: z.RefinementCtx,
): void {
  let issueCount = 0;
  const addIssue = (path: Array<string | number>, message: string) => {
    if (issueCount >= 20) return;
    issueCount += 1;
    context.addIssue({ code: "custom", path, message });
  };
  const source = dataset.source;
  if (source.id !== dataset.datasetId) addIssue(["dataset", "source", "id"], "数据源标识必须与数据集标识一致");
  if (dataset.recipe.sourceDatasetId !== dataset.datasetId) addIssue(["dataset", "recipe", "sourceDatasetId"], "配方数据源必须与数据集标识一致");
  if (source.rowCount !== rows.length) addIssue(["dataset", "source", "rowCount"], "数据源行数必须与实际行数一致");
  if (source.updatedAt !== dataset.createdAt) addIssue(["dataset", "source", "updatedAt"], "数据源更新时间必须与数据集创建时间一致");
  if (source.expiresAt !== dataset.expiresAt) addIssue(["dataset", "source", "expiresAt"], "数据源到期时间必须与数据集到期时间一致");
  if (source.aiAccessPolicy !== dataset.aiAccessPolicy) addIssue(["dataset", "source", "aiAccessPolicy"], "数据源 AI 策略必须与数据集策略一致");

  const retentionMinutes = Math.round((Date.parse(dataset.expiresAt) - Date.parse(dataset.createdAt)) / 60_000);
  if (retentionMinutes !== dataset.retentionMinutes) addIssue(["dataset", "retentionMinutes"], "保留分钟数必须与创建/到期时间一致");

  const fieldNames = source.fields.map((field) => field.name);
  if (dataset.fieldMappings.length !== fieldNames.length) {
    addIssue(["dataset", "fieldMappings"], "字段映射数量必须与数据源字段数量一致");
  }
  dataset.fieldMappings.forEach((mapping, index) => {
    if (mapping.index !== index) addIssue(["dataset", "fieldMappings", index, "index"], "字段映射索引必须连续且与列顺序一致");
    if (mapping.normalizedName !== fieldNames[index]) addIssue(["dataset", "fieldMappings", index, "normalizedName"], "字段映射名称必须与数据源字段顺序一致");
  });

  const sensitiveByField = new Map<string, SensitiveFieldSummary>();
  dataset.sensitiveFields.forEach((summary, index) => {
    if (sensitiveByField.has(summary.field)) addIssue(["dataset", "sensitiveFields", index, "field"], "敏感字段目录不能重复");
    sensitiveByField.set(summary.field, summary);
  });
  const expectedSensitive = source.fields.filter((field) => field.sensitiveCategories?.length);
  if (sensitiveByField.size !== expectedSensitive.length) addIssue(["dataset", "sensitiveFields"], "敏感字段目录必须与数据源字段声明一致");
  expectedSensitive.forEach((field) => {
    const summary = sensitiveByField.get(field.name);
    if (!summary || summary.label !== field.label) {
      addIssue(["dataset", "sensitiveFields"], "敏感字段缺失或标签不一致：" + field.name);
      return;
    }
    const expected = [...(field.sensitiveCategories ?? [])].sort();
    const actual = [...summary.categories].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      addIssue(["dataset", "sensitiveFields"], "敏感字段分类不一致：" + field.name);
    }
  });

  const allowedFields = new Set(fieldNames);
  rows.forEach((row, rowIndex) => {
    const rowFields = Object.keys(row);
    if (rowFields.length !== fieldNames.length || rowFields.some((field) => !allowedFields.has(field))) {
      addIssue(["rows", rowIndex], "数据行字段必须与数据源字段目录完全一致");
    }
    source.fields.forEach((field) => {
      const value = row[field.name];
      if (value === null) return;
      const valid = field.type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : field.type === "boolean"
          ? typeof value === "boolean"
          : typeof value === "string";
      if (!valid) addIssue(["rows", rowIndex, field.name], "字段值与声明类型不一致：" + field.name);
    });
  });
}

export const datasetUploadResponseSchema = z.object({
  dataset: uploadedDatasetDescriptorSchema,
  rows: z.array(dataRowSchema).max(CSV_UPLOAD_LIMITS.maxRows),
}).strict().superRefine(({ dataset, rows }, context) => {
  validateDatasetConsistency(dataset, rows, context);
});

export type DatasetUploadResponse = z.infer<typeof datasetUploadResponseSchema>;

export const datasetConsentRequestSchema = z.object({
  policy: z.enum(["masked", "exclude-sensitive-samples"]),
}).strict();

export const datasetConsentResponseSchema = z.object({ dataset: uploadedDatasetDescriptorSchema }).strict();
