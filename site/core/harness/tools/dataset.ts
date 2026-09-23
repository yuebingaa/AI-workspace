import { defineTool } from "./contracts";
import { z } from "zod";
import { sourceAndRows, recipeContext } from "./data-context";
import { profileDatasetRows } from "@/core/datasets/quality-profile";
import { StudioValidationError } from "@/core/schemas/errors";
import { analyzeDataSourceFields, executeDataRecipe } from "@/core/data";
import type { DataRecipe } from "@/core/models";
import type { HarnessTableArtifact } from "../contracts";

export const inspectDataset = defineTool({
  name: "inspectDataset",
  description: "检查数据源概览、真实行列数、质量和字段名称。只读。",
  mode: "readOnly",
  schema: z.object({ dataSourceId: z.string().min(1).max(120) }).strict(),
  execute: ({ dataSourceId }, context) => {
    const { source, rows } = sourceAndRows(context, dataSourceId);
    return {
      summary: `当前数据集行集“${source.name}”包含 ${rows.length} 行、${source.fields.length} 个字段，导入/来源质量 ${source.qualityScore}%；不代表原文件空行统计。`,
      data: {
        id: source.id,
        name: source.name,
        rowCount: rows.length,
        columnCount: source.fields.length,
        qualityScore: source.qualityScore,
        qualityProfile: profileDatasetRows(source, rows),
        fields: source.fields.map((field) => ({ name: field.name, label: field.label, type: field.type })),
        fieldCount: source.fields.length,
      },
    };
  },
});

export const inspectFields = defineTool({
  name: "inspectFields",
  description: "分析字段类型、空值、唯一值、数值范围和少量示例。只读。",
  mode: "readOnly",
  schema: z.object({
    dataSourceId: z.string().min(1).max(120),
    fields: z.array(z.string().min(1).max(120)).max(30).optional(),
  }).strict(),
  execute: ({ dataSourceId, fields }, context) => {
    const { source, rows } = sourceAndRows(context, dataSourceId);
    const allowed = fields ? new Set(fields) : null;
    if (allowed) {
      const missing = [...allowed].filter((field) => !source.fields.some((candidate) => candidate.name === field));
      if (missing.length) throw new StudioValidationError("Harness 字段校验失败", [`字段不存在：${missing.join("、")}`]);
    }
    const analyses = analyzeDataSourceFields(source, rows)
      .filter((analysis) => !allowed || allowed.has(analysis.field))
      .map((analysis) => {
        const field = source.fields.find((candidate) => candidate.name === analysis.field);
        const sensitive = field?.sensitiveCategories ?? [];
        const samples = sensitive.length === 0
          ? analysis.samples.slice(0, 3)
          : source.aiAccessPolicy === "masked"
            ? [`[已脱敏：${sensitive.join("/")}]`]
            : [];
        return { ...analysis, samples, sensitiveCategories: sensitive };
      });
    return { summary: `已分析当前数据集行集的 ${analyses.length} 个字段，输入 ${rows.length} 行；空值仅 null/缺失，不代表原文件统计。`, data: {
      dataSourceId,
      rowCount: rows.length,
      fieldCount: analyses.length,
      rules: { scope: "current-dataset-rows", nulls: "null-or-missing", blankStrings: "not-null",
        denominator: "rows-per-field", originalFile: "not-measured" },
      fields: analyses,
    } };
  },
});

const transformSpreadsheetDataSchema = z.object({
  dataSourceId: z.string().min(1).max(120),
  resultName: z.string().trim().min(1).max(160).optional(),
  selectFields: z.array(z.string().min(1).max(120)).min(1).max(30).optional(),
  filters: z.array(z.object({
    field: z.string().min(1).max(120),
    operator: z.enum(["equals", "notEquals", "contains", "greaterThan", "greaterThanOrEqual", "lessThan", "lessThanOrEqual"]),
    value: z.union([z.string().max(500), z.number().finite(), z.boolean()]),
  }).strict()).max(8).optional(),
  groupBy: z.array(z.string().min(1).max(120)).min(1).max(5).optional(),
  aggregations: z.array(z.object({
    field: z.string().min(1).max(120),
    aggregation: z.enum(["sum", "average", "count", "countDistinct", "min", "max"]),
    as: z.string().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_]*$/u),
    label: z.string().trim().min(1).max(100),
  }).strict()).min(1).max(12).optional(),
  sort: z.array(z.object({
    field: z.string().min(1).max(120),
    direction: z.enum(["asc", "desc"]),
  }).strict()).min(1).max(10).optional(),
  limit: z.number().int().min(1).max(10_000).optional(),
}).strict().superRefine((args, validation) => {
  if (args.groupBy && !args.aggregations?.length) validation.addIssue({ code: "custom", path: ["aggregations"], message: "分组处理必须声明至少一个聚合字段" });
  if (args.aggregations && !args.groupBy?.length) validation.addIssue({ code: "custom", path: ["groupBy"], message: "聚合处理必须声明至少一个分组字段" });
});

export const transformSpreadsheetData = defineTool({
  name: "transformSpreadsheetData",
  description: "对已导入的 CSV/XLSX 数据执行确定性的字段选择、筛选、分组聚合、多级排序和行数限制。处理结果可从助手的处理配方或结果菜单查看，不自动加入看板，不修改 AppSpec。",
  mode: "readOnly",
  schema: transformSpreadsheetDataSchema,
  execute: (args, context) => {
    const { source, rows } = sourceAndRows(context, args.dataSourceId);
    const steps: DataRecipe["steps"] = [];
    args.filters?.forEach((filter, index) => steps.push({ id: `filter_${index + 1}`, type: "filter", ...filter }));
    if (args.groupBy && args.aggregations) {
      steps.push({ id: "group_result", type: "groupAggregate", groupBy: args.groupBy, aggregations: args.aggregations });
    } else if (args.selectFields) {
      steps.push({ id: "select_result_fields", type: "selectFields", fields: args.selectFields });
    }
    if (args.sort) steps.push({ id: "sort_result", type: "sort", by: args.sort });
    steps.push({ id: "limit_result", type: "limit", count: args.limit ?? 500 });

    const token = context.id().replace(/[^A-Za-z0-9_-]/gu, "_").slice(-48) || String(Math.trunc(context.now()));
    const recipe: DataRecipe = {
      id: `recipe_ai_${token}`,
      name: args.resultName ?? `${source.name} · AI 处理结果`,
      sourceDatasetId: source.id,
      outputDatasetId: `dataset_ai_${token}`,
      status: "ready",
      steps,
    };
    const result = executeDataRecipe(recipe, source, rows);
    if (!result.success) throw new StudioValidationError("表格处理失败", [result.error]);
    const visibleFields = result.fields.slice(0, 30);
    const previewRows = result.rows.slice(0, 200).map((row) => Object.fromEntries(
      visibleFields.map((field) => [field.name, row[field.name] ?? null]),
    ));
    const artifact: HarnessTableArtifact = {
      id: `table_${token}`,
      name: recipe.name,
      sourceDataSourceId: source.id,
      sourceName: source.name,
      fields: visibleFields.map(({ name, label, type }) => ({ name, label, type })),
      rows: previewRows,
      totalRowCount: result.rows.length,
      previewRowCount: previewRows.length,
      truncated: result.rows.length > previewRows.length || result.fields.length > visibleFields.length,
      transformations: result.steps.map((step) => `${step.stepType}：${step.inputRowCount} → ${step.outputRowCount} 行`).slice(0, 20),
      createdAt: new Date(context.now()).toISOString(),
    };
    return {
      summary: `表格“${artifact.name}”处理完成：${rows.length} 行输入，${artifact.totalRowCount} 行输出，可从助手的处理配方或结果菜单查看。`,
      data: {
        tableArtifactId: artifact.id,
        sourceDataSourceId: source.id,
        outputRowCount: artifact.totalRowCount,
        previewRowCount: artifact.previewRowCount,
        fields: artifact.fields,
        transformations: artifact.transformations,
        truncated: artifact.truncated,
      },
      tableArtifact: artifact,
    };
  },
});

export const previewDataRecipe = defineTool({
  name: "previewDataRecipe",
  description: "按顺序执行现有 DataRecipe，返回最多 10 行预览、步骤摘要和字段血缘。只读。",
  mode: "readOnly",
  schema: z.object({
    recipeId: z.string().min(1).max(120),
    stepCount: z.number().int().min(1).max(50).optional(),
  }).strict(),
  execute: ({ recipeId, stepCount }, context) => {
    const { recipe, source, rows } = recipeContext(context, recipeId, stepCount);
    const result = executeDataRecipe(recipe, source, rows);
    if (!result.success) throw new StudioValidationError("Harness 配方预览失败", [result.error]);
    return {
      summary: `配方“${recipe.name}”执行成功：${result.steps.length} 步，${rows.length} 行输入，${result.rows.length} 行输出。`,
      data: {
        fields: result.fields,
        outputRowCount: result.rows.length,
        steps: result.steps.map((step) => ({
          stepId: step.stepId,
          stepType: step.stepType,
          inputRowCount: step.inputRowCount,
          outputRowCount: step.outputRowCount,
          durationMs: step.durationMs,
        })),
        lineage: result.lineage,
      },
    };
  },
});

export const validateDataRecipe = defineTool({
  name: "validateDataRecipe",
  description: "使用现有 DataRecipe Schema 和本地执行器验证配方。只读。",
  mode: "readOnly",
  schema: z.object({ recipeId: z.string().min(1).max(120) }).strict(),
  execute: ({ recipeId }, context) => {
    const { recipe, source, rows } = recipeContext(context, recipeId);
    const result = executeDataRecipe(recipe, source, rows);
    if (!result.success) throw new StudioValidationError("Harness 配方验证失败", [result.error]);
    return {
      summary: `配方“${recipe.name}”通过 Schema 和 ${result.steps.length} 个执行步骤验证。`,
      data: { valid: true, outputRowCount: result.rows.length, outputFields: result.fields },
    };
  },
});

export const exportDataRecipeToExcel = defineTool({
  name: "exportDataRecipeToExcel",
  description: "把已成功预览的 DataRecipe 结果导出为临时 XLSX 下载文件。只导出配方结果，不修改 AppSpec。",
  mode: "readOnly",
  schema: z.object({
    recipeId: z.string().min(1).max(120),
    fileName: z.string().trim().min(1).max(100).optional(),
  }).strict(),
  execute: async (args, context) => {
    if (!context.excelExporter) throw new StudioValidationError("Excel 导出能力不可用", ["服务端没有配置 Excel 导出器"]);
    return context.excelExporter(args, context);
  },
});
