import { z } from "zod";
import { harnessNotebookCellSchema } from "@/core/harness/notebook-contracts";
import { semanticModelSchema } from "@/core/semantic/contracts";

export const NOTEBOOK_LIMITS = { inputBytes: 16 * 1024 * 1024, outputBytes: 2 * 1024 * 1024,
  rows: 1_000, columns: 30, queryTimeoutMs: 8_000, runTimeoutMs: 30_000, cells: 30 } as const;
export const notebookDocumentSchema = z.object({
  name: z.string().trim().min(1).max(160),
  revision: z.number().int().nonnegative(),
  cells: z.array(harnessNotebookCellSchema).max(NOTEBOOK_LIMITS.cells),
  lastDraftId: z.string().max(160).optional(),
}).strict().refine((document) => new TextEncoder().encode(JSON.stringify(document)).byteLength <= 80_000,
  "Notebook 步骤定义超过 80 KB，请拆分到不同工作界面");
export type NotebookDocument = z.infer<typeof notebookDocumentSchema>;
export const notebookLayerSchema = z.record(z.string().min(1).max(120), notebookDocumentSchema)
  .refine((layer) => Object.keys(layer).length <= 30, "最多保存 30 个工作界面的 Notebook");
export const notebookFieldSchema = z.object({
  name: z.string().min(1).max(120), label: z.string().min(1).max(160),
  type: z.enum(["string", "number", "date", "boolean"]),
}).strict();
const valueSchema = z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()]);
export const notebookTableSchema = z.object({
  fields: z.array(notebookFieldSchema).min(1).max(100),
  rows: z.array(z.record(z.string(), valueSchema)).max(NOTEBOOK_LIMITS.rows),
  truncated: z.boolean(),
}).strict();
export type NotebookTable = z.infer<typeof notebookTableSchema>;
export const notebookResultReferenceSchema = z.object({
  resultId: z.string().max(240), runId: z.string().max(160), cellId: z.string().max(120),
  revision: z.number().int().nonnegative(),
  mode: z.literal("table"),
  inputResultIds: z.array(z.string().max(240)).max(10),
  rowCount: z.number().int().nonnegative(), complete: z.boolean(),
  dataSignature: z.string().max(160),
  accessMode: z.enum(["user", "ai"]),
  connectionId: z.string().max(100).optional(),
}).strict();
export type NotebookResultReference = z.infer<typeof notebookResultReferenceSchema>;
export const notebookCellRunSchema = z.object({
  cellId: z.string().max(120), status: z.enum(["success", "failure", "blocked"]),
  durationMs: z.number().nonnegative(), error: z.string().max(1_000).optional(),
  table: notebookTableSchema.optional(), queryId: z.string().max(160).optional(),
  resultRef: notebookResultReferenceSchema.optional(),
}).strict();
export type NotebookCellRun = z.infer<typeof notebookCellRunSchema>;
export const notebookRunSchema = z.object({
  runId: z.string().max(160), revision: z.number().int().nonnegative(),
  startedAt: z.iso.datetime(), status: z.enum(["success", "failure"]),
  cells: z.array(notebookCellRunSchema).max(NOTEBOOK_LIMITS.cells),
  dataSignature: z.string().max(160), notice: z.string().max(1_000),
}).strict();
export type NotebookRun = z.infer<typeof notebookRunSchema>;
export const notebookRunRequestSchema = z.object({
  pageId: z.string().min(1).max(120), document: notebookDocumentSchema,
  targetCellId: z.string().min(1).max(120).optional(),
  action: z.enum(["run", "snapshot", "dataset"]).default("run"),
  semanticModels: z.array(semanticModelSchema).max(30).default([]),
}).strict();
export const notebookSqlTableSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,119}$/u),
  fields: z.array(notebookFieldSchema).min(1).max(100),
  rows: z.array(z.record(z.string(), valueSchema)).max(50_000),
}).strict();
export type NotebookSqlTable = z.infer<typeof notebookSqlTableSchema>;
