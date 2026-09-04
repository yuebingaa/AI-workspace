import { describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { AiPlanPublicRequest } from "./contracts";
import { AI_PLAN_CLIENT_TIMEOUT_MS, AiPlanClientError, MAX_AI_PLAN_RESPONSE_BYTES, requestAiPlan } from "./client";

function request(): AiPlanPublicRequest {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return {
    instruction: "修改指标标题",
    pageId: "page_home",
    appSpec: structuredClone(demoFixtureResult.data.dataProduct.appSpec),
  };
}

function abortingFetch() {
  return vi.fn<typeof fetch>((_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }));
}

describe("AI 规划客户端", () => {
  it("客户端超时显示可重试中文错误", async () => {
    await expect(requestAiPlan(request(), { fetchImpl: abortingFetch(), timeoutMs: 1 })).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    } satisfies Partial<AiPlanClientError>);
  });

  it("客户端超时覆盖收到响应头后的 AI 正文读取", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    })));
    await expect(requestAiPlan(request(), { fetchImpl, timeoutMs: 1 })).rejects.toMatchObject({
      code: "timeout",
      retryable: true,
    } satisfies Partial<AiPlanClientError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("用户取消请求时区分取消状态", async () => {
    const controller = new AbortController();
    const promise = requestAiPlan(request(), { fetchImpl: abortingFetch(), signal: controller.signal });
    controller.abort();
    await expect(promise).rejects.toMatchObject({ code: "cancelled" } satisfies Partial<AiPlanClientError>);
  });

  it("调用前已取消时不发送请求", async () => {
    const controller = new AbortController();
    const fetchImpl = abortingFetch();
    controller.abort();
    await expect(requestAiPlan(request(), { fetchImpl, signal: controller.signal }))
      .rejects.toMatchObject({ code: "cancelled" } satisfies Partial<AiPlanClientError>);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("客户端超时只能收紧且超限配置不发送请求", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(requestAiPlan(request(), { fetchImpl, timeoutMs: AI_PLAN_CLIENT_TIMEOUT_MS + 1 }))
      .rejects.toMatchObject({ code: "service_error", retryable: false } satisfies Partial<AiPlanClientError>);
    expect(fetchImpl).toHaveBeenCalledTimes(0);
  });

  it("服务端中文错误被安全转换而不渲染原始响应", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { code: "not_configured", message: "AI 服务尚未配置。", retryable: false },
    }), { status: 503, headers: { "content-type": "application/json" } }));
    await expect(requestAiPlan(request(), { fetchImpl })).rejects.toMatchObject({
      code: "service_error",
      message: "AI 服务尚未配置。",
      retryable: false,
    } satisfies Partial<AiPlanClientError>);
    const body = JSON.parse(String(fetchImpl.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty("role");
    expect(body).not.toHaveProperty("tenantId");
    expect(body).not.toHaveProperty("ownerId");
    expect(body).not.toHaveProperty("userId");
  });

  it("在 Schema 校验前拒绝异常大的 AI 响应", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", {
      status: 200,
      headers: { "content-length": String(MAX_AI_PLAN_RESPONSE_BYTES + 1) },
    }));
    await expect(requestAiPlan(request(), { fetchImpl })).rejects.toMatchObject({
      code: "invalid_response",
      retryable: true,
    } satisfies Partial<AiPlanClientError>);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
