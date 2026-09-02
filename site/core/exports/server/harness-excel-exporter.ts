import type { HarnessExcelExporter } from "@/core/harness/tool-registry";
import { StudioValidationError } from "@/core/schemas";
import { excelExportStore } from "./excel-export-store";
import { generateDataRecipeExcel } from "./recipe-excel-export";

export const harnessExcelExporter: HarnessExcelExporter = async ({ recipeId, fileName }, context) => {
  const recipe = context.request.recipes.find((candidate) => candidate.id === recipeId);
  if (!recipe) throw new StudioValidationError("Excel 配方校验失败", [`数据配方不存在：${recipeId}`]);
  const source = context.request.appSpec.dataSources.find((candidate) => candidate.id === recipe.sourceDatasetId);
  const rows = context.dataRuntime.rowsByDataSourceId[recipe.sourceDatasetId];
  if (!source || !rows) throw new StudioValidationError("Excel 数据源校验失败", ["配方数据源或本地数据不存在"]);
  const generated = await generateDataRecipeExcel({
    recipe,
    source,
    rows,
    ...(fileName ? { requestedFileName: fileName } : {}),
    now: () => new Date(context.now()),
  });
  const artifact = excelExportStore.put(generated, new Date(context.now()));
  return {
    summary: `Excel“${artifact.fileName}”已生成：${artifact.rowCount} 行、${artifact.fieldCount} 个字段。`,
    data: {
      fileName: artifact.fileName,
      rowCount: artifact.rowCount,
      fieldCount: artifact.fieldCount,
      sizeBytes: artifact.sizeBytes,
      status: artifact.status,
    },
    exportArtifact: artifact,
  };
};
