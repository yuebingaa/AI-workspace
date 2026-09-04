import { describe, expect, it, vi } from "vitest";
import { applyChangeSet, createExecutionState, previewChangeSet } from "@/core/changesets";
import type { HarnessModel, HarnessModelInput, HarnessModelResult, HarnessModelTurn, HarnessRequest, HarnessTaskSummary } from "@/core/harness";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { harnessExcelExporter } from "@/core/exports/server/harness-excel-exporter";
import { excelExportStore } from "@/core/exports/server/excel-export-store";
import { analyzeEdsWorkbook, createEdsWorkspaceRuntime, createEdsWorkspaceSnapshotForResults, installEdsWorkspaceInDataProduct, type EdsAnalysisResponse } from "@/core/eds";
import { createSyntheticEdsFixture } from "@/fixtures/eds-synthetic";
import { redactedCompleteActionFailureFixture } from "./fixtures/redacted-complete-action";
import {
  DeepSeekHarness,
  DeepSeekHarnessModel,
  HARNESS_HARD_BOUNDS,
  HarnessIdempotencyCapacityError,
  HarnessIdempotencyConflictError,
  HarnessIdempotencyStore,
  MAX_HARNESS_COMPLETION_TOKENS_PER_CALL,
  appendHarnessEvent,
  createHarnessTask,
  harnessTaskSummarySchema,
  harnessToolCatalog,
  recoverHarnessTasksAfterRefresh,
  settleHarnessConfirmation,
} from "./index";

class ScriptedModel implements HarnessModel {
  calls = 0;
  inputs: HarnessModelInput[] = [];
  constructor(
    private readonly turns: HarnessModelTurn[],
    private readonly usages: Array<{ promptTokens: number; completionTokens: number; totalTokens: number }> = [],
  ) {}
  async next(input: HarnessModelInput): Promise<HarnessModelResult> {
    this.inputs.push(input);
    const turn = this.turns[this.calls++];
    if (!turn) throw new Error("mock 没有更多动作");
    return { turn, model: "mock-deepseek", usage: this.usages[this.calls - 1] ?? { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
}

class DelayedScriptedModel implements HarnessModel {
  calls = 0;
  constructor(private readonly turns: HarnessModelTurn[], private readonly delaysMs: number[]) {}
  async next(input: HarnessModelInput): Promise<HarnessModelResult> {
    const turn = this.turns[this.calls];
    const delayMs = this.delaysMs[this.calls] ?? 0;
    this.calls += 1;
    if (!turn) throw new Error("延迟 mock 没有更多动作");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      input.signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("延迟 mock 已取消"));
      }, { once: true });
    });
    return { turn, model: "delayed-mock", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
  }
}

function fixtures() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data);
}

function request(idempotencyKey = "request_harness_test", instruction = "检查零售数据并给出结论"): HarnessRequest {
  const { dataProduct } = fixtures();
  return {
    idempotencyKey,
    instruction,
    pageId: "page_home",
    appSpec: dataProduct.appSpec,
    recipes: dataProduct.recipes,
    role: "editor",
  };
}

function tool(name: string, args: Record<string, unknown>, id: string): HarnessModelTurn {
  return { type: "callTool", message: `调用 ${name}`, toolCallId: id, name, arguments: args };
}

const complete = (message: string): HarnessModelTurn => ({ type: "complete", message });
const blocked = (message: string, missingRequirements: string[]): HarnessModelTurn => ({
  type: "blocked",
  message,
  missingRequirements,
});

function customerAnalysisRequest(idempotencyKey = "request_customer_analysis"): HarnessRequest {
  return {
    ...request(idempotencyKey, "检查销售数据，找出异常订单，并生成复购率指标。"),
    pageId: "page_customers",
  };
}

function edsAnalysisRequest(instruction = "请读取全部 EDS 日期和班次的派生汇总，对比异常次数、异常时长、命中率、主要异常线体和异常类别，指出跨班次差异、优先排查项与可执行改善建议。引用具体数值，不要修改页面，不要创建 ChangeSet。"): {
  request: HarnessRequest;
  dataRuntime: ReturnType<typeof createEdsWorkspaceRuntime>;
} {
  const data = fixtures();
  const analysis = analyzeEdsWorkbook(createSyntheticEdsFixture().sourceSheets);
  const white: EdsAnalysisResponse = {
    ...analysis,
    summary: { ...analysis.summary, date: "2026-09-03", shift: "白班" },
    exportArtifact: {
      id: "eds-ai-private-artifact",
      status: "ready",
      fileName: "private-input.xlsx",
      downloadUrl: "/api/exports/private-token",
      rowCount: 1,
      fieldCount: 1,
      sizeBytes: 1,
      createdAt: "2026-09-04T06:00:00.000Z",
      expiresAt: "2026-09-04T06:10:00.000Z",
    },
    warnings: [],
  };
  const night = structuredClone(white);
  night.summary.shift = "夜班";
  const edsWorkspace = createEdsWorkspaceSnapshotForResults([white, night], 0);
  const product = installEdsWorkspaceInDataProduct(data.dataProduct, edsWorkspace);
  return {
    request: {
      idempotencyKey: "request_eds_ai_analysis",
      instruction,
      pageId: "page_eds_analysis",
      dataSourceId: "dataset_eds_overview",
      appSpec: product.appSpec,
      recipes: product.recipes,
      edsWorkspace,
      role: "editor",
    } satisfies HarnessRequest,
    dataRuntime: createEdsWorkspaceRuntime(edsWorkspace),
  };
}

function repurchaseMetricDraft() {
  return {
    message: "已检查异常订单并预览复购率配方，建议新增复购率指标。",
    operations: [{
      type: "addNode" as const,
      pageId: "page_customers",
      parentId: "page_customers_metrics",
      node: {
        id: "metric_customer_repurchase",
        type: "MetricCard" as const,
        props: {
          label: "复购率",
          trend: "基于本地配方预览",
          isNew: true,
          binding: {
            dataSourceId: "dataset_retail_orders",
            field: "repurchase_rate",
            aggregation: "average" as const,
            groupBy: null,
            filters: [],
            sort: [],
            limit: 1,
            format: { style: "percent" as const, decimals: 1 },
          },
        },
      },
    }],
  };
}

describe("DeepSeekHarness 服务端状态机", () => {
  it("低成本数据可用性检查只调用 inspectDataset，并在第二轮完成", async () => {
    const data = fixtures();
    const input = request(
      "request_low_cost_dataset_check",
      "检查 retail_orders 数据集是否可用，返回行数、列数和字段摘要。不要修改页面，不要创建 ChangeSet。",
    );
    const formal = structuredClone(input.appSpec);
    const model = new ScriptedModel([
      tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_low_cost_dataset"),
      complete("retail_orders 可用，共 48 行、14 列，字段结构正常。"),
    ]);

    const task = await new DeepSeekHarness().run(input, {
      dataRuntime: data.dataRuntime,
      modelClient: model,
      bounds: { maxModelCalls: 2, maxToolCalls: 2 },
    });

    expect(task.state).toBe("completed");
    expect(task.counters).toEqual({ loopCount: 2, modelCallCount: 2, toolCallCount: 1 });
    expect(model.inputs[0].tools.map((item) => item.name)).toEqual(["inspectDataset"]);
    expect(model.inputs[1].tools).toEqual([]);
    expect(task.events.some((event) => event.toolCall?.name === "createChangeSetPreview")).toBe(false);
    expect(task.pendingChangeSet).toBeUndefined();
    expect(task.contextUsage?.complexity).toBe("simpleReadOnly");
    expect(task.contextUsage?.limits).toMatchObject({ maxTotalInputChars: 12_000, maxTotalPromptTokens: 3_500 });
    expect(input.appSpec).toEqual(formal);
  });

  it("EDS AI 分析先读取全部班次派生汇总，再生成只读诊断结论", async () => {
    const input = edsAnalysisRequest();
    const formal = structuredClone(input.request.appSpec);
    const model = new ScriptedModel([
      tool("analyzeEdsReports", {}, "call_eds_reports"),
      complete("夜班异常次数更高，应优先排查主要线体和累计时长最高的异常类别。"),
    ]);

    const task = await new DeepSeekHarness().run(input.request, {
      dataRuntime: input.dataRuntime,
      modelClient: model,
      bounds: { maxModelCalls: 2, maxToolCalls: 2 },
    });
    const followUp = JSON.stringify(model.inputs[1]);

    expect(task.state).toBe("completed");
    expect(task.resultMessage).toContain("优先排查");
    expect(model.inputs[0].tools.map((item) => item.name)).toEqual(["analyzeEdsReports"]);
    expect(model.inputs[1].tools).toEqual([]);
    expect(followUp).toContain("白班");
    expect(followUp).toContain("夜班");
    expect(followUp).toContain("deltaFromFirst");
    expect(followUp).not.toContain("private-input.xlsx");
    expect(followUp).not.toContain("/api/exports/private-token");
    expect(task.pendingChangeSet).toBeUndefined();
    expect(input.request.appSpec).toEqual(formal);
  });

  it("EDS 页面中的自然语言‘分析一下数据’自动使用专用派生汇总工具", async () => {
    const input = edsAnalysisRequest("分析一下数据");
    const model = new ScriptedModel([
      tool("analyzeEdsReports", {}, "call_eds_natural_language"),
      complete("夜班异常 173 次，高于白班 162 次，建议优先检查主要异常线体。"),
    ]);

    const task = await new DeepSeekHarness().run(input.request, {
      dataRuntime: input.dataRuntime,
      modelClient: model,
      bounds: { maxModelCalls: 2, maxToolCalls: 2 },
    });

    expect(model.inputs[0].tools.map((item) => item.name)).toEqual(["analyzeEdsReports"]);
    expect(task).toMatchObject({
      state: "completed",
      counters: { loopCount: 2, modelCallCount: 2, toolCallCount: 1 },
    });
    expect(task.resultMessage).toContain("夜班异常 173 次");
  });

  it("EDS 页面中的自然追问继续读取派生汇总，而闲聊短句正常完成对话", async () => {
    const followUp = edsAnalysisRequest("详细一点");
    const followUpModel = new ScriptedModel([
      tool("analyzeEdsReports", {}, "call_eds_follow_up"),
      complete("夜班异常时长较白班增加 20.22 分钟，建议先检查 A5FSL05。"),
    ]);
    const followUpTask = await new DeepSeekHarness().run(followUp.request, {
      dataRuntime: followUp.dataRuntime,
      modelClient: followUpModel,
      bounds: { maxModelCalls: 2, maxToolCalls: 2 },
    });

    const chat = edsAnalysisRequest("额");
    chat.request.conversationContext = {
      previousInstruction: "分析一下数据",
      previousAssistantMessage: "夜班异常 173 次，高于白班 162 次。",
    };
    const chatModel = new ScriptedModel([complete("我在。你可以继续问夜班为什么更高，或让我展开具体线体。")]);
    const chatTask = await new DeepSeekHarness().run(chat.request, {
      dataRuntime: chat.dataRuntime,
      modelClient: chatModel,
      bounds: { maxModelCalls: 2, maxToolCalls: 2 },
    });

    expect(followUpModel.inputs[0].tools.map((item) => item.name)).toEqual(["analyzeEdsReports"]);
    expect(followUpTask.state).toBe("completed");
    expect(chatModel.inputs[0].tools).toEqual([]);
    expect(chatModel.inputs[0].context).toMatchObject({
      interactionMode: "conversation",
      recentConversation: chat.request.conversationContext,
    });
    expect(chatTask).toMatchObject({ state: "completed", resultMessage: expect.stringContaining("我在") });
  });

  it("模型仍返回内部缺失字段时转换为用户可理解的提示", async () => {
    const chat = edsAnalysisRequest("额");
    const model = new ScriptedModel([blocked("受阻", ["goalSummary"])]);
    const task = await new DeepSeekHarness().run(chat.request, {
      dataRuntime: chat.dataRuntime,
      modelClient: model,
      bounds: { maxModelCalls: 1, maxToolCalls: 1 },
    });

    expect(task.state).toBe("blocked");
    expect(task.resultMessage).toContain("请具体说明想了解的数据、现象或业务问题");
    expect(task.resultMessage).not.toContain("goalSummary");
  });

  it("每次模型调用前同步重验授权，撤回后不会启动下一次调用", async () => {
    const data = fixtures();
    const model = new ScriptedModel([
      tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_before_revoke"),
      complete("不应执行到这里。"),
    ]);
    let authorizationChecks = 0;
    const task = await new DeepSeekHarness().run(request(
      "request_authorization_recheck",
      "检查 retail_orders 数据集是否可用，返回行数和列数。不要修改页面。",
    ), {
      dataRuntime: data.dataRuntime,
      modelClient: model,
      authorizeModelCall: () => {
        authorizationChecks += 1;
        if (authorizationChecks === 2) throw new Error("数据集授权已撤回");
      },
    });

    expect(task.state).toBe("failed");
    expect(task.error).toContain("授权已撤回");
    expect(authorizationChecks).toBe(2);
    expect(model.calls).toBe(1);
  });

  it("刷新恢复时将历史零工具数据任务从 completed 修正为 blocked", () => {
    let sequence = 0;
    const clock = { now: () => new Date("2026-09-01T10:00:00.000Z"), id: () => `recovery_${++sequence}` };
    let task = createHarnessTask("request_legacy_no_tools", "检查销售数据并找出异常订单", "page_customers", "editor", clock);
    task = appendHarnessEvent(task, {
      type: "state",
      state: "completed",
      message: "当前没有可用的数据工具。",
    }, clock, { counters: { loopCount: 1, modelCallCount: 1, toolCallCount: 0 } });

    const [recovered] = recoverHarnessTasksAfterRefresh([task], clock);
    expect(recovered.state).toBe("blocked");
    expect(recovered.terminationCode).toBe("missingContext");
    expect(recovered.error).toContain("缺少必要的数据工具执行记录");
  });

  it("销售异常与复购任务依次检查数据和字段，并只生成待确认指标 ChangeSet", async () => {
    const data = fixtures();
    const formal = structuredClone(data.dataProduct.appSpec);
    const model = new ScriptedModel([
      tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_sales_dataset"),
      tool("inspectFields", {
        dataSourceId: "dataset_retail_orders",
        fields: ["order_id", "customer_id", "anomaly_count", "repurchase_rate"],
      }, "call_sales_fields"),
      tool("previewDataRecipe", { recipeId: "recipe_east_anomalies" }, "call_repurchase_recipe"),
      tool("createChangeSetPreview", repurchaseMetricDraft(), "call_repurchase_change"),
    ]);

    const task = await new DeepSeekHarness().run(customerAnalysisRequest(), {
      dataRuntime: data.dataRuntime,
      modelClient: model,
    });

    expect(task.error).toBeUndefined();
    expect(task.state).toBe("awaitingConfirmation");
    expect(task.counters).toEqual({ loopCount: 4, modelCallCount: 4, toolCallCount: 4 });
    expect(model.inputs[0].tools.map((item) => item.name)).toEqual(["inspectDataset"]);
    expect(task.events.filter((event) => event.type === "toolCall").map((event) => event.toolCall?.name))
      .toEqual(["inspectDataset", "inspectFields", "previewDataRecipe", "createChangeSetPreview"]);
    expect(task.pendingChangeSet?.operations).toEqual([expect.objectContaining({
      type: "addNode",
      pageId: "page_customers",
      parentId: "page_customers_metrics",
      node: expect.objectContaining({ type: "MetricCard", props: expect.objectContaining({ label: "复购率" }) }),
    })]);
    expect(data.dataProduct.appSpec).toEqual(formal);
    expect(task.contextUsage?.totalInputChars).toBeLessThanOrEqual(32_000);
    expect(task.contextUsage?.totalPromptTokens).toBe(4);
    expect(task.contextUsage?.requests.every((entry) => entry.promptTokens === 1)).toBe(true);
  });

  it("复杂分析在合理预算内完成配方导出并保持正式 AppSpec 不变", async () => {
    excelExportStore.clear();
    const data = fixtures();
    const input = {
      ...request("request_complex_excel", "整理华东异常订单，创建复购分析，并提供 Excel 下载。"),
      pageId: "page_customers",
    };
    const formal = structuredClone(input.appSpec);
    const model = new ScriptedModel([
      tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_complex_dataset"),
      tool("inspectFields", {
        dataSourceId: "dataset_retail_orders",
        fields: ["region", "order_id", "customer_id", "anomaly_count", "repurchase_rate"],
      }, "call_complex_fields"),
      tool("previewDataRecipe", { recipeId: "recipe_east_anomalies" }, "call_complex_recipe"),
      tool("exportDataRecipeToExcel", { recipeId: "recipe_east_anomalies", fileName: "华东异常订单复购分析.xlsx" }, "call_complex_excel"),
    ]);

    const task = await new DeepSeekHarness().run(input, {
      dataRuntime: data.dataRuntime,
      modelClient: model,
      excelExporter: harnessExcelExporter,
    });

    expect(task.state).toBe("completed");
    expect(task.error).toBeUndefined();
    expect(task.counters).toEqual({ loopCount: 4, modelCallCount: 4, toolCallCount: 4 });
    expect(model.inputs.map((entry) => entry.tools.map((toolDefinition) => toolDefinition.name))).toEqual([
      ["inspectDataset"],
      ["inspectFields"],
      ["previewDataRecipe"],
      ["exportDataRecipeToExcel"],
    ]);
    const serializedRounds = model.inputs.map((entry) => JSON.stringify(entry.context));
    expect(serializedRounds.every((serialized) => !serialized.includes("order_1_1"))).toBe(true);
    expect(serializedRounds[2]).not.toContain('"tool":"inspectDataset"');
    expect(task.contextUsage?.totalInputChars).toBeLessThan(18_000);
    expect(task.contextUsage?.totalInputChars).toBeLessThan(task.contextUsage?.limits?.maxTotalInputChars ?? 0);
    expect(task.contextUsage?.requests.map((entry) => entry.toolObservationChars)).toEqual([
      0,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
    ]);
    expect(task.pendingChangeSet).toBeUndefined();
    expect(task.exportArtifact).toMatchObject({ fileName: "华东异常订单复购分析.xlsx", status: "ready" });
    expect(task.exportArtifact?.rowCount).toBeGreaterThan(0);
    expect(task.exportArtifact?.fieldCount).toBeGreaterThan(0);
    expect(JSON.stringify(task)).not.toContain("PK mock workbook");
    expect(input.appSpec).toEqual(formal);
  });

  it("复购与异常字段不足时进入 blocked，并明确报告缺失能力", async () => {
    const data = fixtures();
    const input = customerAnalysisRequest("request_missing_repurchase_fields");
    input.appSpec.dataSources[0].fields = input.appSpec.dataSources[0].fields.filter((field) => (
      !["repurchase_rate", "customer_id", "order_id", "anomaly_count", "refunded"].includes(field.name)
    ));
    input.appSpec.dataSources[0].columnCount = input.appSpec.dataSources[0].fields.length;
    const formal = structuredClone(input.appSpec);
    const model = new ScriptedModel([
      tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_missing_dataset"),
      tool("inspectFields", { dataSourceId: "dataset_retail_orders" }, "call_missing_fields"),
    ]);

    const task = await new DeepSeekHarness().run(input, { dataRuntime: data.dataRuntime, modelClient: model });

    expect(task.state).toBe("blocked");
    expect(task.terminationCode).toBe("missingDataFields");
    expect(task.error).toContain("数据字段不足");
    expect(task.error).toContain("anomaly_count 或 refunded");
    expect(task.error).toContain("customer_id、order_id");
    expect(task.pendingChangeSet).toBeUndefined();
    expect(input.appSpec).toEqual(formal);
  });

  it("仍有可用工具时模型声称没有工具会被判定为协议失败", async () => {
    const data = fixtures();
    const model = new ScriptedModel([complete("当前没有可用的数据工具或数据集。")]);
    const task = await new DeepSeekHarness().run(customerAnalysisRequest("request_false_no_tools"), {
      dataRuntime: data.dataRuntime,
      modelClient: model,
    });

    expect(model.inputs[0].tools.length).toBeGreaterThan(0);
    expect(task.state).toBe("failed");
    expect(task.terminationCode).toBe("protocolViolation");
    expect(task.error).toContain("模型协议失败");
    expect(task.counters.toolCallCount).toBe(0);
  });

  it("通过 mock DeepSeek Chat JSON 获取单个结构化动作", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: "mock-deepseek-chat",
      choices: [{ message: { content: JSON.stringify(complete("只读检查完成。")) } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const model = new DeepSeekHarnessModel({ apiKey: "mock-credential", model: "mock-deepseek-chat", fetchImpl });
    const result = await model.next({
      tools: harnessToolCatalog(),
      context: { phase: "test" },
      estimatedInputChars: 100,
      iteration: 1,
      signal: new AbortController().signal,
    });
    expect(result.turn).toEqual(complete("只读检查完成。"));
    expect(result.usage.totalTokens).toBe(14);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      stream: false,
    });
    const messages = body.messages as Array<{ role: string; content: string }>;
    const userPayload = JSON.parse(messages.find((message) => message.role === "user")?.content ?? "{}") as Record<string, unknown>;
    expect(userPayload).not.toHaveProperty("appSpec");
    expect(userPayload).not.toHaveProperty("request");
    expect(userPayload).not.toHaveProperty("observations");
  });

  it("拒绝超出硬上限的 DeepSeek Harness 响应体", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(512 * 1024 + 1) },
    }));
    const model = new DeepSeekHarnessModel({ apiKey: "mock-credential", model: "mock-deepseek-chat", fetchImpl });

    await expect(model.next({
      tools: [],
      context: { phase: "test" },
      estimatedInputChars: 100,
      iteration: 1,
      signal: new AbortController().signal,
    })).rejects.toThrow("DeepSeek 返回了无法识别的响应");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("模型 token 与执行 bounds 只能收紧，不能放宽硬预算", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    expect(() => new DeepSeekHarnessModel({
      apiKey: "mock-credential",
      model: "mock-deepseek-chat",
      fetchImpl,
      maxCompletionTokens: MAX_HARNESS_COMPLETION_TOKENS_PER_CALL + 1,
    })).toThrow(/输出 token 上限/);
    expect(() => new DeepSeekHarnessModel({
      apiKey: "mock-credential",
      model: "mock-deepseek-chat",
      fetchImpl,
      promptTokenLimit: 12_001,
    })).toThrow(/输入 token 上限/);

    const data = fixtures();
    const model = new ScriptedModel([complete("不应执行")]);
    await expect(new DeepSeekHarness().run(request("request_oversized_bounds"), {
      dataRuntime: data.dataRuntime,
      modelClient: model,
      bounds: { totalExecutionTimeoutMs: HARNESS_HARD_BOUNDS.totalExecutionTimeoutMs + 1 },
    })).rejects.toThrow(/执行边界不合法/);
    expect(model.calls).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("普通 DeepSeek Harness 同样强制可信 usage 且不能关闭校验", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: "mock-deepseek-chat",
      choices: [{ message: { content: JSON.stringify(complete("只读检查完成。")) } }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const model = new DeepSeekHarnessModel({ apiKey: "mock-credential", model: "mock-deepseek-chat", fetchImpl });
    await expect(model.next({
      tools: [],
      context: { phase: "test" },
      estimatedInputChars: 100,
      iteration: 1,
      signal: new AbortController().signal,
    })).rejects.toThrow(/可信的 token 用量/);
    expect(() => new DeepSeekHarnessModel({
      apiKey: "mock-credential",
      model: "mock-deepseek-chat",
      fetchImpl,
      requireProviderUsage: false,
    })).toThrow(/不能关闭/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("Live 模式收紧 completion 上限并要求可信 provider usage", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: "mock-deepseek-chat",
      choices: [{ message: { content: JSON.stringify(complete("只读检查完成。")) } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const model = new DeepSeekHarnessModel({
      apiKey: "mock-credential",
      model: "mock-deepseek-chat",
      fetchImpl,
      maxCompletionTokens: 400,
      requireProviderUsage: true,
      promptTokenLimit: 2_500,
    });

    await expect(model.next({
      tools: [],
      context: { phase: "followUp", taskMode: "readOnly", latestObservation: { summary: "完成" } },
      estimatedInputChars: 100,
      iteration: 2,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 } });
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as { max_tokens: number };
    expect(body.max_tokens).toBe(400);
  });

  it.each([
    ["虚假密钥 canary", "FAKE_LIVE_SECRET_CANARY_7D2C"],
    ["session nonce", "a".repeat(64)],
    ["数据 canary", "FAKE_LIVE_DATA_CANARY_91B4"],
    ["指令 canary", "FAKE_LIVE_INSTRUCTION_CANARY_E6A8"],
    ["换行", "deepseek-v4-flash\nINJECTED"],
    ["反引号", "deepseek-v4-flash`injected"],
    ["HTML", "deepseek-v4-flash<script>"],
    ["Markdown", "deepseek-v4-flash|injected"],
  ])("Live 模式拒绝 provider 污染的 model（%s），且错误不回显不可信值", async (_label, untrustedModel) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: untrustedModel,
      choices: [{ message: { content: JSON.stringify(complete("只读检查完成。")) } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const model = new DeepSeekHarnessModel({
      apiKey: "mock-credential",
      model: "deepseek-v4-flash",
      fetchImpl,
      maxCompletionTokens: 400,
      requireProviderUsage: true,
    });

    let caught: unknown;
    try {
      await model.next({
        tools: [],
        context: { phase: "followUp", taskMode: "readOnly", latestObservation: { summary: "完成" } },
        estimatedInputChars: 100,
        iteration: 2,
        signal: new AbortController().signal,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "provider_model_mismatch" });
    expect(String(caught)).not.toContain(untrustedModel);
  });

  it("Live 模式只返回本次请求使用的可信 model 标识", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: "deepseek-v4-flash",
      choices: [{ message: { content: JSON.stringify(complete("只读检查完成。")) } }],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const model = new DeepSeekHarnessModel({
      apiKey: "mock-credential",
      model: "deepseek-v4-flash",
      fetchImpl,
      maxCompletionTokens: 400,
      requireProviderUsage: true,
    });

    await expect(model.next({
      tools: [],
      context: { phase: "followUp", taskMode: "readOnly", latestObservation: { summary: "完成" } },
      estimatedInputChars: 100,
      iteration: 2,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ model: "deepseek-v4-flash" });
  });

  it.each([
    ["缺失", undefined, "可信的 token 用量"],
    ["总量不一致", { prompt_tokens: 10, completion_tokens: 4, total_tokens: 99 }, "可信的 token 用量"],
    ["负数", { prompt_tokens: -1, completion_tokens: 4, total_tokens: 3 }, "无法识别的响应"],
    ["非数字", { prompt_tokens: "10", completion_tokens: 4, total_tokens: 14 }, "无法识别的响应"],
    ["NaN", { prompt_tokens: Number.NaN, completion_tokens: 4, total_tokens: 14 }, "无法识别的响应"],
    ["Infinity", { prompt_tokens: Number.POSITIVE_INFINITY, completion_tokens: 4, total_tokens: 14 }, "无法识别的响应"],
    ["-Infinity", { prompt_tokens: Number.NEGATIVE_INFINITY, completion_tokens: 4, total_tokens: 14 }, "无法识别的响应"],
    ["超出 prompt 上限", { prompt_tokens: 2_501, completion_tokens: 4, total_tokens: 2_505 }, "可信的 token 用量"],
    ["超出 completion 上限", { prompt_tokens: 10, completion_tokens: 401, total_tokens: 411 }, "可信的 token 用量"],
  ])("Live 模式对不可信 provider usage fail closed：%s", async (_label, usage, expectedError) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: "mock-deepseek-chat",
      choices: [{ message: { content: JSON.stringify(complete("只读检查完成。")) } }],
      ...(usage ? { usage } : {}),
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const model = new DeepSeekHarnessModel({
      apiKey: "mock-credential",
      model: "mock-deepseek-chat",
      fetchImpl,
      maxCompletionTokens: 400,
      requireProviderUsage: true,
      promptTokenLimit: 2_500,
    });

    await expect(model.next({
      tools: [],
      context: { phase: "followUp", taskMode: "readOnly", latestObservation: { summary: "完成" } },
      estimatedInputChars: 100,
      iteration: 2,
      signal: new AbortController().signal,
    })).rejects.toThrow(expectedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("只读工具成功后可兼容脱敏 fixture 的 completed 动作包装", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: "mock-deepseek-chat",
      choices: [{ message: { content: JSON.stringify(redactedCompleteActionFailureFixture) } }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const model = new DeepSeekHarnessModel({ apiKey: "mock-credential", model: "mock-deepseek-chat", fetchImpl });

    const result = await model.next({
      tools: [],
      context: {
        phase: "followUp",
        taskMode: "readOnly",
        lastObservation: { tool: "inspectDataset", summary: "检查成功" },
      },
      estimatedInputChars: 100,
      iteration: 2,
      signal: new AbortController().signal,
    });

    expect(result.turn).toEqual({
      type: "complete",
      message: redactedCompleteActionFailureFixture.message,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("写任务的文本总结不能绕过 createChangeSetPreview，正式状态和 localStorage 不变", async () => {
    const data = fixtures();
    const input = request("request_write_summary_bypass", "将本月收入标题改为月度总收入");
    const formal = structuredClone(input.appSpec);
    const storageKey = "harness-formal-state";
    const storageValue = JSON.stringify(formal);
    const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    const storage = new Map([[storageKey, storageValue]]);
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
        clear: () => storage.clear(),
        key: (index: number) => [...storage.keys()][index] ?? null,
        get length() { return storage.size; },
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      model: "mock-deepseek-chat",
      choices: [{ message: { content: JSON.stringify({ message: "已修改页面。" }) } }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    }), { status: 200, headers: { "content-type": "application/json" } }));

    try {
      const task = await new DeepSeekHarness().run(input, {
        dataRuntime: data.dataRuntime,
        modelClient: new DeepSeekHarnessModel({ apiKey: "mock-credential", model: "mock-deepseek-chat", fetchImpl }),
      });

      expect(task.state).toBe("failed");
      expect(task.error).toContain("Schema 校验");
      expect(task.pendingChangeSet).toBeUndefined();
      expect(input.appSpec).toEqual(formal);
      expect(globalThis.localStorage.getItem(storageKey)).toBe(storageValue);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      if (originalLocalStorage) Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("自动执行单次只读分析并完成任务", async () => {
    const data = fixtures();
    const model = new ScriptedModel([
      tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_dataset"),
      complete("数据源结构正常。"),
    ]);
    const task = await new DeepSeekHarness().run(request(), { dataRuntime: data.dataRuntime, modelClient: model });
    expect(task.state).toBe("completed");
    expect(task.counters).toEqual({ loopCount: 2, modelCallCount: 2, toolCallCount: 1 });
    expect(task.usage).toEqual({ promptTokens: 2, completionTokens: 2, totalTokens: 4 });
    expect(task.contextUsage?.requests).toHaveLength(2);
    expect(task.contextUsage?.totalInputChars).toBeLessThan(16_000);
    expect(task.events.map((event) => event.state)).toEqual(expect.arrayContaining(["planning", "executingTool", "observing", "completed"]));
    expect(task.events.some((event) => event.message.includes("48 行"))).toBe(true);
  });

  it("实际累计输入 token 达到硬上限时在下一次模型调用前安全失败", async () => {
    const data = fixtures();
    const input = request("request_prompt_token_limit", "检查 retail_orders 数据集是否可用，返回行数和列数。不要修改页面。");
    const formal = structuredClone(input.appSpec);
    const model = new ScriptedModel([
      tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_token_limit"),
    ], [{ promptTokens: 3_450, completionTokens: 10, totalTokens: 3_460 }]);

    const task = await new DeepSeekHarness().run(input, { dataRuntime: data.dataRuntime, modelClient: model });

    expect(task.state).toBe("failed");
    expect(task.contextUsage?.limitReached).toBe("taskPromptTokens");
    expect(task.error).toContain("输入 token");
    expect(model.calls).toBe(1);
    expect(task.events.some((event) => event.toolCall?.name === "inspectDataset" && event.toolCall.status === "success")).toBe(true);
    expect(input.appSpec).toEqual(formal);
  });

  it("只读检查后可用规范 blocked 终止并报告缺失条件", async () => {
    const data = fixtures();
    const model = new ScriptedModel([
      tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_dataset_blocked"),
      blocked("无法继续完成专项分析。", ["风险标签字段"]),
    ]);

    const task = await new DeepSeekHarness().run(request("request_readonly_blocked"), {
      dataRuntime: data.dataRuntime,
      modelClient: model,
    });

    expect(task.state).toBe("blocked");
    expect(task.error).toContain("风险标签字段");
    expect(task.resultMessage).toContain("正式 AppSpec 未修改");
    expect(task.pendingChangeSet).toBeUndefined();
  });

  it("支持多步骤数据配方预览并保留观察摘要", async () => {
    const data = fixtures();
    const model = new ScriptedModel([
      tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_source"),
      tool("inspectFields", { dataSourceId: "dataset_retail_orders", fields: ["repurchase_rate", "anomaly_count"] }, "call_fields"),
      tool("previewDataRecipe", { recipeId: "recipe_east_anomalies" }, "call_recipe"),
      complete("配方执行和字段血缘均正常。"),
    ]);
    const task = await new DeepSeekHarness().run(request("request_recipe_steps", "检查零售数据配方并预览结果"), { dataRuntime: data.dataRuntime, modelClient: model });
    expect(task.state).toBe("completed");
    expect(task.counters.toolCallCount).toBe(3);
    expect(task.events.some((event) => event.message.includes("8 步"))).toBe(true);
  });

  it("修改型工具只生成待确认 ChangeSet，不修改正式 AppSpec", async () => {
    const data = fixtures();
    const formal = structuredClone(data.dataProduct.appSpec);
    const model = new ScriptedModel([tool("createChangeSetPreview", {
      message: "建议修改收入指标标题。",
      operations: [{ type: "updateNodeProps", pageId: "page_home", nodeId: "page_home_revenue", props: { label: "月度总收入" } }],
    }, "call_change")]);
    const task = await new DeepSeekHarness().run(request("request_change_preview", "将本月收入标题改为月度总收入"), { dataRuntime: data.dataRuntime, modelClient: model });
    expect(task.state).toBe("awaitingConfirmation");
    expect(task.pendingChangeSet?.operations).toEqual([expect.objectContaining({
      type: "updateNodeProps",
      pageId: "page_home",
      nodeId: "page_home_revenue",
      props: { label: "月度总收入" },
    })]);
    expect(data.dataProduct.appSpec).toEqual(formal);
    expect(model.calls).toBe(1);
  });

  it("用户拒绝保持正式状态，用户确认后仍由现有执行器应用", async () => {
    const data = fixtures();
    const model = new ScriptedModel([tool("createChangeSetPreview", {
      message: "建议修改收入指标标题。",
      operations: [{ type: "updateNodeProps", pageId: "page_home", nodeId: "page_home_revenue", props: { label: "月度总收入" } }],
    }, "call_confirm")]);
    const task = await new DeepSeekHarness().run(request("request_user_confirm", "将本月收入标题改为月度总收入"), { dataRuntime: data.dataRuntime, modelClient: model });
    if (!task.pendingChangeSet) throw new Error("预期存在待确认 ChangeSet");
    const initial = createExecutionState(data.dataProduct.appSpec);
    const rejected = settleHarnessConfirmation(task, false, { now: () => new Date(), id: () => "reject_event" });
    expect(rejected.state).toBe("cancelled");
    expect(initial.present).toEqual(data.dataProduct.appSpec);

    const previewed = previewChangeSet(initial, task.pendingChangeSet, "editor");
    expect(previewed.present).toEqual(initial.present);
    const applied = applyChangeSet(previewed, task.pendingChangeSet, "editor");
    const confirmed = settleHarnessConfirmation(task, true, { now: () => new Date(), id: () => "confirm_event" });
    expect(confirmed.state).toBe("completed");
    expect(confirmed.terminationCode).toBe("completed");
    expect(applied.present).not.toEqual(initial.present);
  });

  it("拒绝非法工具和非法参数并返回脱敏失败事件", async () => {
    const data = fixtures();
    const illegalTool = await new DeepSeekHarness().run(request("request_illegal_tool"), {
      dataRuntime: data.dataRuntime,
      modelClient: new ScriptedModel([tool("deleteDatabase", {}, "call_bad_tool")]),
    });
    expect(illegalTool.state).toBe("failed");
    expect(illegalTool.terminationCode).toBe("invalidTool");
    expect(illegalTool.error).toContain("不允许调用工具");

    const illegalArgs = await new DeepSeekHarness().run(request("request_illegal_args"), {
      dataRuntime: data.dataRuntime,
      modelClient: new ScriptedModel([tool("inspectDataset", { dataSourceId: 123 }, "call_bad_args")]),
    });
    expect(illegalArgs.state).toBe("failed");
    expect(illegalArgs.terminationCode).toBe("toolExecutionFailed");
    expect(illegalArgs.error).toContain("参数不符合定义");
  });

  it("任务事件不会记录认证头、密钥或 reasoning_content", async () => {
    const data = fixtures();
    const unsafeModel: HarnessModel = {
      next: async () => { throw new Error("Authorization: Bearer sensitive-token reasoning_content=private-chain"); },
    };
    const task = await new DeepSeekHarness().run(request("request_redaction"), {
      dataRuntime: data.dataRuntime,
      modelClient: unsafeModel,
    });
    const serialized = JSON.stringify(task);
    expect(serialized).not.toContain("sensitive-token");
    expect(serialized).not.toContain("private-chain");
    expect(serialized).not.toContain("Authorization: Bearer");
  });

  it("底层再次拒绝 viewer 的修改型工具", async () => {
    const data = fixtures();
    const viewerRequest = { ...request("request_viewer_change", "将本月收入标题改为月度总收入"), role: "viewer" as const };
    const task = await new DeepSeekHarness().run(viewerRequest, {
      dataRuntime: data.dataRuntime,
      modelClient: new ScriptedModel([tool("createChangeSetPreview", {
        message: "尝试修改",
        operations: [{ type: "updateNodeProps", pageId: "page_home", nodeId: "page_home_revenue", props: { label: "不允许" } }],
      }, "call_viewer")]),
    });
    expect(task.state).toBe("failed");
    expect(task.error).toContain("当前规划状态不允许调用工具");
  });

  it("支持总超时、单工具超时和外部取消", async () => {
    const data = fixtures();
    const neverModel: HarnessModel = { next: vi.fn(() => new Promise<HarnessModelResult>(() => undefined)) };
    const timedOut = await new DeepSeekHarness().run(request("request_total_timeout"), {
      dataRuntime: data.dataRuntime,
      modelClient: neverModel,
      bounds: { modelRequestTimeoutMs: 100, totalExecutionTimeoutMs: 20 },
    });
    expect(timedOut.state).toBe("failed");
    expect(timedOut.error).toContain("总执行时间");

    const toolTimedOut = await new DeepSeekHarness().run(request("request_tool_timeout"), {
      dataRuntime: data.dataRuntime,
      modelClient: new ScriptedModel([tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_slow")]),
      bounds: { toolCallTimeoutMs: 5 },
      toolExecutor: () => new Promise((resolve) => setTimeout(() => resolve({ summary: "迟到结果", data: {} }), 30)),
    });
    expect(toolTimedOut.state).toBe("failed");
    expect(toolTimedOut.error).toContain("单次工具调用");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const cancelled = await new DeepSeekHarness().run(request("request_cancelled"), {
      dataRuntime: data.dataRuntime,
      modelClient: neverModel,
      signal: controller.signal,
    });
    expect(cancelled.state).toBe("cancelled");
  });

  it("调用前已取消时不启动模型", async () => {
    const data = fixtures();
    const controller = new AbortController();
    const model = new ScriptedModel([complete("不应执行")]);
    controller.abort();
    const cancelled = await new DeepSeekHarness().run(request("request_pre_cancelled"), {
      dataRuntime: data.dataRuntime,
      modelClient: model,
      signal: controller.signal,
    });

    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.terminationCode).toBe("cancelled");
    expect(model.calls).toBe(0);
  });

  it("两次正常延迟模型调用不会误触发总超时，并记录分阶段耗时", async () => {
    const data = fixtures();
    const formal = structuredClone(data.dataProduct.appSpec);
    const model = new DelayedScriptedModel([
      tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_delayed_dataset"),
      complete("两次模型调用均正常完成。"),
    ], [12, 12]);

    const task = await new DeepSeekHarness().run(request("request_two_delayed_calls"), {
      dataRuntime: data.dataRuntime,
      modelClient: model,
      bounds: { modelRequestTimeoutMs: 50, toolCallTimeoutMs: 30, totalExecutionTimeoutMs: 120 },
    });

    expect(task.state).toBe("completed");
    expect(task.executionTiming?.phase).toBe("completed");
    expect(task.executionTiming?.modelDurationMs).toBeGreaterThanOrEqual(20);
    expect(task.executionTiming?.activeElapsedMs).toBe(
      (task.executionTiming?.modelDurationMs ?? 0) + (task.executionTiming?.toolDurationMs ?? 0),
    );
    expect(task.executionTiming?.otherDurationMs).toBe(0);
    expect(task.executionTiming?.remainingMs).toBeGreaterThan(0);
    expect(task.events.filter((event) => event.timing?.phase === "modelRequest")).toHaveLength(2);
    expect(data.dataProduct.appSpec).toEqual(formal);
  });

  it("模型与工具阶段各只采样一次结束时间，累计和事件耗时一致", async () => {
    const data = fixtures();
    const moments = [0, 10, 10, 15, 15, 25];
    const monotonicNow = vi.fn(() => {
      const value = moments.shift();
      if (value === undefined) throw new Error("unexpected monotonic clock read");
      return value;
    });
    const task = await new DeepSeekHarness().run(request("request_precise_timing"), {
      dataRuntime: data.dataRuntime,
      modelClient: new ScriptedModel([
        tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_precise_timing"),
        complete("精确计时完成。"),
      ]),
      monotonicNow,
    });

    expect(task.state).toBe("completed");
    expect(monotonicNow).toHaveBeenCalledTimes(6);
    expect(task.executionTiming).toMatchObject({ modelDurationMs: 20, toolDurationMs: 5, activeElapsedMs: 25 });
    expect(task.events
      .filter((event) => event.message.includes("模型请求完成"))
      .map((event) => event.timing?.durationMs)).toEqual([10, 10]);
  });

  it("非法 Harness 时钟不会覆盖模型错误或破坏失败摘要", async () => {
    const data = fixtures();
    const initialModel = new ScriptedModel([complete("不应执行")]);
    const invalidInitialClock = {
      now: () => new Date(Number.NaN),
      id: () => "invalid_initial_clock",
    };
    const invalidInitial = await new DeepSeekHarness().run(request("request_invalid_initial_clock"), {
      dataRuntime: data.dataRuntime,
      modelClient: initialModel,
      clock: invalidInitialClock,
    });
    expect(invalidInitial).toMatchObject({ state: "failed", terminationCode: "executionFailed" });
    expect(invalidInitial.error).toContain("Harness 时钟必须返回有效 Date");
    expect(initialModel.calls).toBe(0);
    expect(() => harnessTaskSummarySchema.parse(invalidInitial)).not.toThrow();

    const extremeModel = new ScriptedModel([complete("不应执行")]);
    const extremeInitial = await new DeepSeekHarness().run(request("request_extreme_initial_clock"), {
      dataRuntime: data.dataRuntime,
      modelClient: extremeModel,
      clock: {
        now: () => new Date(8_640_000_000_000_000),
        id: () => "event_extreme_initial_clock",
      },
    });
    expect(extremeInitial).toMatchObject({ state: "failed", terminationCode: "executionFailed" });
    expect(extremeInitial.error).toContain("Harness 时钟必须返回有效 Date");
    expect(extremeModel.calls).toBe(0);
    expect(() => harnessTaskSummarySchema.parse(extremeInitial)).not.toThrow();

    let laterWallClockCalls = 0;
    const laterWallClockModel = new ScriptedModel([complete("不应执行")]);
    const invalidLaterWallClock = await new DeepSeekHarness().run(request("request_invalid_later_wall_clock"), {
      dataRuntime: data.dataRuntime,
      modelClient: laterWallClockModel,
      clock: {
        now: () => laterWallClockCalls++ === 0
          ? new Date("2026-09-04T00:00:00.000Z")
          : new Date(Number.NaN),
        id: () => "event_invalid_later_wall_clock",
      },
    });
    expect(invalidLaterWallClock).toMatchObject({ state: "failed", terminationCode: "executionFailed" });
    expect(invalidLaterWallClock.error).toContain("Harness 时钟必须返回有效 Date");
    expect(laterWallClockModel.calls).toBe(0);
    expect(() => harnessTaskSummarySchema.parse(invalidLaterWallClock)).not.toThrow();

    let wallClockCalls = 0;
    const failingModel: HarnessModel = {
      next: vi.fn(async () => { throw new Error("primary model failure"); }),
    };
    const failed = await new DeepSeekHarness().run(request("request_clock_preserves_error"), {
      dataRuntime: data.dataRuntime,
      modelClient: failingModel,
      clock: {
        now: () => wallClockCalls++ < 2
          ? new Date("2026-09-04T00:00:00.000Z")
          : new Date(Number.NaN),
        id: () => "event_clock_preserves_error",
      },
      monotonicNow: (() => {
        let calls = 0;
        return () => calls++ === 0 ? 0 : Number.POSITIVE_INFINITY;
      })(),
    });
    expect(failed).toMatchObject({ state: "failed", terminationCode: "executionFailed" });
    expect(failed.error).toContain("primary model failure");
    expect(failed.executionTiming).toMatchObject({ modelDurationMs: 0, activeElapsedMs: 0 });
    expect(() => harnessTaskSummarySchema.parse(failed)).not.toThrow();

    const invalidMonotonicModel = new ScriptedModel([complete("不应执行")]);
    const invalidMonotonic = await new DeepSeekHarness().run(request("request_invalid_monotonic_clock"), {
      dataRuntime: data.dataRuntime,
      modelClient: invalidMonotonicModel,
      monotonicNow: () => Number.NaN,
    });
    expect(invalidMonotonic).toMatchObject({ state: "failed", terminationCode: "executionFailed" });
    expect(invalidMonotonic.error).toContain("Harness 单调时钟必须返回有限数值");
    expect(invalidMonotonicModel.calls).toBe(0);
    expect(() => harnessTaskSummarySchema.parse(invalidMonotonic)).not.toThrow();

    let rollbackClockCalls = 0;
    const rollbackModel = new ScriptedModel([complete("不应接受回拨计时")]);
    const rollback = await new DeepSeekHarness().run(request("request_rollback_monotonic_clock"), {
      dataRuntime: data.dataRuntime,
      modelClient: rollbackModel,
      monotonicNow: () => rollbackClockCalls++ === 0 ? 10 : 9,
    });
    expect(rollback).toMatchObject({ state: "failed", terminationCode: "executionFailed" });
    expect(rollback.error).toContain("非负安全整数毫秒耗时");
    expect(rollbackModel.calls).toBe(1);
    expect(() => harnessTaskSummarySchema.parse(rollback)).not.toThrow();

    const invalidModelEnd = new ScriptedModel([
      tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_invalid_model_end"),
    ]);
    let modelEndClockCalls = 0;
    const failedModelEnd = await new DeepSeekHarness().run(request("request_invalid_model_end_clock"), {
      dataRuntime: data.dataRuntime,
      modelClient: invalidModelEnd,
      monotonicNow: () => modelEndClockCalls++ === 0 ? 0 : Number.POSITIVE_INFINITY,
    });
    expect(failedModelEnd).toMatchObject({ state: "failed", terminationCode: "executionFailed" });
    expect(failedModelEnd.error).toContain("非负安全整数毫秒耗时");
    expect(invalidModelEnd.calls).toBe(1);
    expect(failedModelEnd.counters.toolCallCount).toBe(0);

    let toolWallClockCalls = 0;
    let toolMonotonicCalls = 0;
    const toolExecutor = vi.fn(async () => { throw new Error("primary tool failure"); });
    const failedTool = await new DeepSeekHarness().run(request("request_tool_error_with_invalid_clocks"), {
      dataRuntime: data.dataRuntime,
      modelClient: new ScriptedModel([
        tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_tool_clock_failure"),
      ]),
      toolExecutor,
      clock: {
        now: () => toolWallClockCalls++ < 4
          ? new Date("2026-09-04T00:00:00.000Z")
          : new Date(Number.NaN),
        id: () => "event_tool_clock_failure",
      },
      monotonicNow: () => [0, 1, 2, 1][toolMonotonicCalls++] ?? Number.NaN,
    });
    expect(failedTool).toMatchObject({ state: "failed", terminationCode: "toolExecutionFailed" });
    expect(failedTool.error).toContain("primary tool failure");
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(failedTool.events.some((event) => event.toolCall?.status === "failure" && event.toolCall.durationMs === 0)).toBe(true);
    expect(() => harnessTaskSummarySchema.parse(failedTool)).not.toThrow();
  });

  it("单次模型请求超时会独立终止，不误报为任务总超时", async () => {
    const data = fixtures();
    const formal = structuredClone(data.dataProduct.appSpec);
    const task = await new DeepSeekHarness().run(request("request_model_timeout"), {
      dataRuntime: data.dataRuntime,
      modelClient: new DelayedScriptedModel([complete("迟到结果")], [30]),
      bounds: { modelRequestTimeoutMs: 5, totalExecutionTimeoutMs: 80 },
    });

    expect(task.state).toBe("failed");
    expect(task.error).toContain("单次模型请求");
    expect(task.error).not.toContain("总时间");
    expect(task.executionTiming?.phase).toBe("failed");
    expect(data.dataProduct.appSpec).toEqual(formal);
  });

  it("超时后保留已完成只读观察，但不生成或应用写操作", async () => {
    const data = fixtures();
    const input = request("request_observation_then_timeout");
    const formal = structuredClone(input.appSpec);
    const task = await new DeepSeekHarness().run(input, {
      dataRuntime: data.dataRuntime,
      modelClient: new DelayedScriptedModel([
        tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_before_timeout"),
        complete("迟到总结"),
      ], [1, 30]),
      bounds: { modelRequestTimeoutMs: 8, totalExecutionTimeoutMs: 80 },
    });

    expect(task.state).toBe("failed");
    expect(task.executionTiming?.retainedObservationCount).toBe(1);
    expect(task.events.some((event) => event.type === "observation" && event.toolCall?.status === "success")).toBe(true);
    expect(task.pendingChangeSet).toBeUndefined();
    expect(input.appSpec).toEqual(formal);
  });

  it("等待人工确认和历史墙钟时间不计入执行预算", async () => {
    const data = fixtures();
    const formal = structuredClone(data.dataProduct.appSpec);
    const model = new DelayedScriptedModel([tool("createChangeSetPreview", {
      message: "建议修改收入指标标题。",
      operations: [{ type: "updateNodeProps", pageId: "page_home", nodeId: "page_home_revenue", props: { label: "月度总收入" } }],
    }, "call_waiting_confirmation")], [5]);
    const task = await new DeepSeekHarness().run(request("request_waiting_budget", "将本月收入标题改为月度总收入"), {
      dataRuntime: data.dataRuntime,
      modelClient: model,
      bounds: { modelRequestTimeoutMs: 30, totalExecutionTimeoutMs: 80 },
    });
    expect(task.state).toBe("awaitingConfirmation");
    const activeElapsedMs = task.executionTiming?.activeElapsedMs;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const settled = settleHarnessConfirmation(task, false, {
      now: () => new Date("2035-01-01T00:00:00.000Z"),
      id: () => "settled_after_idle",
    });

    expect(settled.executionTiming?.activeElapsedMs).toBe(activeElapsedMs);
    expect(settled.totalDurationMs).toBe(task.totalDurationMs);
    expect(data.dataProduct.appSpec).toEqual(formal);
  });

  it("刷新后的重试使用新单调预算并关联原任务", async () => {
    const data = fixtures();
    const oldClock = { now: () => new Date("2020-01-01T00:00:00.000Z"), id: () => "old_event" };
    const oldTask = createHarnessTask("request_old_wall_clock", "检查零售数据", "page_home", "editor", oldClock, {
      executionTiming: {
        phase: "planning",
        activeElapsedMs: 59,
        remainingMs: 1,
        totalBudgetMs: 60,
        modelRequestTimeoutMs: 30,
        toolCallTimeoutMs: 10,
        modelDurationMs: 49,
        toolDurationMs: 10,
        otherDurationMs: 0,
        retainedObservationCount: 1,
      },
    });
    const [recovered] = recoverHarnessTasksAfterRefresh([oldTask], {
      now: () => new Date("2035-01-01T00:00:00.000Z"),
      id: () => "recovery_event",
    });
    expect(recovered.state).toBe("cancelled");

    const retryRequest = request("request_retry_new_budget");
    retryRequest.retryOfTaskId = recovered.id;
    const retry = await new DeepSeekHarness().run(retryRequest, {
      dataRuntime: data.dataRuntime,
      modelClient: new DelayedScriptedModel([
        tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_retry_dataset"),
        complete("重试完成"),
      ], [4, 4]),
      bounds: { modelRequestTimeoutMs: 30, totalExecutionTimeoutMs: 60 },
      monotonicNow: () => 10_000,
    });

    expect(retry.state).toBe("completed");
    expect(retry.retryOfTaskId).toBe(recovered.id);
    expect(retry.executionTiming?.totalBudgetMs).toBe(60);
    expect(retry.executionTiming?.remainingMs).toBe(60);
    expect(retry.executionTiming?.activeElapsedMs).toBe(0);
  });

  it("幂等请求只执行一次，冲突请求被拒绝", async () => {
    const data = fixtures();
    const model = new ScriptedModel([complete("只读完成")]);
    const harness = new DeepSeekHarness();
    const store = new HarnessIdempotencyStore();
    const input = request("request_idempotent");
    const first = store.execute(input, () => harness.run(input, { dataRuntime: data.dataRuntime, modelClient: model }), "owner-a");
    const second = store.execute(input, () => harness.run(input, { dataRuntime: data.dataRuntime, modelClient: model }), "owner-a");
    expect(await first).toEqual(await second);
    expect(model.calls).toBe(1);
    expect(() => store.execute({ ...input, instruction: "不同请求" }, async () => await first, "owner-a")).toThrow(HarnessIdempotencyConflictError);

    const otherOwnerModel = new ScriptedModel([complete("其他所有者独立完成")]);
    const otherOwner = await store.execute(
      { ...input, instruction: "其他所有者请求" },
      () => harness.run({ ...input, instruction: "其他所有者请求" }, { dataRuntime: data.dataRuntime, modelClient: otherOwnerModel }),
      "owner-b",
    );
    expect(otherOwner.state).toBe("completed");
    expect(otherOwnerModel.calls).toBe(1);
  });

  it("幂等存储拒绝非法边界且容量压力不淘汰执行中任务", async () => {
    expect(() => new HarnessIdempotencyStore(0)).toThrow(/边界不合法/);
    expect(() => new HarnessIdempotencyStore(1, 0)).toThrow(/边界不合法/);

    const store = new HarnessIdempotencyStore(1);
    const firstRequest = request("request_pending_capacity_1");
    const taskClock = { now: () => new Date("2026-09-04T00:00:00.000Z"), id: () => "event_capacity" };
    let resolveFirst!: (task: HarnessTaskSummary) => void;
    const firstTask = new Promise<HarnessTaskSummary>((resolve) => { resolveFirst = resolve; });
    const firstFactory = vi.fn(() => firstTask);
    const secondFactory = vi.fn(async () => createHarnessTask("request_pending_capacity_2", "检查数据", "page_home", "editor", taskClock));

    expect(store.execute(firstRequest, firstFactory)).toBe(firstTask);
    expect(store.execute(firstRequest, firstFactory)).toBe(firstTask);
    expect(() => store.execute({ ...firstRequest, idempotencyKey: "request_pending_capacity_2" }, secondFactory))
      .toThrow(HarnessIdempotencyCapacityError);
    expect(firstFactory).toHaveBeenCalledTimes(1);
    expect(secondFactory).not.toHaveBeenCalled();

    resolveFirst(createHarnessTask(firstRequest.idempotencyKey, firstRequest.instruction, firstRequest.pageId, firstRequest.role, taskClock));
    await firstTask;
    await expect(store.execute({ ...firstRequest, idempotencyKey: "request_pending_capacity_2" }, secondFactory))
      .resolves.toMatchObject({ idempotencyKey: "request_pending_capacity_2" });
    expect(secondFactory).toHaveBeenCalledTimes(1);
  });

  it("幂等 TTL 在精确边界过期且不淘汰执行中任务", async () => {
    const taskClock = { now: () => new Date("2026-09-04T00:00:00.000Z"), id: () => "event_ttl" };
    const input = request("request_idempotency_ttl");
    const summary = createHarnessTask(input.idempotencyKey, input.instruction, input.pageId, input.role, taskClock);
    let now = 1_000;
    const store = new HarnessIdempotencyStore(3, 100, () => now);
    const firstFactory = vi.fn(() => Promise.resolve(summary));
    const first = store.execute(input, firstFactory);
    await first;
    await Promise.resolve();

    now = 1_099;
    expect(store.execute(input, firstFactory)).toBe(first);
    now = 1_100;
    const replacementFactory = vi.fn(() => Promise.resolve(summary));
    const replacement = store.execute(input, replacementFactory);
    expect(replacement).not.toBe(first);
    expect(firstFactory).toHaveBeenCalledTimes(1);
    expect(replacementFactory).toHaveBeenCalledTimes(1);

    let resolvePending!: (task: HarnessTaskSummary) => void;
    const pendingTask = new Promise<HarnessTaskSummary>((resolve) => { resolvePending = resolve; });
    const pendingRequest = request("request_idempotency_pending_ttl");
    const pendingFactory = vi.fn(() => pendingTask);
    now = 2_000;
    expect(store.execute(pendingRequest, pendingFactory)).toBe(pendingTask);
    now = 2_500;
    expect(store.execute(pendingRequest, pendingFactory)).toBe(pendingTask);
    expect(pendingFactory).toHaveBeenCalledTimes(1);
    resolvePending(summary);
    await pendingTask;

    const rejectedRequest = request("request_idempotency_rejected_ttl");
    now = 3_000;
    const rejected = store.execute(rejectedRequest, () => Promise.reject(new Error("synthetic rejection")));
    await expect(rejected).rejects.toThrow("synthetic rejection");
    await Promise.resolve();
    now = 3_100;
    const rejectedReplacementFactory = vi.fn(() => Promise.resolve(summary));
    expect(store.execute(rejectedRequest, rejectedReplacementFactory)).not.toBe(rejected);
    expect(rejectedReplacementFactory).toHaveBeenCalledTimes(1);

    const invalidFactory = vi.fn(() => Promise.resolve(summary));
    const invalidStore = new HarnessIdempotencyStore(1, 100, () => Number.NaN);
    expect(() => invalidStore.execute(input, invalidFactory)).toThrow(/幂等存储时钟/);
    expect(invalidFactory).not.toHaveBeenCalled();
  });
});
