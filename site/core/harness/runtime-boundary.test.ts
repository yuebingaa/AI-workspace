import { afterEach, describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { HarnessRuntime } from "./runtime";
import { HarnessModelProtocolError } from "./model-errors";
import { executeHarnessTool } from "./tool-registry";
import type { HarnessModel, HarnessRequest, HarnessTraceEvent } from "./contracts";

// Importing/running the execution core must not initialize a provider adapter.
vi.mock("@/core/ai/server/deepseek-harness-model", () => { throw new Error("Provider adapter leaked into HarnessRuntime"); });
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
  const { dataProduct, dataRuntime } = structuredClone(demoFixtureResult.data);
  const request: HarnessRequest = { idempotencyKey: "runtime_boundary_test", instruction: "检查 retail_orders 数据集的概况",
    pageId: "page_home", role: "editor", appSpec: dataProduct.appSpec, recipes: dataProduct.recipes };
  return { request, dataRuntime };
}

function model(): HarnessModel {
  let calls = 0;
  return { next: vi.fn(async () => ({ model: "replacement-model", usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    turn: calls++ === 0
      ? { type: "callTool" as const, name: "inspectDataset", toolCallId: "replacement_read", arguments: { dataSourceId: "dataset_retail_orders" }, message: "读取数据概况" }
      : { type: "complete" as const, message: "已读取零售数据集概况，可继续核对字段。" } })) };
}

describe("provider-independent Harness contract", () => {
  it("executes a real tool with an injected model, verifies it, and preserves the formal page", async () => {
    const { request, dataRuntime } = fixture();
    const original = structuredClone(request.appSpec);
    const client = model();
    const factory = vi.fn(() => { throw new Error("Injected client must take precedence"); });
    const network = vi.fn(() => { throw new Error("Unexpected network call"); });
    vi.stubGlobal("fetch", network);
    const toolExecutor = vi.fn(executeHarnessTool);
    const trace: HarnessTraceEvent[] = [];
    const task = await new HarnessRuntime().run(request, { dataRuntime, modelClient: client, createModelClient: factory,
      toolExecutor, onEvent: (event) => trace.push(event) });
    expect(task.state, task.error).toBe("completed");
    expect(task.model).toBe("replacement-model");
    expect(task.verification?.status).toBe("passed");
    expect(toolExecutor).toHaveBeenCalledTimes(1);
    expect(client.next).toHaveBeenCalledTimes(2);
    expect(factory).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
    expect(request.appSpec).toEqual(original);
    expect(trace.map((event) => event.type)).toEqual(expect.arrayContaining(["task_started", "context_loaded", "tool_started", "tool_completed", "verification_completed"]));
    expect(task.trace?.filter((event) => event.type === "completed")).toHaveLength(1);
  });

  it("resolves a lazy model once and only after validating the request", async () => {
    const { request, dataRuntime } = fixture();
    const factory = vi.fn(model);
    const runtime = new HarnessRuntime();
    await expect(runtime.run({}, { dataRuntime, createModelClient: factory })).rejects.toThrow("请求格式");
    expect(factory).not.toHaveBeenCalled();
    expect((await runtime.run(request, { dataRuntime, createModelClient: factory })).state).toBe("completed");
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("treats another provider's protocol mismatch as fatal instead of falling back to rules", async () => {
    const { request, dataRuntime } = fixture();
    const client = model();
    client.classifyIntent = vi.fn(async () => { throw new HarnessModelProtocolError("Configured model mismatch"); });
    const toolExecutor = vi.fn(executeHarnessTool);
    const task = await new HarnessRuntime().run(request, { dataRuntime, modelClient: client, toolExecutor });
    expect(task.state).toBe("failed");
    expect(task.terminationCode).toBe("protocolViolation");
    expect(toolExecutor).not.toHaveBeenCalled();
    expect(client.next).not.toHaveBeenCalled();
  });
});
