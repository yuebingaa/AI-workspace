import { beforeEach, describe, expect, it } from "vitest";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { MemoryDatasetRepository } from "@/core/datasets/server/dataset-repository";
import type { HarnessRequest } from "@/core/harness/contracts";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { excelExportStore } from "./excel-export-store";
import { createHarnessExcelExporter } from "./harness-excel-exporter";

const ownerA = { tenantId: "tenant_a", ownerId: "owner_a" };
const ownerB = { tenantId: "tenant_a", ownerId: "owner_b" };

function stream(text: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("Harness Excel 导出所有权", () => {
  beforeEach(() => excelExportStore.clear());

  it("生成前重新校验上传数据集所有权，并将下载文件绑定到同一所有者", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    let sequence = 0;
    const parsed = await parseCsvUpload({
      stream: stream("region,value\n区域甲,1"),
      originalFileName: "owned-export.csv",
      mimeType: "text/csv",
      id: () => `e${String(++sequence).padStart(31, "0")}`,
    });
    const repository = new MemoryDatasetRepository();
    await repository.put(ownerA, parsed);
    const fixture = demoFixtureResult.data.dataProduct;
    const request: HarnessRequest = {
      idempotencyKey: "request_owned_export_001",
      instruction: "导出数据集。",
      pageId: "page_home",
      dataSourceId: parsed.dataset.datasetId,
      appSpec: { ...fixture.appSpec, dataSources: [...fixture.appSpec.dataSources, parsed.dataset.source] },
      recipes: [...fixture.recipes, parsed.dataset.recipe],
      role: "editor",
    };
    const context = {
      request,
      dataRuntime: { rowsByDataSourceId: { [parsed.dataset.datasetId]: parsed.rows } },
      now: () => Date.now(),
      id: () => "tool_owned_export",
    };

    await expect(createHarnessExcelExporter({ ownership: ownerB, repository })(
      { recipeId: parsed.dataset.recipe.id },
      context,
    )).rejects.toThrow(/所有权校验失败/);

    const result = await createHarnessExcelExporter({ ownership: ownerA, repository })(
      { recipeId: parsed.dataset.recipe.id },
      context,
    );
    const artifactId = result.exportArtifact?.id;
    if (!artifactId) throw new Error("导出结果缺少文件标识");
    expect(excelExportStore.get(artifactId, ownerA)).toBeDefined();
    expect(excelExportStore.get(artifactId, ownerB)).toBeUndefined();
  });
});
