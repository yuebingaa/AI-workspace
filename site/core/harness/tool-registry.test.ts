import { describe, expect, it } from "vitest";
import type { HarnessRequest } from "./contracts";
import { compactHarnessToolResult, executeHarnessTool, harnessToolCatalog, MAX_HARNESS_TOOL_RESULT_BYTES } from "./tool-registry";
import { jsonByteLength } from "./security";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { harnessExcelExporter } from "@/core/exports/server/harness-excel-exporter";
import { excelExportStore } from "@/core/exports/server/excel-export-store";

function context() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  const data = structuredClone(demoFixtureResult.data);
  const request: HarnessRequest = {
    idempotencyKey: "request_tool_registry",
    instruction: "检查字段和页面",
    pageId: "page_home",
    appSpec: data.dataProduct.appSpec,
    recipes: data.dataProduct.recipes,
    role: "editor",
  };
  return { request, dataRuntime: data.dataRuntime, now: () => 1_000, id: () => "tool_registry_id" };
}

describe("Harness 类型化工具注册表", () => {
  it("暴露包含 Excel 导出的七个类型化工具及其参数 Schema", () => {
    const catalog = harnessToolCatalog();
    expect(catalog.map((tool) => tool.name)).toEqual([
      "inspectDataset",
      "inspectFields",
      "previewDataRecipe",
      "validateDataRecipe",
      "exportDataRecipeToExcel",
      "inspectAppSpec",
      "createChangeSetPreview",
    ]);
    expect(catalog.every((tool) => tool.parameters.type === "object")).toBe(true);
  });

  it("复用字段分析与 AppSpec 检查并限制结果大小", async () => {
    const fields = await executeHarnessTool("inspectFields", {
      dataSourceId: "dataset_retail_orders",
      fields: ["revenue", "region"],
    }, context());
    expect(fields.summary).toContain("2 个字段");
    expect(jsonByteLength(fields.data)).toBeLessThan(MAX_HARNESS_TOOL_RESULT_BYTES);

    const appSpec = await executeHarnessTool("inspectAppSpec", { pageId: "page_home" }, context());
    expect(appSpec.summary).toContain("1 个页面");
    expect(jsonByteLength(appSpec.data)).toBeLessThan(MAX_HARNESS_TOOL_RESULT_BYTES);
  });

  it("inspectDataset 不返回原始行，超大工具结果会截断并保留摘要", async () => {
    const dataset = await executeHarnessTool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, context());
    expect(dataset.data).not.toHaveProperty("rows");
    expect(JSON.stringify(dataset.data).length).toBeLessThan(4_000);

    const compacted = compactHarnessToolResult({
      summary: "大量模拟结果",
      data: { rows: Array.from({ length: 100 }, (_, index) => ({ index, value: "x".repeat(100) })) },
    }, 400, 3);
    expect(JSON.stringify(compacted.data).length).toBeLessThanOrEqual(400);
    expect(compacted.summary).toContain("截断");
  });

  it("不存在的字段在工具层返回中文校验错误", async () => {
    await expect(executeHarnessTool("inspectFields", {
      dataSourceId: "dataset_retail_orders",
      fields: ["not_a_real_field"],
    }, context())).rejects.toThrow(/字段不存在/);
  });

  it("Excel 工具只返回下载元数据且不修改正式 AppSpec", async () => {
    excelExportStore.clear();
    const toolContext = context();
    const formal = structuredClone(toolContext.request.appSpec);
    const result = await executeHarnessTool("exportDataRecipeToExcel", {
      recipeId: "recipe_east_anomalies",
      fileName: "华东异常订单.xlsx",
    }, { ...toolContext, excelExporter: harnessExcelExporter });

    expect(result.exportArtifact).toMatchObject({ status: "ready", fileName: "华东异常订单.xlsx" });
    expect(result.data).toMatchObject({ status: "ready", fileName: "华东异常订单.xlsx" });
    expect(result.data).not.toHaveProperty("rows");
    expect(JSON.stringify(result)).not.toContain("UEsDB");
    expect(toolContext.request.appSpec).toEqual(formal);
  });
});
