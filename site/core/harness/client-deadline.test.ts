import { afterEach, describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { requestHarnessTask } from "./client";
import { HARNESS_MAX_STREAM_CLIENT_TIMEOUT_MS, type HarnessTraceEvent } from "./contracts";
import { encodeHarnessFrame, HARNESS_SSE_HEADERS } from "./stream";

afterEach(() => vi.useRealTimers());

function fixture() {
  if (!demoFixtureResult.success) throw new Error("Missing synthetic fixture");
  const input = { idempotencyKey: "deadline_test", instruction: "测试截止时间", pageId: "page_home",
    appSpec: demoFixtureResult.data.dataProduct.appSpec, recipes: demoFixtureResult.data.dataProduct.recipes };
  let writer: ReadableStreamDefaultController<Uint8Array>;
  let signal: AbortSignal | null | undefined;
  const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => {
    signal = init?.signal;
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } }), { headers: HARNESS_SSE_HEADERS });
  });
  let sequence = 0;
  const send = (details: Partial<HarnessTraceEvent> = {}) => {
    const next = sequence + 1;
    const encoded = encodeHarnessFrame({ id: `deadline_${next}`, sequence: next,
      taskId: `harness_${input.idempotencyKey}`, timestamp: new Date().toISOString(), type: "task_started",
      message: "正在执行", ...details });
    sequence = next;
    writer.enqueue(new TextEncoder().encode(encoded));
  };
  return { input, fetchImpl, send, aborted: () => signal?.aborted };
}

describe("服务端执行器截止时间协商", () => {
  it("有效开始事件将默认SSE等待扩到185秒，重复事件不延后原请求截止点", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = requestHarnessTask(f.input, { fetchImpl: f.fetchImpl, stream: true });
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(5000);
    f.send({ clientTimeoutMs: HARNESS_MAX_STREAM_CLIENT_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(90_001);
    expect(f.aborted()).toBe(false);
    f.send({ clientTimeoutMs: HARNESS_MAX_STREAM_CLIENT_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(89_999);
    await assertion;
    expect(f.aborted()).toBe(true);
    expect(f.fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([undefined, 100])("没有时间元数据或显式收紧时仍按原预算中止：%s", async timeoutMs => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = requestHarnessTask(f.input, { fetchImpl: f.fetchImpl, stream: true, timeoutMs });
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(1);
    f.send(timeoutMs ? { clientTimeoutMs: HARNESS_MAX_STREAM_CLIENT_TIMEOUT_MS } : {});
    await vi.advanceTimersByTimeAsync(timeoutMs ?? 95_000);
    await assertion;
    expect(f.aborted()).toBe(true);
  });

  it("其他类型事件不能扩展默认截止时间，非法上限不进入协议", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = requestHarnessTask(f.input, { fetchImpl: f.fetchImpl, stream: true });
    const assertion = expect(pending).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(1);
    expect(() => f.send({ clientTimeoutMs: HARNESS_MAX_STREAM_CLIENT_TIMEOUT_MS + 1 })).toThrow();
    f.send({ type: "status_update", clientTimeoutMs: HARNESS_MAX_STREAM_CLIENT_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(95_000);
    await assertion;
  });

  it("任务ID不匹配拒绝事件，取消仍立即停止扩展后的请求", async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = requestHarnessTask(f.input, { fetchImpl: f.fetchImpl, stream: true });
    const assertion = expect(pending).rejects.toMatchObject({ code: "invalid_response" });
    await vi.advanceTimersByTimeAsync(1);
    f.send({ taskId: "harness_another_task", clientTimeoutMs: HARNESS_MAX_STREAM_CLIENT_TIMEOUT_MS });
    await assertion;
    const g = fixture(), cancel = new AbortController();
    const second = requestHarnessTask(g.input, { fetchImpl: g.fetchImpl, stream: true, signal: cancel.signal });
    const cancelled = expect(second).rejects.toMatchObject({ code: "cancelled" });
    await vi.advanceTimersByTimeAsync(1);
    g.send({ clientTimeoutMs: HARNESS_MAX_STREAM_CLIENT_TIMEOUT_MS });
    await vi.advanceTimersByTimeAsync(1);
    cancel.abort();
    await cancelled;
    expect(g.aborted()).toBe(true);
  });
});
