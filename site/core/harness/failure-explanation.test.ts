import { describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { DeepSeekHarness, DeepSeekHarnessModel, HarnessModelFormatError, type DeepSeekHarnessOptions } from "./deepseek-harness";
import { harnessTaskSummarySchema, type HarnessModelInput, type HarnessModelResult, type HarnessModelTurn } from "./contracts";
import { acceptableFailureExplanation, failureResponse } from "./failure-response";

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
const repeated: HarnessModelTurn = { type: "callTool", name: "inspectDataset", arguments: { dataSourceId: "dataset_retail_orders" }, toolCallId: "failed_tool", message: "检查数据" };
const narration: HarnessModelTurn = { type: "complete", message: "这次暂时没能完成零售数据检查，你可以缩小分析范围后重新尝试。" };
async function run(narrate: (input: HarnessModelInput) => Promise<HarnessModelResult>, options: Partial<DeepSeekHarnessOptions> = {}) {
  if (!demoFixtureResult.success) throw new Error("fixture unavailable");
  const { dataProduct, dataRuntime } = structuredClone(demoFixtureResult.data);
  const request = { idempotencyKey: "failure_explanation_test", instruction: "检查 retail_orders 数据集概况，并将页面标题改为新的经营概览",
    pageId: "page_home", role: "editor", appSpec: dataProduct.appSpec, recipes: dataProduct.recipes };
  const original = JSON.stringify(request.appSpec);
  const inputs: HarnessModelInput[] = [];
  const toolExecutor = vi.fn(async () => { throw new Error("private backend C:\\private\\source.csv Bearer secret-token"); });
  const task = await new DeepSeekHarness().run(request, { dataRuntime, toolExecutor, modelClient: {
    next: async (input) => { inputs.push(input); return input.purpose === "failureExplanation" ? narrate(input) : { turn: repeated, model: "test", usage }; },
  }, ...options });
  expect(JSON.stringify(request.appSpec)).toBe(original);
  expect(harnessTaskSummarySchema.safeParse(task).success).toBe(true);
  return { task, inputs, toolExecutor };
}

describe("bounded failure narration", () => {
  it("uses a no-tool fact context and accounts for the explanation without changing failure", async () => {
    const { task, inputs, toolExecutor } = await run(async () => ({ turn: narration, model: "test", usage }));
    expect(task.state).toBe("failed");
    expect(task.terminationCode).toBe("toolExecutionFailed");
    expect(task.resultMessage).toContain(narration.message);
    expect(toolExecutor).toHaveBeenCalledTimes(2);
    expect(inputs).toHaveLength(4);
    expect(inputs.at(-1)?.tools).toEqual([]);
    expect(JSON.stringify(inputs.at(-1)?.context)).not.toMatch(/private|secret-token|source.csv/);
    expect(task.contextUsage?.requests.at(-1)).toMatchObject({ phase: "failureExplanation", promptTokens: 10 });
    expect(task.contextUsage?.totalPromptTokens).toBe(40);
    expect(task.usage?.totalTokens).toBe(60);
  });

  it.each(["providerError", "formatError", "toolCall", "inventedCause"])("falls back locally after %s without retrying", async (scenario) => {
    const { task, inputs, toolExecutor } = await run(async () => {
      if (scenario === "providerError") throw new Error("provider unavailable");
      if (scenario === "formatError") throw new HarnessModelFormatError("invalid json", "test", usage);
      return { model: "test", usage, turn: scenario === "toolCall" ? repeated : { type: "complete", message: "由于你的 API 余额不足，暂时无法完成数据分析，请充值后再试。" } };
    });
    expect(task.resultMessage).toBe(failureResponse(task));
    expect(inputs).toHaveLength(4);
    expect(toolExecutor).toHaveBeenCalledTimes(2);
    if (scenario === "formatError") expect(task.usage?.totalTokens).toBe(60);
  });

  it("does not explain once the model-call budget is exhausted", async () => {
    const narrate = vi.fn();
    const { task, inputs } = await run(narrate, { bounds: { maxModelCalls: 3 } });
    expect(narrate).not.toHaveBeenCalled();
    expect(inputs).toHaveLength(3);
    expect(task.resultMessage).toBe(failureResponse(task));
  });

  it("cancels during narration without turning a stopped task into a failure reply", async () => {
    const controller = new AbortController();
    const { task } = await run(async () => { controller.abort(); throw new Error("cancelled"); }, { signal: controller.signal });
    expect(task.state).toBe("cancelled");
    expect(task.terminationCode).toBe("cancelled");
    expect(task.trace?.at(-1)?.taskState).toBe("cancelled");
    expect(task.resultMessage).toContain("已经停止");
  });

  it("bounds an unresponsive narration and retains a useful local answer", async () => {
    const { task } = await run(async () => new Promise(() => {}), { bounds: { modelRequestTimeoutMs: 40 } });
    expect(task.state).toBe("failed");
    expect(task.resultMessage).toBe(failureResponse(task));
  });

  it("does not make another provider request when recovery hits a provider error", async () => {
    const next = vi.fn(async () => {
      if (next.mock.calls.length === 1) return { turn: repeated, model: "test", usage };
      throw new Error("DeepSeek 401 unauthorized");
    });
    const { task } = await run(vi.fn(), { modelClient: { next } });
    expect(next).toHaveBeenCalledTimes(2);
    expect(task.terminationCode).toBe("executionFailed");
    expect(task.resultMessage).toContain("重新验证密钥");
  });

  it("uses a separate provider system prompt for explanations", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.messages[0].content).toContain("当前任务已经失败");
      expect(body.messages[0].content).not.toContain("createChangeSetPreview");
      expect(JSON.parse(body.messages[1].content).tools).toEqual([]);
      return Response.json({ model: "test", choices: [{ message: { content: JSON.stringify(narration) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
    });
    const result = await new DeepSeekHarnessModel({ apiKey: "test", model: "test", fetchImpl: fetchImpl as typeof fetch }).next({ purpose: "failureExplanation", tools: [],
      context: { userGoal: "分析销售", failureFacts: "暂时没能得到结果。" }, iteration: 4, estimatedInputChars: 1000, signal: new AbortController().signal });
    expect(acceptableFailureExplanation(result.turn.message)).toBe(true);
  });
});
