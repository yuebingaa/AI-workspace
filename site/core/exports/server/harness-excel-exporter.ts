import { datasetRepository, type DatasetRepository } from "@/core/datasets/server/dataset-repository";
import type { HarnessExcelExporter } from "@/core/harness/tool-registry";
import type { OwnershipScope } from "@/core/identity/ownership";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { StudioValidationError } from "@/core/schemas";
import { excelExportStore } from "./excel-export-store";
import { generateDataRecipeExcel } from "./recipe-excel-export";

export interface HarnessExcelExporterOptions {
  ownership: OwnershipScope;
  repository?: DatasetRepository;
}

export function createHarnessExcelExporter(options: HarnessExcelExporterOptions): HarnessExcelExporter {
  return async ({ recipeId, fileName }, context) => {
    const recipe = context.request.recipes.find((candidate) => candidate.id === recipeId);
    if (!recipe) throw new StudioValidationError("Excel 配方校验失败", [`数据配方不存在：${recipeId}`]);
    let source = context.request.appSpec.dataSources.find((candidate) => candidate.id === recipe.sourceDatasetId);
    let rows = context.dataRuntime.rowsByDataSourceId[recipe.sourceDatasetId];
    if (recipe.sourceDatasetId.startsWith("dataset_upload_")) {
      const stored = await (options.repository ?? datasetRepository).get(options.ownership, recipe.sourceDatasetId);
      if (!stored) {
        throw new StudioValidationError("Excel 数据集所有权校验失败", ["上传数据集不存在、已过期或不属于当前身份"]);
      }
      source = stored.descriptor.source;
      rows = stored.rows;
    }
    if (!source || !rows) throw new StudioValidationError("Excel 数据源校验失败", ["配方数据源或本地数据不存在"]);
    const generated = await generateDataRecipeExcel({
      recipe,
      source,
      rows,
      ...(fileName ? { requestedFileName: fileName } : {}),
      now: () => new Date(context.now()),
    });
    const artifact = excelExportStore.put(generated, options.ownership, new Date(context.now()));
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
}

export const harnessExcelExporter = createHarnessExcelExporter({ ownership: resolveDemoRequestIdentity() });
