import { describe, expect, it } from "vitest";
import type { HarnessRequest, HarnessSemanticIntentDecision } from "./contracts";
import { compactHarnessToolResult, executeHarnessTool, harnessToolCatalog, MAX_HARNESS_TOOL_RESULT_BYTES } from "./tool-registry";
import { buildHarnessContextSelection } from "./context-selector";
import { jsonByteLength } from "./security";
import { createExecutionState, previewChangeSet } from "@/core/changesets";
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
  it("AI 可以把工作界面新增请求编译为待确认 addPage ChangeSet", async () => {
    const toolContext = context();
    const result = await executeHarnessTool("createChangeSetPreview", {
      message: "已准备新增工作界面。",
      operations: [{ type: "addPage", title: "质量分析" }],
    }, toolContext);

    expect(result.pendingChangeSet?.operations[0]).toMatchObject({
      type: "addPage",
      page: { title: "质量分析", root: { type: "PageRoot" } },
      navigationItem: { title: "质量分析" },
    });
  });

  it("用户明确要求删除工作界面时会纠正语义目标误判，并只开放点名界面", () => {
    const toolContext = context();
    toolContext.request.instruction = "帮我把空白工作界面删除";
    toolContext.request.appSpec.navigation.push(
      { id: "nav_workspace_blank", pageId: "page_workspace_blank", title: "空白工作界面" },
      { id: "nav_workspace_blank_2", pageId: "page_workspace_blank_2", title: "空白工作界面 2" },
    );
    toolContext.request.appSpec.pages.push(
      { id: "page_workspace_blank", title: "空白工作界面", route: "/workspace/blank", root: { id: "root_workspace_blank", type: "PageRoot", props: {}, children: [] } },
      { id: "page_workspace_blank_2", title: "空白工作界面 2", route: "/workspace/blank-2", root: { id: "root_workspace_blank_2", type: "PageRoot", props: {}, children: [] } },
    );
    const mistakenSemanticIntent: HarnessSemanticIntentDecision = {
      mode: "changePreview",
      wantsData: false,
      wantsEdsAnalysis: false,
      wantsRawWorkbook: false,
      wantsFields: false,
      wantsRecipe: false,
      wantsAppInspection: false,
      wantsExcel: false,
      changeAction: "remove",
      changeTarget: "genericComponent",
      componentKind: "generic",
      chartType: "auto",
      skillIds: ["dashboard-editing"],
      confidence: 0.8,
      rationale: "模型误把工作界面识别成了普通组件。",
    };
    const selection = buildHarnessContextSelection(
      toolContext.request, [], 1, false, undefined, undefined, [], [], mistakenSemanticIntent,
    );
    const [changeTool] = harnessToolCatalog({
      names: selection.toolNames,
      editableNodes: selection.editableNodes,
      instruction: toolContext.request.instruction,
      request: toolContext.request,
      semanticIntent: mistakenSemanticIntent,
    });
    const parameters = JSON.stringify(changeTool.parameters);

    expect(selection.toolNames).toEqual(["createChangeSetPreview"]);
    expect(parameters).toContain('"deletePage"');
    expect(parameters).toContain('"page_workspace_blank"');
    expect(parameters).not.toContain('"page_workspace_blank_2"');
    expect(parameters).not.toContain('"updateNodeProps"');
  });

  it("暴露 EDS、通用表格处理、图表预览和 Excel 导出工具及其参数 Schema", () => {
    const catalog = harnessToolCatalog();
    expect(catalog.map((tool) => tool.name)).toEqual([
      "analyzeEdsReports",
      "scanEdsRawWorkbook",
      "queryEdsRawWorkbook",
      "inspectEdsRawWorkbook",
      "readEdsRawRows",
      "inspectDataset",
      "createAnalysisPlan",
      "createNotebookDraft",
      "inspectFields",
      "transformSpreadsheetData",
      "previewDataRecipe",
      "validateDataRecipe",
      "exportDataRecipeToExcel",
      "inspectAppSpec",
      "createEdsBreakdownChartPreview",
      "createEdsLineIssueChartPreview",
      "updateEdsTablePreview",
      "createChangeSetPreview",
    ]);
    expect(catalog.every((tool) => tool.parameters.type === "object")).toBe(true);
  });

  it("原始工作簿工具先检查清单，再按工作表和行列范围读取真实单元格", async () => {
    const toolContext = edsContext();
    const sheets = [{
      sheet: "白班明细",
      data: [
        ["线体", "异常类型", "次数"],
        ["A5FNL01", "飞达工位超时", 3],
        ["B5FSL01", "贴膜异常", 2],
      ],
    }];
    toolContext.request.rawWorkbookManifest = {
      fileName: "EDS原始数据.xlsx",
      contentHash: "e".repeat(64),
      sheets: [{ name: "白班明细", rowCount: 3, columnCount: 3 }],
    };
    const contextWithRaw = { ...toolContext, rawWorkbook: { fileName: "EDS原始数据.xlsx", contentHash: "e".repeat(64), sheets } };

    const scanned = await executeHarnessTool("scanEdsRawWorkbook", {}, contextWithRaw);
    expect(scanned.data).toMatchObject({
      scanComplete: true,
      scannedDataRowCount: 2,
      scannedCellCount: 6,
      sheets: [{ name: "白班明细", headerRow: 1, dataRowCount: 2 }],
    });

    const queried = await executeHarnessTool("queryEdsRawWorkbook", {
      mode: "aggregate",
      sheetName: "白班明细",
      groupBy: ["线体"],
      aggregations: [{ operation: "count", alias: "异常次数" }],
      orderBy: [{ field: "异常次数", direction: "descending" }],
      limit: 10,
    }, contextWithRaw);
    expect(queried.data).toMatchObject({
      scanComplete: true,
      scannedDataRowCount: 2,
      matchedRowCount: 2,
      groups: [{ 线体: "A5FNL01", 异常次数: 1 }, { 线体: "B5FSL01", 异常次数: 1 }],
    });

    const inspected = await executeHarnessTool("inspectEdsRawWorkbook", {}, contextWithRaw);
    expect(inspected.data).toMatchObject({
      access: "session-memory-cache",
      sheets: [{ name: "白班明细", rowCount: 3, columnCount: 3 }],
    });

    const read = await executeHarnessTool("readEdsRawRows", {
      sheetName: "白班明细",
      startRow: 2,
      rowCount: 2,
      startColumn: 1,
      columnCount: 3,
    }, contextWithRaw);
    expect(read.data).toMatchObject({
      sheetName: "白班明细",
      startRow: 2,
      endRow: 3,
      hasMoreRows: false,
      rows: [
        { rowNumber: 2, cells: { A: "A5FNL01", B: "飞达工位超时", C: 3 } },
        { rowNumber: 3, cells: { A: "B5FSL01", B: "贴膜异常", C: 2 } },
      ],
    });
    expect(JSON.stringify(read)).not.toContain("localStorage");
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

  it("EDS 分类制图工具由服务端生成安全饼图绑定", async () => {
    const toolContext = edsContext();
    const formal = structuredClone(toolContext.request.appSpec);
    const result = await executeHarnessTool("createEdsBreakdownChartPreview", {
      dimension: "issue",
      metric: "occurrences",
      chartType: "pie",
      limit: 8,
    }, toolContext);

    expect(result.pendingChangeSet?.operations[0]).toMatchObject({
      type: "addNode",
      parentId: "page_eds_analysis_charts",
      node: {
        type: "BarChart",
        props: {
          chartType: "pie",
          binding: {
            dataSourceId: "dataset_eds_breakdown",
            field: "occurrences",
            groupBy: "category",
            filters: expect.arrayContaining([
              { field: "view", operator: "equals", value: "异常分类" },
            ]),
          },
        },
      },
    });
    expect(toolContext.request.appSpec).toEqual(formal);
  });

  it("EDS 表格工具支持受控多级排序、显示字段、标题和样式且只生成预览", async () => {
    const toolContext = edsContext();
    toolContext.request.instruction = "线体与异常分类明细先按线体、再按异常分类排序，改成紧凑蓝色斑马纹";
    const formal = structuredClone(toolContext.request.appSpec);
    const selection = buildHarnessContextSelection(toolContext.request, [], 1);
    const [tableTool] = harnessToolCatalog({
      names: selection.toolNames,
      editableNodes: selection.editableNodes,
      instruction: toolContext.request.instruction,
      request: toolContext.request,
    });

    expect(selection.toolNames).toEqual(["updateEdsTablePreview"]);
    expect(JSON.stringify(tableTool.parameters)).toContain('"line"');
    expect(JSON.stringify(tableTool.parameters)).toContain('"category"');
    expect(JSON.stringify(tableTool.parameters)).not.toContain("requestedLineIssues");

    const result = await executeHarnessTool("updateEdsTablePreview", {
      nodeId: "eds_summary_table",
      title: "线体异常排序明细",
      visibleColumns: ["line", "category", "occurrences", "minutes"],
      sort: [
        { field: "line", direction: "asc" },
        { field: "category", direction: "asc" },
      ],
      density: "compact",
      stripedRows: true,
      accentColor: "blue",
    }, toolContext);

    expect(result.pendingChangeSet?.operations).toEqual([expect.objectContaining({
      type: "updateNodeProps",
      pageId: "page_eds_analysis",
      nodeId: "eds_summary_table",
      props: expect.objectContaining({
        title: "线体异常排序明细",
        density: "compact",
        stripedRows: true,
        accentColor: "blue",
        binding: expect.objectContaining({
          sort: [
            { field: "line", direction: "asc" },
            { field: "category", direction: "asc" },
          ],
          columns: [
            expect.objectContaining({ field: "line", label: "线体" }),
            expect.objectContaining({ field: "category", label: "异常分类" }),
            expect.objectContaining({ field: "occurrences", label: "异常次数" }),
            expect.objectContaining({ field: "minutes", label: "异常分钟" }),
          ],
        }),
      }),
    })]);
    expect(toolContext.request.appSpec).toEqual(formal);
  });

  it("重复新增同一种 EDS 图表时服务端生成不冲突的节点 ID", async () => {
    const toolContext = edsContext();
    const args = { dimension: "issue" as const, metric: "occurrences" as const, chartType: "pie" as const, limit: 8 };
    const first = await executeHarnessTool("createEdsBreakdownChartPreview", args, toolContext);
    if (!first.pendingChangeSet) throw new Error("预期第一张饼图存在待确认变更");
    const firstPreview = previewChangeSet(createExecutionState(toolContext.request.appSpec), first.pendingChangeSet, "editor");
    if (!firstPreview.preview) throw new Error("预期第一张饼图可生成预览");
    const second = await executeHarnessTool("createEdsBreakdownChartPreview", args, {
      ...toolContext,
      request: { ...toolContext.request, appSpec: firstPreview.preview.appSpec },
    });
    const firstOperation = first.pendingChangeSet.operations[0];
    const secondOperation = second.pendingChangeSet?.operations[0];

    expect(firstOperation.type).toBe("addNode");
    expect(secondOperation?.type).toBe("addNode");
    if (firstOperation.type !== "addNode" || secondOperation?.type !== "addNode") throw new Error("预期两次操作均为新增节点");
    expect(secondOperation.node.id).not.toBe(firstOperation.node.id);
    expect(secondOperation.node.id).toMatch(/_2$/);
  });

  it("样式指令只允许更新现有柱形图颜色，不会误生成图表或数据筛选", () => {
    const toolContext = edsContext();
    toolContext.request.instruction = "把柱形图颜色换成蓝色";
    const selection = buildHarnessContextSelection(toolContext.request, [], 1);
    const [changeTool] = harnessToolCatalog({
      names: selection.toolNames,
      editableNodes: selection.editableNodes,
      instruction: toolContext.request.instruction,
      request: toolContext.request,
    });
    const parameters = JSON.stringify(changeTool.parameters);

    expect(selection.toolNames).toEqual(["createChangeSetPreview"]);
    expect(parameters).toContain('"updateNodeProps"');
    expect(parameters).toContain('"color"');
    expect(parameters).toContain('"blue"');
    expect(parameters).not.toContain('"addNode"');
    expect(parameters).not.toContain('"binding"');
    expect(parameters).not.toContain('"view"');
  });

  it("柱形图增加顶部数字被识别为显示属性更新而不是新增图表", () => {
    const toolContext = edsContext();
    toolContext.request.instruction = "柱状图增加顶部数字显示";
    const selection = buildHarnessContextSelection(toolContext.request, [], 1);
    const [changeTool] = harnessToolCatalog({
      names: selection.toolNames,
      editableNodes: selection.editableNodes,
      instruction: toolContext.request.instruction,
      request: toolContext.request,
    });
    const parameters = JSON.stringify(changeTool.parameters);

    expect(selection.toolNames).toEqual(["createChangeSetPreview"]);
    expect(parameters).toContain('"updateNodeProps"');
    expect(parameters).toContain('"showValues"');
    expect(parameters).toContain('"boolean"');
    expect(parameters).not.toContain('"addNode"');
    expect(parameters).not.toContain('"binding"');
    expect(parameters).not.toContain('"view"');
  });

  it("新增饼图时只开放饼图类型并保留安全数据绑定 Schema", () => {
    const toolContext = edsContext();
    toolContext.request.instruction = "增加一个饼状图";
    const selection = buildHarnessContextSelection(toolContext.request, [], 1);
    const [changeTool] = harnessToolCatalog({
      names: selection.toolNames,
      editableNodes: selection.editableNodes,
      instruction: toolContext.request.instruction,
      request: toolContext.request,
    });
    const parameters = JSON.stringify(changeTool.parameters);

    expect(selection.toolNames).toEqual(["createChangeSetPreview"]);
    expect(parameters).toContain('"addNode"');
    expect(parameters).toContain('"chartType"');
    expect(parameters).toContain('"pie"');
    expect(parameters).not.toContain('"donut"');
    expect(parameters).toContain('"binding"');
  });

  it("已有图表可以只切换为环形图而不重建或改绑数据", () => {
    const toolContext = edsContext();
    toolContext.request.instruction = "把图表改成环形图";
    const selection = buildHarnessContextSelection(toolContext.request, [], 1);
    const [changeTool] = harnessToolCatalog({
      names: selection.toolNames,
      editableNodes: selection.editableNodes,
      instruction: toolContext.request.instruction,
      request: toolContext.request,
    });
    const parameters = JSON.stringify(changeTool.parameters);

    expect(parameters).toContain('"updateNodeProps"');
    expect(parameters).toContain('"chartType"');
    expect(parameters).toContain('"donut"');
    expect(parameters).not.toContain('"addNode"');
    expect(parameters).not.toContain('"binding"');
  });

  it("页面文字调整只开放受控字体属性", () => {
    const toolContext = context();
    toolContext.request.instruction = "把月度收入趋势标题改成蓝色微软雅黑 20 号加粗斜体";
    const selection = buildHarnessContextSelection(toolContext.request, [], 1);
    const [changeTool] = harnessToolCatalog({
      names: selection.toolNames,
      editableNodes: selection.editableNodes,
      instruction: toolContext.request.instruction,
      request: toolContext.request,
    });
    const parameters = JSON.stringify(changeTool.parameters);

    expect(parameters).toContain('"fontFamily"');
    expect(parameters).toContain('"fontSize"');
    expect(parameters).toContain('"fontColor"');
    expect(parameters).toContain('"fontWeight"');
    expect(parameters).toContain('"fontStyle"');
    expect(parameters).toContain('"textDecoration"');
    expect(parameters).toContain('"yahei"');
    expect(parameters).toContain('"bold"');
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

  it("用确定性表格工具筛选、排序并生成可展示的处理结果", async () => {
    const toolContext = context();
    const result = await executeHarnessTool("transformSpreadsheetData", {
      dataSourceId: "dataset_retail_orders",
      resultName: "华东订单处理结果",
      selectFields: ["region", "order_id", "revenue"],
      filters: [{ field: "region", operator: "equals", value: "华东" }],
      sort: [{ field: "revenue", direction: "desc" }],
      limit: 20,
    }, toolContext);

    expect(result.tableArtifact).toMatchObject({
      name: "华东订单处理结果",
      sourceDataSourceId: "dataset_retail_orders",
      fields: [{ name: "region" }, { name: "order_id" }, { name: "revenue" }],
    });
    expect(result.tableArtifact?.rows.every((row) => row.region === "华东")).toBe(true);
    expect(result.tableArtifact?.totalRowCount).toBeLessThanOrEqual(20);
    expect(toolContext.request.appSpec).toEqual(context().request.appSpec);
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
