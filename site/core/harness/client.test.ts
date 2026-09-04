import { describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { HARNESS_CLIENT_TIMEOUT_MS } from "./contracts";
import { createHarnessTask } from "./task-state";
import { HarnessClientError, MAX_HARNESS_RESPONSE_BYTES, requestHarnessTask } from "./client";

function request() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return {
    idempotencyKey: "request_client_test",
    instruction: "检查数据",
    pageId: "page_home",
    appSpec: demoFixtureResult.data.dataProduct.appSpec,
    recipes: demoFixtureResult.data.dataProduct.recipes,
  };
}

describe("Harness 客户端", () => {
  it("校验服务端任务响应", async () => {
    const task = createHarnessTask("request_client_test", "检查数据", "page_home", "editor", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      id: () => "event_client",
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ task }), { status: 200 }));
    await expect(requestHarnessTask(request(), { fetchImpl })).resolves.toEqual({ task });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("role");
    expect(body).not.toHaveProperty("tenantId");
    expect(body).not.toHaveProperty("ownerId");
    expect(body).not.toHaveProperty("userId");
  });

  it("支持取消且不会自动重试", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const promise = requestHarnessTask(request(), { fetchImpl: fetchImpl as typeof fetch, signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "cancelled" } satisfies Partial<HarnessClientError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("客户端超时覆盖收到响应头后的 Harness 正文读取", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    })));
    await expect(requestHarnessTask(request(), { fetchImpl, timeoutMs: 1 })).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    } satisfies Partial<HarnessClientError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("调用前已取消时不发送请求", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>();
    controller.abort();
    await expect(requestHarnessTask(request(), { fetchImpl, signal: controller.signal }))
      .rejects.toMatchObject({ code: "cancelled" } satisfies Partial<HarnessClientError>);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("客户端超时只能收紧且超限配置不发送请求", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(requestHarnessTask(request(), { fetchImpl, timeoutMs: HARNESS_CLIENT_TIMEOUT_MS + 1 }))
      .rejects.toMatchObject({ code: "service_error", retryable: false } satisfies Partial<HarnessClientError>);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("在 Schema 校验前拒绝异常大的 Harness 响应", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(MAX_HARNESS_RESPONSE_BYTES + 1) },
    }));
    await expect(requestHarnessTask(request(), { fetchImpl })).rejects.toMatchObject({
      code: "invalid_response",
      retryable: true,
    } satisfies Partial<HarnessClientError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
