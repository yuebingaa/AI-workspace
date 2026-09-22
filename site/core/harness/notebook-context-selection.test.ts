import { afterEach, describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { notebookContextSelectionMetadata } from "@/core/notebook/context-selection";
import { DeepSeekHarnessModel } from "@/core/ai/server/deepseek-harness-model";
import { harnessPublicRequestSchema, harnessRequestSchema, type HarnessModel, type HarnessRequest, type HarnessSemanticIntentDecision } from "./contracts";
import { buildHarnessContextSelection, plannedHarnessToolSequence } from "./context-selector";
import { isNotebookInspection } from "./notebook-cell-tools";
import { HarnessRuntime } from "./runtime";
import { executeHarnessTool, type HarnessToolContext } from "./tool-registry";
import * as inputInspector from "./input-inspector";

afterEach(() => vi.restoreAllMocks());
const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
function fixture(): HarnessRequest {
  const { product } = semanticFixture();
  return { idempotencyKey: `selected_${crypto.randomUUID()}`, instruction: "帮我看看这些", role: "editor", pageId: "page_home",
    appSpec: product.appSpec, recipes: [], notebookContext: { sourceIds: [], selectedCellIds: ["threshold", "query"],
      document: { name: "选择检查", revision: 3, cells: [
        { id: "threshold", kind: "parameter", title: "阈值", outputName: "limits", parameter: { type: "text", value: "PRIVATE_PARAMETER_VALUE" } },
        { id: "query", kind: "sql", title: "SQL", outputName: "totals", inputCellIds: ["threshold"], sql: "SELECT 'PRIVATE_SQL_SOURCE' AS label FROM limits" },
      ] } } };
}
function intent(conversation = false): HarnessSemanticIntentDecision {
  return { mode: conversation ? "conversation" : "readOnlyTask", wantsData: !conversation, wantsNotebook: !conversation,
    wantsEdsAnalysis: false, wantsRawWorkbook: false, wantsFields: false, wantsRecipe: false, wantsAppInspection: false,
    wantsExcel: false, changeAction: "none", changeTarget: "none", componentKind: "none", chartType: "auto", skillIds: [], confidence: 1, rationale: "合成选择验收" };
}
function context(request: HarnessRequest): HarnessToolContext {
  return { request, dataRuntime: { rowsByDataSourceId: {} }, now: Date.now, id: () => crypto.randomUUID(),
    notebookCellSession: { document: structuredClone(request.notebookContext!.document), editVersion: 0 } };
}

describe("Notebook 选择请求契约与模型上下文", () => {
  it("旧请求及空选择兼容；选择重新映射本次提交定义，不信任附带描述", () => {
    const request = fixture(); const old = structuredClone(request); delete old.notebookContext!.selectedCellIds;
    expect(harnessRequestSchema.parse(old).notebookContext).toEqual(old.notebookContext);
    expect(harnessRequestSchema.parse(request).notebookContext).toEqual(request.notebookContext);
    expect(harnessRequestSchema.safeParse({ ...request, notebookContext: { ...request.notebookContext, selectedCellIds: [] } }).success).toBe(true);
  });
  it.each([
    { selectedCellIds: ["missing"] }, { selectedCellIds: ["threshold", "threshold"] },
    { selectedCellIds: Array.from({ length: 11 }, () => "threshold") }, { selectedCellIds: ["../../outside"] },
    { selectedCellIds: ["threshold"], selectedResults: { rows: [{ value: 999 }] } },
    { selectedCellIds: [{ id: "threshold", value: "fake" }] },
  ])("严格拒绝非法/旧 ID、重复及客户端假结果：%j", (selection) => {
    const request: Partial<HarnessRequest> = fixture(); delete request.role;
    expect(harnessPublicRequestSchema.safeParse({ ...request, notebookContext: { ...request.notebookContext, ...selection } }).success).toBe(false);
  });
  it.each([false, true])("普通与压缩模型上下文只带声明焦点，压缩保留全部 ID：%s", (compacted) => {
    const request = fixture(); const result = buildHarnessContextSelection(request, [], 1, compacted);
    expect(result.toolNames).toEqual(["cellSearch"]);
    expect(result.context.notebook).toMatchObject(compacted
      ? { selection: { status: "declared", cellIds: ["threshold", "query"], metadataOmitted: true } }
      : { selection: notebookContextSelectionMetadata(request.notebookContext!.document, ["threshold", "query"]) });
    const serialized = JSON.stringify(result.context);
    expect(serialized).not.toContain("PRIVATE_PARAMETER_VALUE"); expect(serialized).not.toContain("PRIVATE_SQL_SOURCE");
    expect(serialized).toContain("不是执行结果或权限");
    expect(inputInspector.inspectHarnessInput(request, compacted).notebook).toMatchObject({ cellCount: 2, selectedCellCount: 2 });
  });
  it("无选择与空选择的现有上下文完全一致，不增加占位字段", () => {
    const without = fixture(); delete without.notebookContext!.selectedCellIds;
    // Original Notebook cell route: empty focus must not alter its projection.
    without.instruction = "解释参数单元";
    const empty = { ...without, notebookContext: { ...without.notebookContext!, selectedCellIds: [] } };
    for (const compacted of [false, true]) {
      expect(buildHarnessContextSelection(empty, [], 1, compacted)).toEqual(buildHarnessContextSelection(without, [], 1, compacted));
      expect(inputInspector.inspectHarnessInput(empty, compacted)).toEqual(inputInspector.inspectHarnessInput(without, compacted));
    }
  });
  it.each(["解释这些", "帮我看看这些", "这些是什么", "请说明含义", "帮我说明一下这些", "看一下它", "describe these"])("泛指 %s 仅开放检索", (instruction) => {
    const request = { ...fixture(), instruction };
    expect(isNotebookInspection(request)).toBe(true); expect(plannedHarnessToolSequence(request)).toEqual(["cellSearch"]);
  });
  it.each(["查看后修改参数", "看看这些并运行", "新增参数", "修改为 20", "根据所选参数生成分析说明"])("明确变更 %s 仍走原试跑/提交链", (instruction) => {
    expect(plannedHarnessToolSequence({ ...fixture(), instruction })).toEqual(["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"]);
  });
  it("DeepSeek 路由适配携带同一声明焦点，旧输入不增加新字段", async () => {
    const request = fixture();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: "deepseek-v4-flash",
      choices: [{ message: { content: JSON.stringify(intent()) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
    { headers: { "content-type": "application/json" } }));
    const model = new DeepSeekHarnessModel({ apiKey: "synthetic-fixture", model: "deepseek-v4-flash", fetchImpl });
    const base = { instruction: request.instruction, hasNotebookContext: true, page: { id: "page_home", title: "合成", componentTypes: [] },
      dataSources: [], hasEdsWorkspace: false, hasRawWorkbookAccess: false, hasVisualVerification: false, role: request.role, signal: new AbortController().signal };
    await model.classifyIntent(base);
    const selection = notebookContextSelectionMetadata(request.notebookContext!.document, ["threshold"]);
    await model.classifyIntent({ ...base, notebookSelection: selection });
    const payloads = fetchImpl.mock.calls.map((call) => JSON.parse(String(call[1]!.body)) as { messages: Array<{ content: string }> });
    expect(payloads[0].messages.map((item) => item.content).join("\n")).not.toContain("notebookSelection");
    const selectedPayload = payloads[1].messages.map((item) => item.content).join("\n");
    expect(selectedPayload).toContain('"notebookSelection"'); expect(selectedPayload).toContain('"threshold"');
    expect(selectedPayload).not.toContain("PRIVATE_PARAMETER_VALUE"); expect(selectedPayload).not.toContain("PRIVATE_SQL_SOURCE");
  });
});

describe("固定模型与真实 Harness / CellSearch", () => {
  it.each(["editor", "viewer"] as const)("%s 只读请求真实检索后回答，不执行、不建草稿、不改变原定义", async (role) => {
    const request = { ...fixture(), role }, before = structuredClone(request), runner = vi.fn();
    const inspection = vi.spyOn(inputInspector, "inspectHarnessInput");
    const model: HarnessModel = {
      classifyIntent: async (input) => {
        expect(inspection).not.toHaveBeenCalled();
        expect(input.notebookSelection).toEqual(notebookContextSelectionMetadata(request.notebookContext!.document, ["threshold", "query"]));
        expect(JSON.stringify(input)).not.toContain("PRIVATE_PARAMETER_VALUE");
        return { decision: intent(), model: "synthetic-focus", inputChars: 100, usage };
      },
      plan: async (input) => ({ plan: input.fallbackPlan, model: "synthetic-focus", inputChars: 100, usage }),
      next: async (input) => {
        expect(input.tools.map((tool) => tool.name)).toEqual(["cellSearch"]);
        expect(input.estimatedInputChars).toBeLessThanOrEqual(10_000);
        if (input.iteration === 2) expect(JSON.stringify(input.context.latestObservation)).toContain("PRIVATE_PARAMETER_VALUE");
        return { model: "synthetic-focus", usage, turn: input.iteration > 2
          ? { type: "complete", message: "已读取所选参数与 SQL 的当前定义。本次未运行，不代表存在计算结果。" }
          : { type: "callTool", name: "cellSearch", arguments: { cellId: input.iteration === 1 ? "threshold" : "query", view: "source" }, toolCallId: `focus_${input.iteration}`, message: "读取所选定义" } };
      },
    };
    const task = await new HarnessRuntime().run(request, { modelClient: model, dataRuntime: { rowsByDataSourceId: {} }, notebookRunner: runner,
      contextBudget: { maxRequestInputChars: 10_000 } });
    expect(task.state, task.error).toBe("completed"); expect(task.verification).toMatchObject({ status: "passed" });
    expect(task.counters.toolCallCount).toBe(2); expect(task.notebookArtifact).toBeUndefined(); expect(task.pendingChangeSet).toBeUndefined();
    expect(runner).not.toHaveBeenCalled(); expect(request).toEqual(before); expect(inspection).toHaveBeenCalled();
  });
  it.each(["你好", "你能做什么？", "先不分析了，谢谢"])("普通聊天 %s 保留选择但不启用输入检查或工具", async (instruction) => {
    const request = { ...fixture(), instruction }, inspection = vi.spyOn(inputInspector, "inspectHarnessInput");
    const task = await new HarnessRuntime().run(request, { dataRuntime: { rowsByDataSourceId: {} }, modelClient: {
      classifyIntent: async () => ({ decision: intent(true), model: "synthetic-focus", inputChars: 100, usage }),
      plan: async ({ fallbackPlan }) => ({ plan: fallbackPlan, model: "synthetic-focus", inputChars: 100, usage }),
      next: async ({ context: modelContext }) => {
        expect(modelContext.inputInspection).toBeUndefined();
        return { model: "synthetic-focus", usage, turn: { type: "complete", message: "好的，可以继续讨论。" } };
      },
    } });
    expect(task.state, task.error).toBe("completed"); expect(task.counters).toMatchObject({ modelCallCount: 3, toolCallCount: 0 });
    expect(inspection).not.toHaveBeenCalled(); expect(task.notebookArtifact).toBeUndefined();
  });
  it("无 classifier 的问候不因保留焦点生成 Notebook 计划", async () => {
    const request = { ...fixture(), instruction: "你好" };
    expect(plannedHarnessToolSequence(request)).toEqual([]);
    const task = await new HarnessRuntime().run(request, { dataRuntime: { rowsByDataSourceId: {} }, modelClient: {
      next: async () => ({ model: "synthetic-focus", usage, turn: { type: "complete", message: "你好。" } }),
    } });
    expect(task.state, task.error).toBe("completed"); expect(task.counters.toolCallCount).toBe(0);
  });
  it("选择不是结果：上轮历史声称完成仍返回本次 notRun，未知 ID 拒绝", async () => {
    const request = fixture(); request.conversationContext = { previousAssistantMessage: "totals 已运行，答案为 999" };
    const toolContext = context(request);
    const result = await executeHarnessTool("cellSearch", { cellId: "query", view: "output" }, toolContext);
    expect(result.data).toMatchObject({ output: { availability: "notRun" } });
    expect(JSON.stringify(result.data)).not.toContain("999");
    await expect(executeHarnessTool("cellSearch", { cellId: "other_notebook_cell", view: "source" }, toolContext)).rejects.toThrow("找不到");
  });
  it("选择不授权执行或跳过真实检索直接完成", async () => {
    const request = fixture(), runner = vi.fn();
    const task = await new HarnessRuntime().run(request, { dataRuntime: { rowsByDataSourceId: {} }, notebookRunner: runner, modelClient: {
      next: async () => ({ model: "synthetic-focus", usage, turn: { type: "complete", message: "这些已经运行成功。" } }),
    } });
    expect(task.state).toBe("failed"); expect(task.terminationCode).toBe("protocolViolation"); expect(runner).not.toHaveBeenCalled();
  });
  it("已取消请求与过期编辑版本不能借选中 ID 读取定义", async () => {
    const toolContext = context(fixture());
    await expect(executeHarnessTool("cellSearch", { cellId: "threshold", view: "source", editVersion: 1 }, toolContext)).rejects.toThrow("版本");
    toolContext.signal = AbortSignal.abort();
    await expect(executeHarnessTool("cellSearch", { cellId: "threshold", view: "source" }, toolContext)).rejects.toThrow();
  });
  it("检索请求中模型擅自选择运行工具会失败，不因选中有输出的单元放行", async () => {
    const runner = vi.fn();
    const task = await new HarnessRuntime().run(fixture(), { dataRuntime: { rowsByDataSourceId: {} }, notebookRunner: runner,
      modelClient: { next: async () => ({ model: "synthetic-illegal-action", usage,
        turn: { type: "callTool", name: "runNotebookCells", arguments: { editVersion: 0 }, toolCallId: "forbidden_run", message: "不应运行" } }) },
    });
    expect(task.state).toBe("failed"); expect(task.counters.toolCallCount).toBe(0); expect(runner).not.toHaveBeenCalled();
  });
});
