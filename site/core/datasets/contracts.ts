import { z } from "zod";
import type { DataRecipe, DataRow, DataSourceDefinition, DatasetAiAccessPolicy } from "@/core/models";
import { dataRecipeSchema, dataSourceDefinitionSchema } from "@/core/schemas";

export interface CsvUploadLimits {
  maxFileBytes: number;
  maxRows: number;
  maxColumns: number;
  maxCellChars: number;
  maxDatasets: number;
  retentionMs: number;
}

export const CSV_UPLOAD_LIMITS: CsvUploadLimits = {
  maxFileBytes: 10 * 1024 * 1024,
  maxRows: 50_000,
  maxColumns: 100,
  maxCellChars: 20_000,
  maxDatasets: 10,
  retentionMs: 30 * 60 * 1_000,
} as const;

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

export const datasetUploadResponseSchema = z.object({
  dataset: uploadedDatasetDescriptorSchema,
  rows: z.array(dataRowSchema).max(CSV_UPLOAD_LIMITS.maxRows),
}).strict();

export type DatasetUploadResponse = z.infer<typeof datasetUploadResponseSchema>;

export const datasetConsentRequestSchema = z.object({
  policy: z.enum(["masked", "exclude-sensitive-samples"]),
}).strict();

export const datasetConsentResponseSchema = z.object({ dataset: uploadedDatasetDescriptorSchema }).strict();
