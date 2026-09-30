import { z } from "zod";
import { dataRecipeStepSchema } from "@/core/schemas/data-recipe";
import { notebookParameterSchema } from "./parameter";
import { notebookTextReferencesSchema, validateNotebookTextTemplate } from "./text-references";
import { configSchema } from "@/core/chart-editor/config";

export const MAX_NOTEBOOK_CELLS = 30;

export const notebookIdentifierSchema = z.string().trim().min(1).max(120)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u);
const notebookOutputNameSchema = z.string().trim().min(1).max(120)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/u);
export const notebookTitleSchema = z.string().trim().min(1).max(120);

export const parameterCellSchema = z.object({
  id: notebookIdentifierSchema,
  kind: z.literal("parameter"),
  title: notebookTitleSchema,
  outputName: notebookOutputNameSchema,
  parameter: notebookParameterSchema,
}).strict();

const dataCellSchema = z.object({
  id: notebookIdentifierSchema,
  kind: z.literal("data"),
  title: notebookTitleSchema,
  sourceDataSourceId: notebookIdentifierSchema,
  outputName: notebookOutputNameSchema,
}).strict();

const semanticQueryCellSchema = z.object({
  id: notebookIdentifierSchema,
  kind: z.literal("semanticQuery"),
  title: notebookTitleSchema,
  inputCellId: notebookIdentifierSchema,
  modelId: notebookIdentifierSchema,
  modelVersion: z.number().int().min(1).max(1_000_000),
  dimensions: z.array(notebookOutputNameSchema).max(5).refine((items) => new Set(items).size === items.length, "维度不能重复"),
  measures: z.array(notebookOutputNameSchema).min(1).max(20).refine((items) => new Set(items).size === items.length, "指标不能重复"),
  limit: z.number().int().min(1).max(100),
  outputName: notebookOutputNameSchema,
}).strict();

const tableCellSchema = z.object({
  id: notebookIdentifierSchema,
  kind: z.literal("table"),
  title: notebookTitleSchema,
  inputCellId: notebookIdentifierSchema,
  columns: z.array(notebookOutputNameSchema).min(1).max(30).refine((items) => new Set(items).size === items.length, "表格字段不能重复"),
}).strict();

const sqlCellSchema = z.object({
  id: notebookIdentifierSchema,
  kind: z.literal("sql"),
  title: notebookTitleSchema,
  inputCellIds: z.array(notebookIdentifierSchema).min(1).max(10)
    .refine((items) => new Set(items).size === items.length, "输入单元不能重复"),
  outputName: notebookOutputNameSchema,
  sql: z.string().trim().min(1).max(10_000),
}).strict();

const warehouseSqlCellSchema = z.object({
  id: notebookIdentifierSchema, kind: z.literal("warehouseSql"), title: notebookTitleSchema,
  connectionId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/u),
  outputName: notebookOutputNameSchema,
  sql: z.string().trim().min(1).max(10_000),
}).strict();

export const pythonCellSchema = z.object({
  id: notebookIdentifierSchema, kind: z.literal("python"), title: notebookTitleSchema,
  inputCellIds: z.array(notebookIdentifierSchema).max(10)
    .refine((items) => new Set(items).size === items.length, "输入单元不能重复"),
  fileNames: z.array(z.string().min(1).max(180).regex(/^[^\\/\u0000-\u001f]+\.(?:xlsx|csv)$/iu)).max(3).default([])
    .refine((items) => new Set(items).size === items.length, "文件名不能重复"),
  outputName: notebookOutputNameSchema,
  code: z.string().min(1).max(20_000),
}).strict();

const chartCellSchema = z.object({
  id: notebookIdentifierSchema,
  kind: z.literal("chart"),
  title: notebookTitleSchema,
  inputCellId: notebookIdentifierSchema,
  chartType: z.enum(["bar", "line", "area", "pie", "donut"]),
  categoryField: notebookOutputNameSchema,
  valueFields: z.array(notebookOutputNameSchema).min(1).max(4).refine((items) => new Set(items).size === items.length, "图表数值字段不能重复"),
  graphicWalker: configSchema.extend({ mark: z.enum(["bar", "line", "area"]) }).optional(),
}).strict().superRefine((cell, context) => {
  const config = cell.graphicWalker;
  if (!config) return; // Old projects remain byte-for-byte compatible.
  if (config.datasetId !== `notebook:${cell.id}:${cell.inputCellId}` || config.mark !== cell.chartType
    || config.channels.x?.field !== cell.categoryField || cell.valueFields.length !== 1
    || config.channels.y?.field !== cell.valueFields[0] || config.title !== cell.title) {
    context.addIssue({ code: "custom", path: ["graphicWalker"], message: "图表配置与 Notebook 单元不一致，请重新保存图表。" });
  }
});

const transformCellSchema = z.object({
  id: notebookIdentifierSchema,
  kind: z.literal("transform"),
  title: notebookTitleSchema,
  inputCellId: notebookIdentifierSchema,
  outputName: notebookOutputNameSchema,
  steps: z.array(dataRecipeStepSchema).min(1).max(50),
}).strict();

const textCellSchema = z.object({
  id: notebookIdentifierSchema,
  kind: z.literal("text"),
  title: notebookTitleSchema,
  markdown: z.string().trim().min(1).max(4_000),
  references: notebookTextReferencesSchema.optional(),
}).strict().superRefine((cell, context) => {
  try { validateNotebookTextTemplate(cell); }
  catch (error) { context.addIssue({ code: "custom", path: ["markdown"], message: error instanceof Error ? error.message : "文本引用无效" }); }
});

export const notebookCellSchema = z.discriminatedUnion("kind", [
  dataCellSchema,
  semanticQueryCellSchema,
  sqlCellSchema,
  warehouseSqlCellSchema,
  pythonCellSchema,
  transformCellSchema,
  tableCellSchema,
  chartCellSchema,
  textCellSchema,
  parameterCellSchema,
]);
export type NotebookCell = z.infer<typeof notebookCellSchema>;

export const notebookDraftSchema = z.object({
  analysisPlanId: notebookIdentifierSchema.optional(),
  name: z.string().trim().min(1).max(160),
  cells: z.array(notebookCellSchema).min(1).max(MAX_NOTEBOOK_CELLS),
}).strict();
export type NotebookDraft = z.infer<typeof notebookDraftSchema>;

export const notebookArtifactSchema = z.object({
  id: notebookIdentifierSchema,
  version: z.literal(1),
  status: z.literal("draft"),
  name: z.string().trim().min(1).max(160),
  cells: z.array(notebookCellSchema).min(1).max(MAX_NOTEBOOK_CELLS),
  executionOrder: z.array(notebookIdentifierSchema).min(1).max(MAX_NOTEBOOK_CELLS),
  lineage: z.array(z.object({
    cellId: notebookIdentifierSchema,
    dependsOn: z.array(notebookIdentifierSchema).max(10),
  }).strict()).min(1).max(MAX_NOTEBOOK_CELLS),
  sourceDataSourceIds: z.array(notebookIdentifierSchema).max(MAX_NOTEBOOK_CELLS),
  connectionIds: z.array(z.string().max(100)).max(20).optional(),
  createdAt: z.iso.datetime(),
  baseRevision: z.number().int().nonnegative().optional(),
  executionEvidence: z.object({
    runId: z.string().max(160),
    status: z.enum(["success", "failure"]),
    completedCellIds: z.array(notebookIdentifierSchema).max(MAX_NOTEBOOK_CELLS),
    summary: z.string().max(1_000),
  }).strict().optional(),
  analysisPlanId: notebookIdentifierSchema.optional(),
}).strict();
export type NotebookArtifact = z.infer<typeof notebookArtifactSchema>;
