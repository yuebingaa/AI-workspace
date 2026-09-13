import { describe, it, expect } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { DeepSeekHarness } from "./deepseek-harness";
import type { HarnessModel, HarnessRequest, HarnessSemanticIntentDecision } from "./contracts";
import { buildHarnessContextSelection, buildHarnessWorkingMemory, plannedHarnessToolSequence } from "./context-selector";
import { executeHarnessTool, harnessToolCatalog } from "./tool-registry";
import { HarnessConversationStore } from "./server/conversation-store";
import { createHarnessExecutionPlan } from "./execution-planner";
import { verifyHarnessTask } from "./task-verifier";

function context() {
  const { product, model, source, rows } = semanticFixture();
  const request: HarnessRequest = { idempotencyKey: "semantic_test_request", instruction: "按销售区域统计销售额", pageId: "page_home", dataSourceId: source.id,
    role: "editor", appSpec: product.appSpec, recipes: product.recipes, semanticModel: model };
  return { request, dataRuntime: { rowsByDataSourceId: { [source.id]: rows } }, now: () => Date.parse("2026-09-10T00:00:00.000Z"), id: () => "semantic_test" };
}
const intent: HarnessSemanticIntentDecision = { mode: "readOnlyTask", requiresVisualVerification: false, wantsData: true, wantsEdsAnalysis: false,
  wantsRawWorkbook: false, wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false,
  changeAction: "none", changeTarget: "none", componentKind: "none", chartType: "auto", skillIds: [], confidence: 1, rationale: "使用选定模型的业务指标" };

describe("Harness 语义模型链路", () => {
  it("动态传入模型定义，工具 Schema 仅暴露选定模型成员", () => {
    const input = context();
    const selection = buildHarnessContextSelection(input.request, [], 1, false, undefined, undefined, [], [], intent);
    expect(selection.toolNames).toEqual(["querySemanticModel"]);
    expect(selection.context.semanticModel).toMatchObject({ id: "sales_model", version: 1 });
    const tools = harnessToolCatalog({ names: selection.toolNames, request: input.request });
    expect(JSON.stringify(tools[0].parameters)).toContain("revenue");
    expect(JSON.stringify(tools[0].parameters)).not.toContain('"aggregation"');
    expect(harnessToolCatalog().some((tool) => tool.name === "querySemanticModel")).toBe(false);
  });
  it("查询生成可显示结果及可追溯证据，不修改正式页面", async () => {
    const input = context(), before = structuredClone(input.request.appSpec);
    const result = await executeHarnessTool("querySemanticModel", { dimensions: ["area"], measures: ["revenue"], limit: 1 }, input);
    expect(result.data).toMatchObject({ modelId: "sales_model", modelVersion: 1, rows: [{ area: "华东", revenue: 150 }], truncated: true });
    expect(result.tableArtifact).toMatchObject({ totalRowCount: 2, previewRowCount: 1, truncated: true });
    expect(input.request.appSpec).toEqual(before);
    const memory = buildHarnessWorkingMemory(input.request, [{ toolCallId: "query", toolName: "querySemanticModel", summary: result.summary, data: result.data }], 2, [], intent);
    expect(memory.pendingGoals).toEqual([]);
    expect(memory.confirmedDataSources).toEqual([{ id: input.request.dataSourceId }]);
    expect(memory.keyStatistics.some((item) => item.includes("销售分析 v1"))).toBe(true);
    const total = await executeHarnessTool("querySemanticModel", { dimensions: [], measures: ["revenue"], limit: 1 }, input);
    expect(total.tableArtifact).toMatchObject({ rows: [{ revenue: 230 }], truncated: false });
  });
  it("阻止数据源错配、待授权字段和模型未定义的指标", async () => {
    const input = context(), args = { dimensions: [], measures: ["revenue"], limit: 10 };
    await expect(executeHarnessTool("querySemanticModel", { ...args, measures: ["fake"] }, input)).rejects.toThrow("未定义指标");
    await expect(executeHarnessTool("querySemanticModel", args, { ...input, request: { ...input.request, dataSourceId: "other" } })).rejects.toThrow("匹配");
    input.request.appSpec.dataSources.find((source) => source.id === input.request.dataSourceId)!.aiAccessPolicy = "pending";
    await expect(executeHarnessTool("querySemanticModel", args, input)).rejects.toThrow("未授权");
  });
  it("AI 图表预览检查语义口径，合规预览仍须用户确认", async () => {
    const input = context(), before = structuredClone(input.request.appSpec);
    const root = input.request.appSpec.pages.find((page) => page.id === input.request.pageId)!.root;
    const args = { message: "生成销售额指标", operations: [{ type: "addNode", pageId: input.request.pageId, parentId: root.id,
      node: { id: "semantic_metric", type: "MetricCard", props: { label: "销售额", trend: "模型固定口径", binding: { dataSourceId: input.request.dataSourceId,
        field: "amount", aggregation: "sum", groupBy: null, filters: [], sort: [], limit: 1, format: { style: "number" } } } } }] };
    const preview = await executeHarnessTool("createChangeSetPreview", args, input);
    expect(preview.pendingChangeSet?.operations[0].type).toBe("addNode");
    expect(input.request.appSpec).toEqual(before);
    args.operations[0].node.props.binding.aggregation = "max";
    await expect(executeHarnessTool("createChangeSetPreview", args, input)).rejects.toThrow("口径校验失败");
  });
  it.each(["masked", "exclude-sensitive-samples"] as const)("语义别名不会绕过 %s 敏感字段保护，计数和非敏感指标仍可计算", async (policy) => {
    const input = context(), model = input.request.semanticModel!, source = input.request.appSpec.dataSources.find((source) => source.id === model.sourceDatasetId)!;
    source.aiAccessPolicy = policy; source.fields[0].sensitiveCategories = ["name"];
    const rows = input.dataRuntime.rowsByDataSourceId[source.id];
    rows[0].region = "隐私姓名甲"; rows[1].region = "隐私姓名甲"; rows[2].region = "隐私姓名乙";
    model.measures.push({ key: "first_name", label: "姓名最小值", field: "region", aggregation: "min", description: "不应暴露" },
      { key: "people", label: "人数", field: "region", aggregation: "countDistinct", description: "仅返回计数" });
    const result = await executeHarnessTool("querySemanticModel", { dimensions: ["area"], measures: ["revenue", "first_name", "people"], limit: 10 }, input);
    expect(JSON.stringify(result)).not.toContain("隐私姓名");
    expect(result.tableArtifact?.rows[0]).toMatchObject({ revenue: 150, first_name: null, people: 1 });
    expect(result.data).toMatchObject({ redactedFields: ["area", "first_name"] });
    expect(rows[0].region).toBe("隐私姓名甲");
  });
  it("模型版本进入会话选择，不将旧版本当成本轮已验证事实", () => {
    const input = context(); input.request.conversation_id = "semantic_conversation";
    const store = new HarnessConversationStore();
    const session = store.begin(input.request, "owner");
    expect(session.context?.selectedContext).toContain("sales_model@v1"); session.release();
    const next = store.begin({ ...input.request, semanticModel: { ...input.request.semanticModel!, version: 2 } }, "owner");
    expect(next.context?.selectedContext).toContain("sales_model@v2");
    expect(next.context?.selectedContext).not.toContain("sales_model@v1"); next.release();
  });
  it("Verifier 不接受没有对应模型版本查询证据的完成声明", () => {
    const input = context();
    const result = verifyHarnessTask({ request: input.request, plan: createHarnessExecutionPlan(input.request, intent), observations: [], attempt: 1,
      candidate: { outcome: "completed", message: "销售额是 230。", formalAppSpecUnchanged: true }, semanticIntent: intent });
    expect(result.status).toBe("replan"); expect(result.checks.find((check) => check.id === "semantic_model")?.status).toBe("failed");
  });
  it("完整 Harness 使用模型定义、真实本地计算和 Verifier 后完成（不调用外部模型）", async () => {
    const input = context();
    const model: HarnessModel = {
      classifyIntent: async (input) => {
        expect(input.semanticModel?.name).toBe("销售分析");
        return { decision: intent, model: "semantic-mock", inputChars: 100, usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 } };
      },
      next: async ({ iteration }) => ({ model: "semantic-mock", usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
        turn: iteration === 1 ? { type: "callTool", message: "按模型计算销售额", toolCallId: "semantic_query", name: "querySemanticModel", arguments: { dimensions: ["area"], measures: ["revenue"], limit: 100 } }
          : { type: "complete", message: "按销售分析 v1 的金额求和口径，华东销售额 150，华南 80；华东更高。" } }),
    };
    const task = await new DeepSeekHarness().run(input.request, { dataRuntime: input.dataRuntime, modelClient: model });
    expect(task.state).toBe("completed"); expect(task.verification?.status).toBe("passed");
    expect(task.tableArtifact?.rows).toEqual([{ area: "华东", revenue: 150 }, { area: "华南", revenue: 80 }]);
    expect(task.evidence?.records.some((record) => record.source === "querySemanticModel")).toBe(true);
  });
  it("数据无关任务不强制查询；导出暂不冒充语义查询结果", () => {
    const { request } = context();
    expect(plannedHarnessToolSequence(request, { ...intent, mode: "conversation", wantsData: false })).toEqual([]);
    const selection = buildHarnessContextSelection(request, [], 1, false, undefined, undefined, [], [], { ...intent, wantsExcel: true });
    expect(selection.blockingReason).toContain("暂不支持直接导出");
  });
});
