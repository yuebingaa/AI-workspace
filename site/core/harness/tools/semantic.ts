import { defineTool } from "./contracts";
import { semanticQuerySchema } from "@/core/semantic/contracts";
import { StudioValidationError } from "@/core/schemas/errors";
import { sourceAndRows } from "./data-context";
import { compileSemanticQuery } from "@/core/semantic/model";
import { executeDataRecipe, recipeWithStepCount } from "@/core/data";
import { semanticResultForAi } from "@/core/semantic/privacy";
import type { HarnessTableArtifact } from "../contracts";

export const querySemanticModel = defineTool({
  name: "querySemanticModel",
  description: "按用户选中的语义模型计算指标，维度和指标必须使用模型 key；dimensions 为空表示整体汇总。不接受自定义聚合或 SQL，不重复聚合已计算的指标。结果可从助手的处理配方或结果菜单查看，保留模型 ID、版本与源数据引用，不自动加入看板。",
  mode: "readOnly",
  schema: semanticQuerySchema,
  execute: (args, context) => {
    const model = context.request.semanticModel;
    if (!model || model.sourceDatasetId !== context.request.dataSourceId) throw new StudioValidationError("语义查询失败", ["请先选择与当前数据表匹配的语义模型"]);
    const { source, rows } = sourceAndRows(context, model.sourceDatasetId);
    if (source.aiAccessPolicy === "pending") throw new StudioValidationError("语义查询未授权", ["请先确认数据表的 AI 敏感字段处理方式"]);
    const recipe = compileSemanticQuery(model, source, args);
    // Aggregate the complete input before limiting display, so truncation and totals stay truthful.
    const result = executeDataRecipe(recipeWithStepCount(recipe, recipe.steps.length - 1), source, rows);
    if (!result.success) throw new StudioValidationError("语义查询失败", [result.error, "使用现有 DataRecipe 的严格空值规则；请先清洗无效或空值数据，不能自动当作 0。"]);
    const token = context.id().replace(/[^A-Za-z0-9_-]/gu, "_").slice(-48);
    const safeResult = semanticResultForAi(model, source, result.rows.slice(0, args.limit));
    const queryRows = safeResult.rows;
    const artifact: HarnessTableArtifact = {
      id: `semantic_table_${token}`, name: recipe.name, sourceDataSourceId: source.id, sourceName: source.name,
      fields: result.fields.map(({ name, label, type }) => ({ name, label, type })), rows: queryRows,
      totalRowCount: result.rows.length, previewRowCount: queryRows.length, truncated: result.rows.length > queryRows.length,
      transformations: [`语义模型：${model.name} · v${model.version} · ${model.id}`,
        ...(safeResult.redactedFields.length ? ["敏感维度使用匿名分组；敏感字段的非计数指标已隐藏，未向 AI 提供原值。"] : []), ...args.measures.map((key) => {
        const measure = model.measures.find((item) => item.key === key)!;
        return `${measure.label} = ${measure.aggregation}(${measure.field})`;
      })].slice(0, 20), createdAt: new Date(context.now()).toISOString(),
    };
    return {
      summary: `已按模型“${model.name}”v${model.version} 计算 ${args.measures.length} 个指标，读取 ${rows.length} 行，返回 ${queryRows.length} 行结果（上限 ${args.limit} 行）。${safeResult.redactedFields.length ? "敏感字段已隐藏或使用匿名分组，不能推断其原值。" : ""}`,
      data: { modelId: model.id, modelVersion: model.version, modelName: model.name, sourceDataSourceId: source.id,
        dimensions: args.dimensions, measures: args.measures, outputRowCount: queryRows.length, fields: artifact.fields,
        rows: queryRows.slice(0, 10), redactedFields: safeResult.redactedFields, truncated: queryRows.length > 10 || artifact.truncated, tableArtifactId: artifact.id },
      tableArtifact: artifact,
    };
  },
});
