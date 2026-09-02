import { describe, expect, it } from "vitest";
import { createExecutionState } from "@/core/changesets";
import { executeChartBinding } from "@/core/data";
import { generateDataRecipeExcel, type ExcelSheetDefinition } from "@/core/exports/server/recipe-excel-export";
import { buildHarnessContextSelection } from "@/core/harness/context-selector";
import type { HarnessRequest } from "@/core/harness/contracts";
import { executeHarnessTool, harnessToolCatalog } from "@/core/harness/tool-registry";
import type { DataRecipe } from "@/core/models";
import { createStudioSnapshot } from "@/core/repository";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { parseCsvUpload } from "./server/csv-dataset";
import { MemoryDatasetRepository } from "./server/dataset-repository";

const demoOwnership = { tenantId: "tenant_demo", ownerId: "owner_demo" };

function stream(text: string) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); } });
}

async function uploaded() {
  let sequence = 0;
  const parsed = await parseCsvUpload({
    stream: stream("region,email,amount\n区域甲,synthetic-private@example.invalid,10\n区域乙,synthetic-other@example.invalid,20"),
    originalFileName: "synthetic-analysis.csv",
    mimeType: "text/csv",
    now: () => new Date("2026-09-02T06:00:00.000Z"),
    id: () => `a${String(++sequence).padStart(31, "0")}`,
  });
  const repository = new MemoryDatasetRepository({ now: () => new Date("2026-09-02T06:00:00.000Z") });
  const stored = await repository.put(demoOwnership, parsed);
  const descriptor = await repository.setAiAccessPolicy(demoOwnership, stored.descriptor.datasetId, "masked");
  return { descriptor, rows: stored.rows };
}

function requestFor(dataset: Awaited<ReturnType<typeof uploaded>>): HarnessRequest {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  const fixture = demoFixtureResult.data.dataProduct;
  return {
    idempotencyKey: "request_uploaded_dataset_001",
    instruction: "检查 synthetic-analysis 数据集字段并预览数据配方，不修改页面。",
    pageId: "page_home",
    dataSourceId: dataset.descriptor.datasetId,
    appSpec: { ...structuredClone(fixture.appSpec), dataSources: [...fixture.appSpec.dataSources, dataset.descriptor.source] },
    recipes: [...fixture.recipes, dataset.descriptor.recipe],
    role: "editor",
  };
}

describe("上传数据源与现有运行时集成", () => {
  it("Harness 发现上传 datasetId，并仅返回脱敏字段观察", async () => {
    const dataset = await uploaded();
    const request = requestFor(dataset);
    const runtime = { rowsByDataSourceId: { [dataset.descriptor.datasetId]: dataset.rows } };
    const catalog = harnessToolCatalog({ names: ["inspectDataset", "inspectFields"], request });
    expect(JSON.stringify(catalog)).toContain(dataset.descriptor.datasetId);
    const context = { request, dataRuntime: runtime, now: () => Date.now(), id: () => "tool_generated_id" };
    const overview = await executeHarnessTool("inspectDataset", { dataSourceId: dataset.descriptor.datasetId }, context);
    const fields = await executeHarnessTool("inspectFields", { dataSourceId: dataset.descriptor.datasetId }, context);
    expect(overview.summary).toContain("2 行");
    expect(JSON.stringify(fields)).not.toContain("synthetic-private@example.invalid");
    expect(JSON.stringify(fields)).toContain("已脱敏");
  });

  it("模型上下文不包含完整原始行，localStorage 快照只保存目录元数据", async () => {
    const dataset = await uploaded();
    const request = requestFor(dataset);
    const selection = buildHarnessContextSelection(request, [], 1);
    expect(JSON.stringify(selection.context)).not.toContain("synthetic-private@example.invalid");
    const product = demoFixtureResult.success ? structuredClone(demoFixtureResult.data.dataProduct) : null;
    if (!product) throw new Error("fixture unavailable");
    product.datasets.push({
      id: dataset.descriptor.datasetId,
      name: dataset.descriptor.source.name,
      rowCount: dataset.rows.length,
      columnCount: dataset.descriptor.source.columnCount,
      qualityScore: dataset.descriptor.source.qualityScore,
      expiresAt: dataset.descriptor.expiresAt,
      ephemeral: true,
      sensitiveFieldCount: dataset.descriptor.sensitiveFields.length,
      aiAccessPolicy: dataset.descriptor.aiAccessPolicy,
    });
    product.recipes.push(dataset.descriptor.recipe);
    product.appSpec.dataSources.push(dataset.descriptor.source);
    const snapshot = createStudioSnapshot(product, createExecutionState(product.appSpec), [], [], []);
    expect(JSON.stringify(snapshot)).not.toContain("synthetic-private@example.invalid");
    expect(JSON.stringify(snapshot)).toContain(dataset.descriptor.datasetId);
  });

  it("查询运行时可对上传数据分组，配方筛选后导出 Excel", async () => {
    const dataset = await uploaded();
    const source = dataset.descriptor.source;
    const runtime = { rowsByDataSourceId: { [source.id]: dataset.rows } };
    const chart = executeChartBinding({
      dataSourceId: source.id,
      field: "amount",
      aggregation: "sum",
      groupBy: "region",
      filters: [],
      sort: [{ field: "amount", direction: "desc" }],
      limit: 10,
      format: { style: "number" },
    }, [source], runtime);
    expect(chart.values).toEqual([20, 10]);

    const recipe: DataRecipe = {
      ...dataset.descriptor.recipe,
      id: "recipe_uploaded_filter",
      steps: [
        { id: "step_uploaded_select", type: "selectFields", fields: ["region", "email", "amount"] },
        { id: "step_uploaded_filter", type: "filter", field: "region", operator: "equals", value: "区域甲" },
      ],
    };
    let sheets: ExcelSheetDefinition[] = [];
    const generated = await generateDataRecipeExcel({
      recipe,
      source,
      rows: dataset.rows,
      writer: async (definitions) => { sheets = definitions; return Buffer.from("xlsx"); },
    });
    expect(generated.rowCount).toBe(1);
    expect(sheets.map((sheet) => sheet.sheet)).toEqual(["分析结果", "导出说明"]);
    expect(sheets[0].data).toHaveLength(2);
  });

  it("配方工具使用上传 datasetId 且不修改正式 AppSpec", async () => {
    const dataset = await uploaded();
    const request = requestFor(dataset);
    const formal = JSON.stringify(request.appSpec);
    const result = await executeHarnessTool("previewDataRecipe", { recipeId: dataset.descriptor.recipe.id }, {
      request,
      dataRuntime: { rowsByDataSourceId: { [dataset.descriptor.datasetId]: dataset.rows } },
      now: () => Date.now(),
      id: () => "tool_id",
    });
    expect(result.summary).toContain("执行成功");
    expect(JSON.stringify(request.appSpec)).toBe(formal);
  });
});
