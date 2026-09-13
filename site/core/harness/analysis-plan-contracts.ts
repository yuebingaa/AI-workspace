import { z } from "zod";

export const MAX_HARNESS_ANALYSIS_STEPS = 30;

const identifierSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_-]*$/u);
const fieldSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_]*$/u);
const titleSchema = z.string().trim().min(1).max(120);
const objectiveSchema = z.string().trim().min(1).max(500);
const noDependenciesSchema = z.array(identifierSchema).max(0);
const oneDependencySchema = z.array(identifierSchema).length(1);
const dependenciesSchema = z.array(identifierSchema).min(1).max(10)
  .refine((items) => new Set(items).size === items.length, "依赖步骤不能重复");

const dataStepSchema = z.object({
  id: identifierSchema,
  kind: z.literal("data"),
  title: titleSchema,
  objective: objectiveSchema,
  dependsOn: noDependenciesSchema,
  sourceDataSourceId: identifierSchema,
}).strict();

const semanticQueryStepSchema = z.object({
  id: identifierSchema,
  kind: z.literal("semanticQuery"),
  title: titleSchema,
  objective: objectiveSchema,
  dependsOn: oneDependencySchema,
  modelId: identifierSchema,
  modelVersion: z.number().int().min(1).max(1_000_000),
  dimensions: z.array(fieldSchema).max(5).refine((items) => new Set(items).size === items.length, "维度不能重复"),
  measures: z.array(fieldSchema).min(1).max(20).refine((items) => new Set(items).size === items.length, "指标不能重复"),
}).strict();

const sqlStepSchema = z.object({
  id: identifierSchema,
  kind: z.literal("sql"),
  title: titleSchema,
  objective: objectiveSchema,
  dependsOn: dependenciesSchema,
  transformation: z.string().trim().min(1).max(800),
}).strict();

const warehouseSqlStepSchema = z.object({
  id: identifierSchema, kind: z.literal("warehouseSql"), title: titleSchema,
  objective: objectiveSchema, dependsOn: noDependenciesSchema,
  connectionId: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/u),
  transformation: z.string().trim().min(1).max(800),
}).strict();

const tableStepSchema = z.object({
  id: identifierSchema,
  kind: z.literal("table"),
  title: titleSchema,
  objective: objectiveSchema,
  dependsOn: oneDependencySchema,
  columns: z.array(fieldSchema).min(1).max(30).refine((items) => new Set(items).size === items.length, "表格字段不能重复"),
}).strict();

const transformStepSchema = z.object({
  id: identifierSchema, kind: z.literal("transform"), title: titleSchema,
  objective: objectiveSchema, dependsOn: oneDependencySchema,
  transformation: z.string().trim().min(1).max(800),
}).strict();

const chartStepSchema = z.object({
  id: identifierSchema,
  kind: z.literal("chart"),
  title: titleSchema,
  objective: objectiveSchema,
  dependsOn: oneDependencySchema,
  chartType: z.enum(["bar", "line", "area", "pie", "donut"]),
  categoryField: fieldSchema,
  valueFields: z.array(fieldSchema).min(1).max(4).refine((items) => new Set(items).size === items.length, "图表数值字段不能重复"),
}).strict();

const textStepSchema = z.object({
  id: identifierSchema,
  kind: z.literal("text"),
  title: titleSchema,
  objective: objectiveSchema,
  dependsOn: noDependenciesSchema,
  narrativeGoal: z.string().trim().min(1).max(800),
}).strict();

export const harnessAnalysisStepSchema = z.discriminatedUnion("kind", [
  dataStepSchema,
  semanticQueryStepSchema,
  sqlStepSchema,
  warehouseSqlStepSchema,
  transformStepSchema,
  tableStepSchema,
  chartStepSchema,
  textStepSchema,
]);
export type HarnessAnalysisStep = z.infer<typeof harnessAnalysisStepSchema>;

export const harnessAnalysisPlanDraftSchema = z.object({
  name: z.string().trim().min(1).max(160),
  objective: z.string().trim().min(1).max(800),
  questions: z.array(z.string().trim().min(1).max(300)).min(1).max(8),
  steps: z.array(harnessAnalysisStepSchema).min(1).max(MAX_HARNESS_ANALYSIS_STEPS),
  deliverables: z.array(z.enum(["table", "chart", "narrative"])).min(1).max(3)
    .refine((items) => new Set(items).size === items.length, "交付物不能重复"),
  assumptions: z.array(z.string().trim().min(1).max(300)).max(8).optional(),
}).strict();
export type HarnessAnalysisPlanDraft = z.infer<typeof harnessAnalysisPlanDraftSchema>;

export const harnessAnalysisPlanArtifactSchema = harnessAnalysisPlanDraftSchema.extend({
  id: identifierSchema,
  version: z.literal(1),
  status: z.literal("planned"),
  executionOrder: z.array(identifierSchema).min(1).max(MAX_HARNESS_ANALYSIS_STEPS),
  sourceDataSourceIds: z.array(identifierSchema).max(MAX_HARNESS_ANALYSIS_STEPS),
  connectionIds: z.array(z.string().max(100)).max(20).optional(),
  createdAt: z.iso.datetime(),
}).strict();
export type HarnessAnalysisPlanArtifact = z.infer<typeof harnessAnalysisPlanArtifactSchema>;
