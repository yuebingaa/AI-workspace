import { describe, expect, it, vi } from "vitest";
import { applyChangeSet, createExecutionState, previewChangeSet } from "@/core/changesets";
import type { HarnessModel, HarnessModelResult, HarnessModelTurn, HarnessRequest } from "@/core/harness";
import { demoFixtureResult } from "@/fixtures/demo-product";
import {
  DeepSeekHarness,
  DeepSeekHarnessModel,
  HarnessIdempotencyConflictError,
  HarnessIdempotencyStore,
  harnessToolCatalog,
  settleHarnessConfirmation,
} from "./index";

class ScriptedModel implements HarnessModel {
  calls = 0;
  constructor(private readonly turns: HarnessModelTurn[]) {}
  async next(): Promise<HarnessModelResult> {
    const turn = this.turns[this.calls++];
    if (!turn) throw new Error("mock 没有更多动作");
    return { turn, model: "mock-deepseek", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } };
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
  return { message: `调用 ${name}`, action: { type: "tool", toolCallId: id, name, arguments: args } };
}

const complete = (message: string): HarnessModelTurn => ({ message, action: { type: "complete" } });

describe("DeepSeekHarness 服务端状态机", () => {
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
    expect(body).toMatchObject({ response_format: { type: "json_object" }, stream: false });
    const messages = body.messages as Array<{ role: string; content: string }>;
    const userPayload = JSON.parse(messages.find((message) => message.role === "user")?.content ?? "{}") as Record<string, unknown>;
    expect(userPayload).not.toHaveProperty("appSpec");
    expect(userPayload).not.toHaveProperty("request");
    expect(userPayload).not.toHaveProperty("observations");
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

  it("支持多步骤数据配方预览并保留观察摘要", async () => {
    const data = fixtures();
    const model = new ScriptedModel([
      tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_source"),
      tool("validateDataRecipe", { recipeId: "recipe_east_anomalies" }, "call_validate"),
      tool("previewDataRecipe", { recipeId: "recipe_east_anomalies" }, "call_recipe"),
      complete("配方执行和字段血缘均正常。"),
    ]);
    const task = await new DeepSeekHarness().run(request("request_recipe_steps", "检查零售数据配方并预览结果"), { dataRuntime: data.dataRuntime, modelClient: model, bounds: { maxModelCalls: 4 } });
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
    expect(applied.present).not.toEqual(initial.present);
  });

  it("拒绝非法工具和非法参数并返回脱敏失败事件", async () => {
    const data = fixtures();
    const illegalTool = await new DeepSeekHarness().run(request("request_illegal_tool"), {
      dataRuntime: data.dataRuntime,
      modelClient: new ScriptedModel([tool("deleteDatabase", {}, "call_bad_tool")]),
    });
    expect(illegalTool.state).toBe("failed");
    expect(illegalTool.error).toContain("不允许调用工具");

    const illegalArgs = await new DeepSeekHarness().run(request("request_illegal_args"), {
      dataRuntime: data.dataRuntime,
      modelClient: new ScriptedModel([tool("inspectDataset", { dataSourceId: 123 }, "call_bad_args")]),
    });
    expect(illegalArgs.state).toBe("failed");
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
      bounds: { totalTimeoutMs: 10 },
    });
    expect(timedOut.state).toBe("failed");
    expect(timedOut.error).toContain("总执行时间");

    const toolTimedOut = await new DeepSeekHarness().run(request("request_tool_timeout"), {
      dataRuntime: data.dataRuntime,
      modelClient: new ScriptedModel([tool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, "call_slow")]),
      bounds: { toolTimeoutMs: 5 },
      toolExecutor: () => new Promise((resolve) => setTimeout(() => resolve({ summary: "迟到结果", data: {} }), 30)),
    });
    expect(toolTimedOut.state).toBe("failed");
    expect(toolTimedOut.error).toContain("超出限制");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 5);
    const cancelled = await new DeepSeekHarness().run(request("request_cancelled"), {
      dataRuntime: data.dataRuntime,
      modelClient: neverModel,
      signal: controller.signal,
    });
    expect(cancelled.state).toBe("cancelled");
  });

  it("幂等请求只执行一次，冲突请求被拒绝", async () => {
    const data = fixtures();
    const model = new ScriptedModel([complete("只读完成")]);
    const harness = new DeepSeekHarness();
    const store = new HarnessIdempotencyStore();
    const input = request("request_idempotent");
    const first = store.execute(input, () => harness.run(input, { dataRuntime: data.dataRuntime, modelClient: model }));
    const second = store.execute(input, () => harness.run(input, { dataRuntime: data.dataRuntime, modelClient: model }));
    expect(await first).toEqual(await second);
    expect(model.calls).toBe(1);
    expect(() => store.execute({ ...input, instruction: "不同请求" }, async () => await first)).toThrow(HarnessIdempotencyConflictError);
  });
});
