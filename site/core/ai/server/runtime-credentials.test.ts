import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeDeepSeekApiKey,
  deepSeekCredentialStatus,
  deepSeekSettingsStatus,
  normalizeDeepSeekApiKey,
  resolveDeepSeekApiKey,
  resolveDeepSeekModel,
  setRuntimeDeepSeekDiscovery,
  setRuntimeDeepSeekApiKey,
  setRuntimeDeepSeekModel,
} from "./runtime-credentials";

describe("runtime AI credentials", () => {
  afterEach(() => {
    clearRuntimeDeepSeekApiKey();
    vi.unstubAllEnvs();
  });

  it("keeps a runtime key server-side and never needs to expose it in status", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "environment-secret-key");
    setRuntimeDeepSeekApiKey("runtime-secret-key");

    expect(resolveDeepSeekApiKey()).toBe("runtime-secret-key");
    expect(deepSeekCredentialStatus()).toEqual({ configured: true, source: "runtime" });
  });

  it("falls back to the environment key after the runtime override is cleared", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "environment-secret-key");
    setRuntimeDeepSeekApiKey("runtime-secret-key");
    clearRuntimeDeepSeekApiKey();

    expect(resolveDeepSeekApiKey()).toBe("environment-secret-key");
    expect(deepSeekCredentialStatus()).toEqual({ configured: true, source: "environment" });
  });

  it.each(["", "short", "contains space", `line\nbreak-secret`])("rejects invalid key %j", (value) => {
    expect(() => normalizeDeepSeekApiKey(value)).toThrow();
  });

  it("stores discovered models and lets the user select one for the current process", () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    vi.stubEnv("DEEPSEEK_MODEL", "deepseek-v4-flash");
    setRuntimeDeepSeekDiscovery([
      { id: "deepseek-v4-flash", ownedBy: "deepseek" },
      { id: "deepseek-v4-pro", ownedBy: "deepseek" },
    ], { apiKey: "runtime-secret-key" });

    expect(resolveDeepSeekModel()).toBe("deepseek-v4-flash");
    setRuntimeDeepSeekModel("deepseek-v4-pro");
    expect(resolveDeepSeekModel()).toBe("deepseek-v4-pro");
    expect(deepSeekSettingsStatus()).toMatchObject({
      configured: true,
      source: "runtime",
      model: "deepseek-v4-pro",
      modelSource: "runtime",
      modelsDiscovered: true,
      availableModels: [
        { id: "deepseek-v4-flash", ownedBy: "deepseek" },
        { id: "deepseek-v4-pro", ownedBy: "deepseek" },
      ],
    });
  });

  it("rejects a model that was not returned by the API", () => {
    setRuntimeDeepSeekDiscovery([{ id: "deepseek-v4-flash", ownedBy: "deepseek" }], { apiKey: "runtime-secret-key" });
    expect(() => setRuntimeDeepSeekModel("invented-model")).toThrow("不在本次 API 识别结果中");
  });
});
