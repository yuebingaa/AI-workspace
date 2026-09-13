import { describe, it, expect, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { createHarnessTask } from "./task-state";
import { createHarnessStreamResponse, encodeHarnessFrame, HARNESS_SSE_HEADERS, readHarnessStream } from "./stream";
import { DeepSeekHarness, HarnessIdempotencyStore } from "./deepseek-harness";
import { type HarnessRequest, type HarnessTraceEvent, type HarnessModel } from "./contracts";
import { requestHarnessTask } from "./client";
import { executeHarnessTool } from "./tool-registry";

const clock = { now: () => new Date("2026-09-09T00:00:00.000Z"), id: () => "event_stream_test" };
function fixture() {
  if (!demoFixtureResult.success) throw new Error("Missing fixtures");
  const input: HarnessRequest = { idempotencyKey: "stream_test_request", instruction: "你能做什么？", pageId: "page_home", role: "editor",
    appSpec: demoFixtureResult.data.dataProduct.appSpec, recipes: demoFixtureResult.data.dataProduct.recipes };
  const task = { ...createHarnessTask(input.idempotencyKey, input.instruction, input.pageId, input.role, clock), state: "completed" as const, resultMessage: "可以分析已授权的数据。" };
  const event = (sequence: number, type: HarnessTraceEvent["type"] = "context_loaded"): HarnessTraceEvent => ({
    id: `${task.id}:${sequence}`, sequence, type, taskId: task.id, timestamp: clock.now().toISOString(), message: "已加载中文上下文", ...(type === "completed" ? { taskState: task.state } : {}),
  });
  return { input, task, event, dataRuntime: demoFixtureResult.data.dataRuntime };
}
const signal = () => new AbortController().signal;
function response(text: string, size = 1) {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream({ start(controller) {
    for (let index = 0; index < bytes.length; index += size) controller.enqueue(bytes.slice(index, index + size));
    controller.close();
  } }), { headers: HARNESS_SSE_HEADERS });
}

describe("Harness SSE transport", () => {
  it("tool_started precedes tool execution and tool_completed follows its real result", async () => {
    const { input, dataRuntime } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const events: HarnessTraceEvent[] = [];
    let call = 0;
    const model: HarnessModel = { next: async () => ({ turn: call++ === 0
      ? { type: "callTool", name: "inspectDataset", toolCallId: "actual_tool_test", arguments: { dataSourceId: "dataset_retail_orders" }, message: "检查数据概况" }
      : { type: "complete", message: "已检查数据概况，详情见工具证据。" },
      model: "offline", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }) };
    const execution = new DeepSeekHarness().run({ ...input, instruction: "检查 retail_orders 数据集的概况" }, {
      dataRuntime, modelClient: model, onEvent: (event) => events.push(event),
      toolExecutor: async (...args) => {
        expect(events.at(-1)?.type).toBe("tool_started");
        await gate;
        return executeHarnessTool(...args);
      },
    });
    await vi.waitFor(() => expect(events.some((event) => event.type === "tool_started")).toBe(true));
    expect(events.some((event) => event.type === "tool_completed")).toBe(false);
    release();
    await execution;
    expect(events.some((event) => event.type === "tool_completed" && event.toolCall?.id === "actual_tool_test")).toBe(true);
    expect(JSON.stringify(events)).not.toContain('"rows":');
  });
  it("parses split UTF-8, CRLF, comments and validates the terminal task", async () => {
    const { task, event } = fixture();
    const events: HarnessTraceEvent[] = [];
    const text = ": heartbeat\n\n" + encodeHarnessFrame(event(1)) + encodeHarnessFrame(event(2, "completed"), task);
    expect(await readHarnessStream(response(text.replaceAll("\n", "\r\n")), signal(), (item) => events.push(item))).toEqual({ task });
    expect(events.map((item) => item.sequence)).toEqual([1, 2]);
  });
  it("does not accept truncation, out-of-order events, mixed tasks or malformed frames", async () => {
    const { event } = fixture();
    for (const text of [encodeHarnessFrame(event(1)), encodeHarnessFrame(event(2)),
      encodeHarnessFrame(event(1)) + encodeHarnessFrame({ ...event(2), taskId: "other_task" }),
      'event: completed\ndata: {"unverified": true}\n\n']) {
      await expect(readHarnessStream(response(text, 1_024), signal())).rejects.toThrow();
    }
  });
  it("sends actual runtime progress before the model finishes; final answer waits for verification", async () => {
    const { input, dataRuntime } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const model: HarnessModel = { next: async () => { await gate; return {
      turn: { type: "complete", message: "可以分析已授权的数据。" }, model: "offline", usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    }; } };
    const events: HarnessTraceEvent[] = [];
    let finished = false;
    const streamed = createHarnessStreamResponse(signal(), (abortSignal, emit) => new DeepSeekHarness().run(input, { dataRuntime, modelClient: model, signal: abortSignal, onEvent: emit }));
    const result = readHarnessStream(streamed, signal(), (event) => events.push(event)).then((value) => { finished = true; return value; });
    await vi.waitFor(() => expect(events.some((event) => event.type === "plan_created")).toBe(true));
    expect(finished).toBe(false);
    expect(events.some((event) => event.type === "completed" || event.type === "answer_delta")).toBe(false);
    release();
    const { task } = await result;
    expect(task.state).toBe("completed");
    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(["task_started", "context_loaded", "verification_started", "verification_completed", "completed"]));
    expect(task.trace?.at(-1)?.type).toBe("completed");
  });
  it("replays events and shares one execution for a repeated idempotency key", async () => {
    const { input, task, event } = fixture();
    const store = new HarnessIdempotencyStore();
    let emit!: (item: HarnessTraceEvent) => void;
    let finish!: (value: typeof task) => void;
    const factory = vi.fn((publish: typeof emit) => { emit = publish; emit(event(1)); return new Promise<typeof task>((resolve) => { finish = resolve; }); });
    const first: HarnessTraceEvent[] = [], second: HarnessTraceEvent[] = [];
    const a = store.execute(input, factory, "owner", (item) => first.push(item));
    const b = store.execute(input, factory, "owner", (item) => second.push(item));
    emit(event(2));
    finish(task);
    await Promise.all([a, b]);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    const replay: HarnessTraceEvent[] = [];
    await store.execute(input, factory, "owner", (item) => replay.push(item));
    expect(replay).toEqual(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });
  it("cancels owned execution on disconnect and does not retry a truncated stream", async () => {
    let aborted = false;
    const stream = createHarnessStreamResponse(signal(), (abortSignal) => new Promise((_resolve, reject) => {
      abortSignal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); });
    }));
    const reader = stream.body!.getReader();
    await reader.read();
    await reader.cancel();
    await vi.waitFor(() => expect(aborted).toBe(true));
    const { input, event } = fixture();
    const fetchImpl = vi.fn<typeof fetch>(async () => response(encodeHarnessFrame(event(1)), 512));
    await expect(requestHarnessTask(input, { stream: true, fetchImpl })).rejects.toMatchObject({ code: "invalid_response" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("client AbortSignal interrupts even a stalled response body", async () => {
    const abort = new AbortController();
    const cancel = vi.fn();
    const read = readHarnessStream(new Response(new ReadableStream({ cancel }), { headers: HARNESS_SSE_HEADERS }), abort.signal);
    abort.abort();
    await expect(read).rejects.toThrow("取消");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
