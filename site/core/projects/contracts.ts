import { z } from "zod";
import { uploadedDatasetDescriptorSchema } from "@/core/datasets/contracts";
import { parseStudioPersistedState, type StudioPersistedState } from "@/core/repository/studio-repository";

export const PROJECT_HEADER = "x-agentcanvas-project";
export const PROJECT_FORMAT = "agentcanvas-local-project-v1";
export const PROJECT_LIMITS = { tables: 50, files: 100, manifestBytes: 8 * 1024 * 1024, tableBytes: 32 * 1024 * 1024, fileBytes: 10 * 1024 * 1024, totalBytes: 512 * 1024 * 1024 } as const;
export const projectHandleSchema = z.string().uuid();
export const projectStateSchema: z.ZodType<StudioPersistedState> = z.unknown().transform((value, context) => {
  try { return parseStudioPersistedState(value); }
  catch { context.addIssue({ code: "custom", message: "项目工作台定义校验失败" }); return z.NEVER; }
});
export const projectTableSchema = z.object({
  descriptor: uploadedDatasetDescriptorSchema,
  file: z.string().regex(/^table-[0-9a-f-]{36}\.json$/u),
  bytes: z.number().int().positive().max(PROJECT_LIMITS.tableBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  kind: z.enum(["table", "result"]),
  savedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().optional(),
}).strict();
export const projectFileSchema = z.object({
  id: z.string().uuid(), name: z.string().min(1).max(255),
  file: z.string().regex(/^file-[0-9a-f-]{36}\.(xlsx|csv)$/u),
  bytes: z.number().int().positive().max(PROJECT_LIMITS.fileBytes),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  datasetIds: z.array(z.string().regex(/^dataset_upload_[A-Za-z0-9_-]{16,160}$/u)).max(PROJECT_LIMITS.tables),
  savedAt: z.iso.datetime(),
}).strict();
export const projectManifestSchema = z.object({
  format: z.literal(PROJECT_FORMAT), id: z.string().uuid(), name: z.string().trim().min(1).max(100),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  stateRevision: z.number().int().nonnegative(), state: projectStateSchema.nullable(),
  tables: z.array(projectTableSchema).max(PROJECT_LIMITS.tables),
  files: z.array(projectFileSchema).max(PROJECT_LIMITS.files),
}).strict().superRefine((value, ctx) => {
  const ids = value.tables.map((table) => table.descriptor.datasetId);
  if (new Set(ids).size !== ids.length || value.tables.some((table) => table.descriptor.storageMode !== "project")) ctx.addIssue({ code: "custom", message: "项目数据目录无效" });
  if (new Set(value.tables.map((table) => table.file)).size !== value.tables.length
    || new Set(value.files.map((file) => file.file)).size !== value.files.length
    || new Set(value.files.map((file) => file.id)).size !== value.files.length) ctx.addIssue({ code: "custom", message: "项目文件目录包含重复标识" });
  if (value.files.some((file) => file.datasetIds.some((id) => !ids.includes(id)))) ctx.addIssue({ code: "custom", message: "原始文件引用了未知数据表" });
  if ([...value.tables, ...value.files].reduce((size, entry) => size + entry.bytes, 0) > PROJECT_LIMITS.totalBytes) ctx.addIssue({ code: "custom", message: "项目数据超过 512 MiB 限制" });
});
export type ProjectManifest = z.infer<typeof projectManifestSchema>;
export type ProjectTable = z.infer<typeof projectTableSchema>;
export type ProjectFile = z.infer<typeof projectFileSchema>;
export interface ProjectSession { handle: string; path: string; manifest: ProjectManifest }
export const projectSessionSchema = z.object({ handle: projectHandleSchema, path: z.string().max(2_000), manifest: projectManifestSchema }).strict();
export const projectActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), path: z.string().trim().max(2_000), name: z.string().trim().min(1).max(100) }).strict(),
  z.object({ action: z.literal("open"), path: z.string().trim().min(1).max(2_000) }).strict(),
  z.object({ action: z.literal("save"), stateRevision: z.number().int().nonnegative(), state: projectStateSchema }).strict(),
  z.object({ action: z.literal("renameTable"), datasetId: z.string(), name: z.string().trim().min(1).max(160) }).strict(),
  z.object({ action: z.literal("restoreTable"), datasetId: z.string() }).strict(),
]);
