import { describe, expect, it } from "vitest";
import type { HarnessRequest } from "./contracts";
import { compactHarnessToolResult, executeHarnessTool, harnessToolCatalog, MAX_HARNESS_TOOL_RESULT_BYTES } from "./tool-registry";
import { jsonByteLength } from "./security";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { harnessExcelExporter } from "@/core/exports/server/harness-excel-exporter";
import { excelExportStore } from "@/core/exports/server/excel-export-store";
import { analyzeEdsWorkbook, createEdsWorkspaceRuntime, createEdsWorkspaceSnapshotForResults, installEdsWorkspaceInDataProduct, type EdsAnalysisResponse } from "@/core/eds";
import { createSyntheticEdsFixture } from "@/fixtures/eds-synthetic";

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

function edsContext() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  const analysis = analyzeEdsWorkbook(createSyntheticEdsFixture().sourceSheets);
  const response: EdsAnalysisResponse = {
    ...analysis,
    exportArtifact: {
      id: "eds-ai-artifact",
      status: "ready",
      fileName: "private-source.xlsx",
      downloadUrl: "/api/exports/private-source",
      rowCount: 1,
      fieldCount: 1,
      sizeBytes: 1,
      createdAt: "2026-09-04T06:00:00.000Z",
      expiresAt: "2026-09-04T06:10:00.000Z",
    },
    warnings: [],
  };
  response.summary.date = "2026-09-03";
  response.summary.shift = "白班";
  const night = structuredClone(response);
  night.summary.shift = "夜班";
  const edsWorkspace = createEdsWorkspaceSnapshotForResults([response, night], 1);
  const product = installEdsWorkspaceInDataProduct(demoFixtureResult.data.dataProduct, edsWorkspace);
  const request: HarnessRequest = {
    idempotencyKey: "request_eds_ai_tool",
    instruction: "比较白班和夜班 EDS 异常并给出建议，不要修改页面。",
    pageId: "page_eds_analysis",
    dataSourceId: "dataset_eds_overview",
    appSpec: product.appSpec,
    recipes: product.recipes,
    edsWorkspace,
    role: "editor",
  };
  return { request, dataRuntime: createEdsWorkspaceRuntime(edsWorkspace), now: () => 1_000, id: () => "eds_ai_tool_id" };
}

describe("Harness 类型化工具注册表", () => {
  it("暴露包含 EDS 分析和 Excel 导出的八个类型化工具及其参数 Schema", () => {
    const catalog = harnessToolCatalog();
    expect(catalog.map((tool) => tool.name)).toEqual([
      "analyzeEdsReports",
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

  it("EDS 分析工具返回全部班次的派生指标和差异且不暴露文件信息", async () => {
    const result = await executeHarnessTool("analyzeEdsReports", {}, edsContext());
    const serialized = JSON.stringify(result);

    expect(result.summary).toContain("2 份 EDS 派生报告");
    expect(result.data).toMatchObject({ reportCount: 2, rawRowsIncluded: false });
    expect(serialized).toContain("白班");
    expect(serialized).toContain("夜班");
    expect(serialized).toContain("deltaFromFirst");
    expect(serialized).not.toContain("private-source.xlsx");
    expect(serialized).not.toContain("/api/exports/");
    expect(jsonByteLength(result.data)).toBeLessThan(MAX_HARNESS_TOOL_RESULT_BYTES);
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
