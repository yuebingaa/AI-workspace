import { describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { createHarnessTask } from "./task-state";
import { HarnessClientError, requestHarnessTask } from "./client";

function request() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return {
    idempotencyKey: "request_client_test",
    instruction: "检查数据",
    pageId: "page_home",
    appSpec: demoFixtureResult.data.dataProduct.appSpec,
    recipes: demoFixtureResult.data.dataProduct.recipes,
    role: "editor" as const,
  };
}

describe("Harness 客户端", () => {
  it("校验服务端任务响应", async () => {
    const task = createHarnessTask("request_client_test", "检查数据", "page_home", "editor", {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
      id: () => "event_client",
    });
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ task }), { status: 200 }));
    await expect(requestHarnessTask(request(), { fetchImpl })).resolves.toEqual({ task });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
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
});
