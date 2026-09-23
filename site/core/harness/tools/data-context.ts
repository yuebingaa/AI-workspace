import type { HarnessToolContext } from "./contracts";
import { StudioValidationError } from "@/core/schemas/errors";
import { recipeWithStepCount } from "@/core/data";

export function sourceAndRows(context: HarnessToolContext, dataSourceId: string) {
  const source = context.request.appSpec.dataSources.find((candidate) => candidate.id === dataSourceId);
  if (!source) throw new StudioValidationError("Harness 数据源校验失败", [`数据源不存在：${dataSourceId}`]);
  const rows = context.dataRuntime.rowsByDataSourceId[dataSourceId];
  if (!rows) throw new StudioValidationError("Harness 数据源校验失败", [`数据源没有可用的服务端运行数据：${dataSourceId}`]);
  return { source, rows };
}

export function recipeContext(context: HarnessToolContext, recipeId: string, stepCount?: number) {
  const recipe = context.request.recipes.find((candidate) => candidate.id === recipeId);
  if (!recipe) throw new StudioValidationError("Harness 配方校验失败", [`数据配方不存在：${recipeId}`]);
  const { source, rows } = sourceAndRows(context, recipe.sourceDatasetId);
  return { recipe: stepCount === undefined ? recipe : recipeWithStepCount(recipe, stepCount), source, rows };
}
