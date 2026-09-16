import { afterEach, describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { harnessPublicRequestSchema, harnessRequestSchema, type HarnessModel, type HarnessRequest, type HarnessTraceEvent } from "./contracts";
import { inspectHarnessInput, inspectedModelContext, inputInspectionMessage, INPUT_INSPECTION_LIMITS } from "./input-inspector";
import { buildHarnessContextSelection } from "./context-selector";
import { HarnessRuntime } from "./runtime";
import * as inputInspector from "./input-inspector";

afterEach(() => vi.restoreAllMocks());

function fixture(): HarnessRequest {
  if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
  return { idempotencyKey: "input_inspector_test", instruction: "检查 retail_orders 数据集概况，不修改页面",
    pageId: "page_home", role: "editor", dataSourceId: "dataset_retail_orders",
    appSpec: structuredClone(demoFixtureResult.data.dataProduct.appSpec), recipes: [] };
}

function notebookFixture(): HarnessRequest {
  return { ...fixture(), notebookContext: { sourceIds: ["dataset_retail_orders"], connections: [
    { id: "allowed", name: "允许的连接", kind: "postgresql", allowAi: true },
    { id: "denied", name: "不可用连接", kind: "databricks", allowAi: false },
  ], document: { name: "分析文档", revision: 2, cells: [
    { id: "data", kind: "data", title: "来源", sourceDataSourceId: "dataset_retail_orders", outputName: "source_table" },
    { id: "sql", kind: "sql", title: "汇总", inputCellIds: ["data"], outputName: "totals", sql: "SELECT COUNT(*) AS n FROM source_table" },
    { id: "python", kind: "python", title: "文件", inputCellIds: [], fileNames: ["input.xlsx"], outputName: "frame", code: "frame = pd.read_excel(files['input.xlsx'])" },
    { id: "note", kind: "text", title: "说明", markdown: "PRIVATE_NOTE_MUST_NOT_BE_INSPECTED" },
  ] } } };
}

const workbook: NonNullable<HarnessRequest["rawWorkbookManifest"]> = { fileName: "input.xlsx", contentHash: "a".repeat(64),
  sheets: [{ name: "Sheet1", rowCount: 120, columnCount: 4 }, { name: "Sheet2", rowCount: 0, columnCount: 0 }] };

describe("Input Inspector metadata preflight", () => {
  it("inspects text and declared sources without implying the original file or old results are available", () => {
    const request = fixture();
    request.conversationContext = { previousAssistantMessage: "上次已经读取 input.xlsx 全部数据并运行 totals" };
    const before = structuredClone(request);
    const report = inspectHarnessInput(request);
    expect(report).toMatchObject({ basis: "entryMetadataOnly", instructionChars: request.instruction.length,
      workbook: { status: "notAttached" }, images: { count: 0 }, resources: { hasSelectedDataset: true } });
    expect(report.notebook).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("上次已经读取");
    expect(request).toEqual(before);
    // Avoid duplicate empty metadata in ordinary text turns with existing context.
    expect(inspectedModelContext(request)).toEqual({});
  });

  it("reports parsed XLSX dimensions and identity, not data values or a claimed scan result", () => {
    const report = inspectHarnessInput({ ...fixture(), rawWorkbookManifest: workbook });
    expect(report.workbook).toEqual({ status: "parsedAttachment", fileName: "input.xlsx", sha256: "a".repeat(64),
      sheetCount: 2, sheets: workbook.sheets, omittedSheets: 0 });
    expect(report.rule).toContain("不是数据内容、运行结果或授权");
    expect(inputInspectionMessage(report)).toContain("2 个工作表");
    expect(inputInspectionMessage(report)).not.toContain("input.xlsx");
    expect(JSON.stringify(report)).not.toContain("scanComplete");
  });

  it("indexes declared Notebook outputs and scoped resources without reading code, secrets, or live variables", () => {
    const request = notebookFixture();
    const report = inspectHarnessInput(request);
    expect(report).toMatchObject({ resources: { datasetCount: 1, aiConnectionCount: 1 }, notebook: {
      revision: 2, cellCount: 4, cellKinds: { data: 1, sql: 1, python: 1, text: 1 },
      declaredOutputCount: 3, declaredOutputs: ["source_table", "totals", "frame"],
      missingSourceCount: 0, unattachedFileCount: 1,
    } });
    const text = JSON.stringify(report);
    for (const omitted of ["SELECT", "pd.read_excel", "PRIVATE_NOTE", "不可用连接", "分析文档"]) expect(text).not.toContain(omitted);
    expect(inspectHarnessInput({ ...request, rawWorkbookManifest: workbook }).notebook?.unattachedFileCount).toBe(0);
  });

  it("reports missing declared sources and files instead of selecting an unrelated source or filesystem path", () => {
    const request = notebookFixture();
    request.notebookContext!.sourceIds = ["missing_source"];
    const report = inspectHarnessInput(request);
    expect(report.resources).toMatchObject({ datasetCount: 0, hasSelectedDataset: false });
    expect(report.notebook).toMatchObject({ missingSourceCount: 2, unattachedFileCount: 1 });
    expect(report.rule).toContain("目录、选中单元和内核状态未检查");
  });

  it("does not claim image understanding from metadata alone", () => {
    const request: HarnessRequest = { ...fixture(), imageAttachmentManifest: [
      { id: "img1", fileName: "untrusted.png", sha256: "b".repeat(64), byteLength: 24, mimeType: "image/png" },
      { id: "img2", fileName: "other.png", sha256: "c".repeat(64), byteLength: 24, mimeType: "image/png" },
    ] };
    const report = inspectHarnessInput(request);
    expect(report.images).toEqual({ count: 2, mediaTypes: ["image/png"] });
    expect(JSON.stringify(report)).not.toMatch(/visibleText|base64|untrusted.png/);
  });

  it("redacts a filename's directory and credential-shaped text without exposing them in trace", () => {
    const request = { ...fixture(), rawWorkbookManifest: { ...workbook, fileName: "C:\\private-dir\\sk-synthetic000000.xlsx" } };
    const report = inspectHarnessInput(request);
    expect(report.workbook).toMatchObject({ nameRedacted: true, sha256: workbook.contentHash });
    expect(JSON.stringify(report)).not.toMatch(/private-dir|sk-synthetic/);
    expect(inputInspectionMessage(report)).not.toContain("已脱敏");
  });

  it("bounds escaped metadata and preserves exact totals/omissions in normal and compact projections", () => {
    const request = notebookFixture();
    request.rawWorkbookManifest = { ...workbook, fileName: '"'.repeat(250) + ".xlsx",
      sheets: Array.from({ length: 10 }, (_, index) => ({ name: '"'.repeat(97) + index, rowCount: 50_000, columnCount: 100 })) };
    request.notebookContext!.document.cells = Array.from({ length: 30 }, (_, index) => ({
      id: `python_${index}`, kind: "python", title: "声明", inputCellIds: [], fileNames: ["unattached.xlsx"],
      outputName: "variable_" + "x".repeat(40) + index, code: "DO_NOT_RUN",
    }));
    const validated = harnessRequestSchema.parse(request);
    for (const compact of [false, true]) {
      const report = inspectHarnessInput(validated, compact);
      expect(JSON.stringify(report).length).toBeLessThanOrEqual(INPUT_INSPECTION_LIMITS[compact ? "compact" : "normal"]);
      expect(report.notebook!.declaredOutputs.length + report.notebook!.omittedOutputs).toBe(30);
      if (report.workbook.status !== "parsedAttachment") throw new Error("Attachment missing");
      expect(report.workbook.sheets.length + report.workbook.omittedSheets).toBe(10);
      expect(report.notebook?.unattachedFileCount).toBe(1);
      expect(JSON.stringify(report)).not.toContain("DO_NOT_RUN");
    }
  });

  it("rejects client-authored inspections and raw manifests instead of treating them as authority", () => {
    const { idempotencyKey, instruction, pageId, appSpec, recipes } = fixture();
    const request = { idempotencyKey, instruction, pageId, appSpec, recipes };
    expect(harnessPublicRequestSchema.safeParse(request).success).toBe(true);
    expect(harnessPublicRequestSchema.safeParse({ ...request, inputInspection: inspectHarnessInput(fixture()) }).success).toBe(false);
    expect(harnessPublicRequestSchema.safeParse({ ...request, rawWorkbookManifest: workbook }).success).toBe(false);
    expect(harnessPublicRequestSchema.safeParse({ ...request, inputInspectionApproved: true }).success).toBe(false);
  });

  it("keeps entry inspection separate from changing task results and uses compact follow-ups", () => {
    const request = notebookFixture();
    request.instruction = "查找 totals 变量，不修改或运行";
    expect(buildHarnessContextSelection(request, [], 1).context.inputInspection).toBeUndefined();
    expect(inspectedModelContext(request)).toEqual({});
    const first = buildHarnessContextSelection(request, [], 1, false, undefined, undefined, [], [], undefined, true);
    const second = buildHarnessContextSelection(request, [{ toolName: "cellSearch", toolCallId: "search", summary: "已检索", data: { runStatus: "notRun" } }], 2, false, undefined, undefined, [], [], undefined, true);
    expect(first.context.inputInspection).toMatchObject({ notebook: { declaredOutputs: ["source_table", "totals", "frame"] } });
    expect(second.context.inputInspection).toMatchObject({ basis: "entryMetadataOnly", notebook: { declaredOutputs: [], omittedOutputs: 3 } });
    expect(inspectedModelContext({ ...fixture(), rawWorkbookManifest: workbook }, false, true).inputInspection?.notebook).toBeUndefined();
    request.notebookContext!.document.cells = [];
    expect(inspectHarnessInput(request).notebook?.cellCount).toBe(0);
    expect(inspectedModelContext(request)).toEqual({}); // Empty document is already in the original context.
  });

  it("waits for the routing Agent before inspection, then supplies planning and execution without another model call", async () => {
    if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
    const request = { ...fixture(), rawWorkbookManifest: workbook };
    const trace: HarnessTraceEvent[] = [];
    const seen: string[] = [];
    const inspection = vi.spyOn(inputInspector, "inspectHarnessInput");
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    const client: HarnessModel = {
      classifyIntent: async (input) => {
        expect(inspection).not.toHaveBeenCalled();
        expect(trace.some((event) => event.message.includes("输入检查完成"))).toBe(false);
        expect(input).not.toHaveProperty("inputInspection");
        seen.push("router");
        return { decision: { mode: "readOnlyTask", requiresVisualVerification: false, wantsData: true, wantsEdsAnalysis: false,
          wantsRawWorkbook: false, wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false,
          wantsMcpTool: false, wantsNotebook: false, wantsAnalysisPlan: false, changeAction: "none", changeTarget: "none",
          componentKind: "none", chartType: "auto", skillIds: [], confidence: 1, rationale: "读取已导入数据的概况" },
        model: "inspector-test", usage, inputChars: 800 };
      },
      plan: async (input) => {
        expect(inspection).toHaveBeenCalled();
        expect(input.inputInspection?.workbook).toMatchObject({ status: "parsedAttachment", sheetCount: 2 });
        expect(input.evidence).toEqual([]); // Metadata must not satisfy the Verifier.
        seen.push("planner");
        return { plan: input.fallbackPlan, model: "inspector-test", usage, inputChars: 800 };
      },
      next: async (input) => {
        expect(input.context.inputInspection).toMatchObject({ basis: "entryMetadataOnly" });
        seen.push("executor");
        return { model: "inspector-test", usage, turn: input.iteration === 1
          ? { type: "callTool", name: "inspectDataset", arguments: { dataSourceId: "dataset_retail_orders" }, toolCallId: "inspect", message: "读取概况" }
          : { type: "complete", message: "已通过工具读取零售表概况，可以继续检查字段质量。" } };
      },
    };
    const factory = vi.fn(() => client);
    const task = await new HarnessRuntime().run(request, { createModelClient: factory,
      dataRuntime: demoFixtureResult.data.dataRuntime, onEvent: (event) => trace.push(event) });
    expect(task.state, task.error).toBe("completed");
    expect(seen).toEqual(["router", "planner", "executor", "executor"]);
    expect(task.counters).toMatchObject({ modelCallCount: 4, toolCallCount: 1 });
    expect(factory).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(task)).not.toContain("input.xlsx");
  });

  it.each(["你好", "你能做什么？", "先不分析了，谢谢"])("skips inspection for conversation %s even with files, Notebook cells and analysis history", async (instruction) => {
    if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
    const request = { ...notebookFixture(), instruction, rawWorkbookManifest: workbook,
      conversationContext: { previousInstruction: "分析这个工作簿", previousAssistantMessage: "已经生成了分析步骤" } };
    const inspection = vi.spyOn(inputInspector, "inspectHarnessInput");
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    const client: HarnessModel = {
      classifyIntent: async (input) => {
        expect(inspection).not.toHaveBeenCalled();
        expect(input).not.toHaveProperty("inputInspection");
        return { decision: { mode: "conversation", wantsData: false, wantsEdsAnalysis: false, wantsRawWorkbook: false,
          wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false, wantsNotebook: false,
          changeAction: "none", changeTarget: "none", componentKind: "none", chartType: "auto", skillIds: [],
          confidence: 1, rationale: "用户本轮只需要对话回复" }, model: "inspector-test", usage, inputChars: 500 };
      },
      plan: async (input) => {
        expect(input.inputInspection).toBeUndefined();
        return { plan: input.fallbackPlan, model: "inspector-test", usage, inputChars: 500 };
      },
      next: async (input) => {
        expect(input.context.inputInspection).toBeUndefined();
        return { model: "inspector-test", usage, turn: { type: "complete", message: "好的，可以继续讨论。" } };
      },
    };
    const task = await new HarnessRuntime().run(request, { modelClient: client, dataRuntime: demoFixtureResult.data.dataRuntime });
    expect(task.state, task.error).toBe("completed");
    expect(inspection).not.toHaveBeenCalled();
    expect(task.counters).toMatchObject({ modelCallCount: 3, toolCallCount: 0 });
    expect(task.trace?.some((event) => event.message.includes("跳过输入检查"))).toBe(true);
    expect(task.trace?.some((event) => event.message.includes("输入检查完成"))).toBe(false);
  });

  it("does not inspect when routing fails until the Agent chooses an allowed data tool", async () => {
    if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
    const inspection = vi.spyOn(inputInspector, "inspectHarnessInput");
    const request = { ...fixture(), instruction: "检查 retail_orders 数据集概况", rawWorkbookManifest: workbook };
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    const client: HarnessModel = {
      classifyIntent: async () => { expect(inspection).not.toHaveBeenCalled(); throw new Error("路由暂不可用"); },
      next: async (input) => {
        if (input.iteration === 1) {
          expect(inspection).not.toHaveBeenCalled();
          expect(input.context.inputInspection).toBeUndefined();
          return { model: "inspector-test", usage, turn: { type: "callTool", name: "inspectDataset",
            arguments: { dataSourceId: "dataset_retail_orders" }, toolCallId: "inspect", message: "检查数据源" } };
        }
        expect(inspection).toHaveBeenCalled();
        expect(input.context.inputInspection).toMatchObject({ workbook: { status: "parsedAttachment" } });
        return { model: "inspector-test", usage, turn: { type: "complete", message: "已读取数据源概况。" } };
      },
    };
    const task = await new HarnessRuntime().run(request, { modelClient: client, dataRuntime: demoFixtureResult.data.dataRuntime });
    expect(task.state, task.error).toBe("completed");
    expect(task.counters.toolCallCount).toBe(1);
  });

  it("keeps inspection off when a next-only Agent returns a conversational answer", async () => {
    if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
    const inspection = vi.spyOn(inputInspector, "inspectHarnessInput");
    const client: HarnessModel = { next: async (input) => {
      expect(input.context.inputInspection).toBeUndefined();
      return { model: "inspector-test", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
        turn: { type: "complete", message: "你好，我可以协助分析数据。" } };
    } };
    const task = await new HarnessRuntime().run({ ...fixture(), instruction: "你好", rawWorkbookManifest: workbook },
      { modelClient: client, dataRuntime: demoFixtureResult.data.dataRuntime });
    expect(task.state, task.error).toBe("completed");
    expect(inspection).not.toHaveBeenCalled();
    expect(task.counters.toolCallCount).toBe(0);
    expect(task.trace?.some((event) => event.type === "context_loaded" && event.message.includes("等待 Agent 判断"))).toBe(true);
    expect(task.trace?.some((event) => event.message.includes("输入检查完成"))).toBe(false);
  });

  it("inspects a Notebook follow-up after routing and then reads the referenced cell without running it", async () => {
    if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
    const inspection = vi.spyOn(inputInspector, "inspectHarnessInput");
    const request = { ...notebookFixture(), instruction: "那再查看 totals 变量的来源与依赖，不要修改或运行",
      conversationContext: { previousInstruction: "查看 Notebook 的输出变量", previousAssistantMessage: "其中有 totals。" } };
    const before = structuredClone(request.notebookContext);
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    const client: HarnessModel = {
      classifyIntent: async (input) => {
        expect(inspection).not.toHaveBeenCalled();
        expect(input.previousInstruction).toBe("查看 Notebook 的输出变量");
        return { decision: { mode: "readOnlyTask", wantsData: false, wantsNotebook: true,
          wantsEdsAnalysis: false, wantsRawWorkbook: false, wantsFields: false, wantsRecipe: false,
          wantsAppInspection: false, wantsExcel: false, changeAction: "none", changeTarget: "none",
          componentKind: "none", chartType: "auto", skillIds: [], confidence: 1, rationale: "查看 Notebook 变量来源" },
        model: "inspector-test", usage, inputChars: 800 };
      },
      next: async (input) => {
        expect(inspection).toHaveBeenCalled();
        expect(input.context.inputInspection).toMatchObject({ notebook: { cellCount: 4 } });
        return { model: "inspector-test", usage, turn: input.iteration === 1
          ? { type: "callTool", name: "cellSearch", arguments: { variable: "totals", view: "lineage" }, toolCallId: "find", message: "查看变量来源" }
          : { type: "complete", message: "totals 由 sql 单元声明，依赖 data 单元；本次只检查定义，没有运行。" } };
      },
    };
    const task = await new HarnessRuntime().run(request, { modelClient: client, dataRuntime: demoFixtureResult.data.dataRuntime });
    expect(task.state, task.error).toBe("completed");
    expect(task.counters).toMatchObject({ modelCallCount: 3, toolCallCount: 1 });
    expect(task.events.flatMap((event) => event.toolCall ? [event.toolCall.name] : [])).toEqual(["cellSearch", "cellSearch"]);
    expect(request.notebookContext).toEqual(before);
  });

  it("does not inspect or execute tools when cancelled during the routing Agent call", async () => {
    if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
    const inspection = vi.spyOn(inputInspector, "inspectHarnessInput");
    const controller = new AbortController();
    const next = vi.fn();
    const client: HarnessModel = { classifyIntent: async () => {
      expect(inspection).not.toHaveBeenCalled();
      controller.abort(new Error("用户取消"));
      throw new Error("用户取消");
    }, next };
    const task = await new HarnessRuntime().run({ ...fixture(), rawWorkbookManifest: workbook }, {
      modelClient: client, dataRuntime: demoFixtureResult.data.dataRuntime, signal: controller.signal,
    });
    expect(task.state).toBe("cancelled");
    expect(inspection).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(task.counters.toolCallCount).toBe(0);
  });

  it("does not accept entry metadata as proof that a data task has executed", async () => {
    if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
    const request = { ...fixture(), rawWorkbookManifest: workbook };
    const client: HarnessModel = { next: async () => ({ model: "inspector-test",
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      turn: { type: "complete", message: "输入元数据里有两个工作表，因此我已经执行了完整数据分析。" } }) };
    const task = await new HarnessRuntime().run(request, { modelClient: client, dataRuntime: demoFixtureResult.data.dataRuntime });
    expect(task.state).toBe("failed");
    expect(task.counters.toolCallCount).toBe(0);
    expect(task.verification?.status).not.toBe("passed");
  });
});
