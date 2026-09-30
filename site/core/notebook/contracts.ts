import { z } from "zod";
import { MAX_NOTEBOOK_CELLS, notebookCellSchema } from "./definition";
import { semanticModelSchema } from "@/core/semantic/contracts";
import { catalogReferenceSchema } from "@/core/metadata/contracts";
import { dataFieldSchema, dataTableSchema, type DataTable } from "@/core/datasets/table-contracts";
import { MAX_NOTEBOOK_TEXT_OUTPUT_CHARS, notebookTextPartsSchema } from "./text-references";
import { materializedVisualizationSchema } from "@/core/visualization/result";

export const NOTEBOOK_LIMITS = { inputBytes: 16 * 1024 * 1024, outputBytes: 2 * 1024 * 1024,
  rows: 1_000, columns: 30, queryTimeoutMs: 8_000, runTimeoutMs: 30_000, cells: MAX_NOTEBOOK_CELLS } as const;
export const notebookDocumentSchema = z.object({
  name: z.string().trim().min(1).max(160),
  revision: z.number().int().nonnegative(),
  cells: z.array(notebookCellSchema).max(NOTEBOOK_LIMITS.cells),
  lastDraftId: z.string().max(160).optional(),
}).strict().refine((document) => new TextEncoder().encode(JSON.stringify(document)).byteLength <= 80_000,
  "Notebook 步骤定义超过 80 KB，请拆分到不同工作界面");
export type NotebookDocument = z.infer<typeof notebookDocumentSchema>;
export const notebookLayerSchema = z.record(z.string().min(1).max(120), notebookDocumentSchema)
  .refine((layer) => Object.keys(layer).length <= 30, "最多保存 30 个工作界面的 Notebook");
export { dataFieldSchema as notebookFieldSchema };
export const notebookTableSchema = dataTableSchema.extend({
  rows: dataTableSchema.shape.rows.max(NOTEBOOK_LIMITS.rows),
});
export type NotebookTable = DataTable;
export const notebookResultReferenceSchema = z.object({
  resultId: z.string().max(240), runId: z.string().max(160), cellId: z.string().max(120),
  revision: z.number().int().nonnegative(),
  mode: z.literal("table"),
  inputResultIds: z.array(z.string().max(240)).max(10),
  rowCount: z.number().int().nonnegative(), complete: z.boolean(),
  dataSignature: z.string().max(160),
  accessMode: z.enum(["user", "ai"]),
  connectionId: z.string().max(100).optional(),
  catalogRef: catalogReferenceSchema.optional(),
  sourceDatasetIds: z.array(z.string().max(160)).max(10).optional(),
  sourceFiles: z.array(z.object({ name: z.string().max(180), sha256: z.string().length(64) }).strict()).max(3).optional(),
}).strict();
export type NotebookResultReference = z.infer<typeof notebookResultReferenceSchema>;
export const notebookCellTimingSchema = z.object({
  preparationMs: z.number().int().nonnegative(),
  executionMs: z.number().int().nonnegative(),
  failurePhase: z.enum(["preparation", "execution"]).optional(),
  termination: z.enum(["error", "cancelled", "timeout"]).optional(),
}).strict();
export type NotebookCellTiming = z.infer<typeof notebookCellTimingSchema>;
export const notebookCellRunSchema = z.object({
  cellId: z.string().max(120), status: z.enum(["success", "failure", "blocked"]),
  durationMs: z.number().nonnegative(), error: z.string().max(1_000).optional(),
  table: notebookTableSchema.optional(), queryId: z.string().max(160).optional(),
  text: z.string().max(MAX_NOTEBOOK_TEXT_OUTPUT_CHARS).optional(),
  textParts: notebookTextPartsSchema.optional(),
  resultRef: notebookResultReferenceSchema.optional(),
  visualization: materializedVisualizationSchema.optional(),
  visualizationNotice: z.string().max(500).optional(),
  stdout: z.string().max(2_000).optional(), stderr: z.string().max(2_000).optional(),
  timing: notebookCellTimingSchema.optional(),
}).strict().refine(result => !result.visualization || (result.status === "success" && !!result.table && !!result.resultRef && !result.text), "图表计算结果必须来自成功的表格运行")
  .refine(result => !result.textParts || (result.status === "success" && typeof result.text === "string"
  && !result.table && !result.resultRef && result.textParts.map(part => part.value).join("") === result.text), "说明排版片段与文本回执不一致");
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
  fields: dataTableSchema.shape.fields,
  rows: dataTableSchema.shape.rows.max(50_000),
}).strict();
export type NotebookSqlTable = z.infer<typeof notebookSqlTableSchema>;
