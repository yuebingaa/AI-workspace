import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_AI_REQUEST_BYTES } from "@/core/ai/contracts";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { POST } from "./route";

describe("AI Planner 服务端身份边界", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns 408, cancels a stalled request body once, and skips the model", async () => {
    const modelFetch = vi.fn<typeof fetch>();
    const cancel = vi.fn();
    const controller = new AbortController();
    vi.stubGlobal("fetch", modelFetch);
    const request = new Request("http://localhost/api/ai/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>({ cancel }),
      duplex: "half",
      signal: controller.signal,
    } as RequestInit & { duplex: "half" });

    const responsePromise = POST(request);
    controller.abort();
    const response = await responsePromise;

    expect(response.status).toBe(408);
    expect(await response.json()).toMatchObject({ error: { code: "invalid_request", retryable: true } });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(modelFetch).not.toHaveBeenCalled();
  });

  it("strict 公共请求拒绝客户端 role、tenantId、ownerId 和 userId", async () => {
    if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
    const response = await POST(new Request("http://localhost/api/ai/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        instruction: "修改标题",
        pageId: "page_home",
        appSpec: demoFixtureResult.data.dataProduct.appSpec,
        role: "admin",
        tenantId: "fake_tenant",
        ownerId: "fake_owner",
        userId: "fake_user",
      }),
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "invalid_request", retryable: false },
    });
  });

  it("按实际流大小拒绝伪报短长度的请求且不调用模型", async () => {
    const modelFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", modelFetch);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_AI_REQUEST_BYTES));
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });
    const response = await POST(new Request("http://localhost/api/ai/plan", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1" },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" }));

    expect(response.status).toBe(413);
    expect(modelFetch).toHaveBeenCalledTimes(0);
  });

  it("拒绝可绕过跨源预检的非 JSON 请求", async () => {
    const modelFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", modelFetch);
    const response = await POST(new Request("http://localhost/api/ai/plan", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    }));

    expect(response.status).toBe(415);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(modelFetch).toHaveBeenCalledTimes(0);
  });
});
