import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeDeepSeekApiKey } from "@/core/ai/server/runtime-credentials";
import { DELETE, GET, PATCH, POST } from "./route";

function mockModels() {
  const mock = vi.fn(async () => Response.json({
    object: "list",
    data: [
      { id: "deepseek-flash", object: "model", owned_by: "deepseek" },
      { id: "deepseek-v4-pro", object: "model", owned_by: "deepseek" },
    ],
  }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("AI settings route", () => {
  afterEach(() => {
    clearRuntimeDeepSeekApiKey();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("validates a same-origin key, discovers models, and never returns the secret", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-flash");
    const fetchMock = mockModels();
    const secret = "sk-private-test-value";
    const saved = await POST(new Request("http://localhost/api/settings/ai", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ apiKey: secret }),
    }));
    const payload = await saved.json();

    expect(saved.status).toBe(200);
    expect(payload).toEqual({
      configured: true,
      source: "runtime",
      model: "deepseek-flash",
      modelSource: "runtime",
      availableModels: [
        { id: "deepseek-flash", ownedBy: "deepseek" },
        { id: "deepseek-v4-pro", ownedBy: "deepseek" },
      ],
      modelsDiscovered: true,
      persistence: "process-memory",
    });
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(await (await GET()).json()).toEqual(payload);
    expect(fetchMock).toHaveBeenCalledWith("https://api.deepseek.com/models", expect.objectContaining({
      method: "GET",
      headers: expect.objectContaining({ authorization: `Bearer ${secret}` }),
    }));
  });

  it("rejects cross-origin writes", async () => {
    const result = await POST(new Request("http://localhost/api/settings/ai", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.invalid" },
      body: JSON.stringify({ apiKey: "sk-attacker-value" }),
    }));

    expect(result.status).toBe(403);
  });

  it("clears only the runtime override and reports an environment fallback", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "environment-secret-key");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-flash");
    mockModels();
    await POST(new Request("http://localhost/api/settings/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "runtime-secret-key" }),
    }));
    const cleared = await DELETE(new Request("http://localhost/api/settings/ai", { method: "DELETE" }));

    expect(await cleared.json()).toEqual({
      configured: true,
      source: "environment",
      model: "deepseek-v4-flash",
      modelSource: "environment",
      availableModels: [],
      modelsDiscovered: false,
      persistence: "process-memory",
    });
  });

  it("lets the user select only a model returned by discovery", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-flash");
    mockModels();
    await POST(new Request("http://localhost/api/settings/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "runtime-secret-key" }),
    }));

    const selected = await PATCH(new Request("http://localhost/api/settings/ai", {
      method: "PATCH",
      headers: { "content-type": "application/json", origin: "http://localhost" },
      body: JSON.stringify({ model: "deepseek-v4-pro" }),
    }));
    expect(selected.status).toBe(200);
    expect(await selected.json()).toMatchObject({ model: "deepseek-v4-pro", modelSource: "runtime" });

    const rejected = await PATCH(new Request("http://localhost/api/settings/ai", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "invented-model" }),
    }));
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({ error: { message: "所选模型不在本次 API 识别结果中，请重新识别模型。" } });
  });

  it("does not save a rejected API key", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-flash");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const result = await POST(new Request("http://localhost/api/settings/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey: "rejected-secret-key" }),
    }));

    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: { message: "DeepSeek API Key 无效。" } });
    expect(await (await GET()).json()).toMatchObject({ configured: false, source: "none", modelsDiscovered: false });
  });
});
