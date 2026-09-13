import { z } from "zod";
import { dataRecipeStepSchema } from "@/core/schemas/data-recipe";

export const MAX_HARNESS_NOTEBOOK_CELLS = 30;

const notebookIdentifierSchema = z.string().trim().min(1).max(120)
  .regex(/^[A-Za-z][A-Za-z0-9_-]*$/u);
const notebookOutputNameSchema = z.string().trim().min(1).max(120)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/u);
const notebookTitleSchema = z.string().trim().min(1).max(120);

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

const chartCellSchema = z.object({
  id: notebookIdentifierSchema,
  kind: z.literal("chart"),
  title: notebookTitleSchema,
  inputCellId: notebookIdentifierSchema,
  chartType: z.enum(["bar", "line", "area", "pie", "donut"]),
  categoryField: notebookOutputNameSchema,
  valueFields: z.array(notebookOutputNameSchema).min(1).max(4).refine((items) => new Set(items).size === items.length, "图表数值字段不能重复"),
}).strict();

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
}).strict();

export const harnessNotebookCellSchema = z.discriminatedUnion("kind", [
  dataCellSchema,
  semanticQueryCellSchema,
  sqlCellSchema,
  warehouseSqlCellSchema,
  transformCellSchema,
  tableCellSchema,
  chartCellSchema,
  textCellSchema,
]);
export type HarnessNotebookCell = z.infer<typeof harnessNotebookCellSchema>;

export const harnessNotebookDraftSchema = z.object({
  analysisPlanId: notebookIdentifierSchema.optional(),
  name: z.string().trim().min(1).max(160),
  cells: z.array(harnessNotebookCellSchema).min(1).max(MAX_HARNESS_NOTEBOOK_CELLS),
}).strict();
export type HarnessNotebookDraft = z.infer<typeof harnessNotebookDraftSchema>;

export const harnessNotebookArtifactSchema = z.object({
  id: notebookIdentifierSchema,
  version: z.literal(1),
  status: z.literal("draft"),
  name: z.string().trim().min(1).max(160),
  cells: z.array(harnessNotebookCellSchema).min(1).max(MAX_HARNESS_NOTEBOOK_CELLS),
  executionOrder: z.array(notebookIdentifierSchema).min(1).max(MAX_HARNESS_NOTEBOOK_CELLS),
  lineage: z.array(z.object({
    cellId: notebookIdentifierSchema,
    dependsOn: z.array(notebookIdentifierSchema).max(10),
  }).strict()).min(1).max(MAX_HARNESS_NOTEBOOK_CELLS),
  sourceDataSourceIds: z.array(notebookIdentifierSchema).max(MAX_HARNESS_NOTEBOOK_CELLS),
  connectionIds: z.array(z.string().max(100)).max(20).optional(),
  createdAt: z.iso.datetime(),
  baseRevision: z.number().int().nonnegative().optional(),
  executionEvidence: z.object({
    runId: z.string().max(160),
    status: z.enum(["success", "failure"]),
    completedCellIds: z.array(notebookIdentifierSchema).max(MAX_HARNESS_NOTEBOOK_CELLS),
    summary: z.string().max(1_000),
  }).strict().optional(),
  analysisPlanId: notebookIdentifierSchema.optional(),
}).strict();
export type HarnessNotebookArtifact = z.infer<typeof harnessNotebookArtifactSchema>;
