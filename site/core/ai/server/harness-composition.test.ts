import { describe, expect, it, vi } from "vitest";
import { configureDeepSeekHarness } from "./harness-composition";
import { DeepSeekHarnessModel, DeepSeekProviderProtocolError } from "./deepseek-harness-model";
import { HarnessModelProtocolError } from "@/core/harness/model-errors";

describe("server model composition", () => {
  it("keeps credentials/configuration in a lazy closure, not execution options", () => {
    const fetchImpl = vi.fn<typeof fetch>(() => { throw new Error("Unexpected model request"); });
    const options = configureDeepSeekHarness({ dataRuntime: { rowsByDataSourceId: {} }, apiKey: "test-placeholder",
      model: "test-model", fetchImpl, requireProviderUsage: true, providerPromptTokenLimit: 1000 });
    expect(options.allowFailureExplanation).toBe(false);
    for (const key of ["apiKey", "model", "fetchImpl", "requireProviderUsage", "providerPromptTokenLimit"]) expect(options).not.toHaveProperty(key);
    expect(options.createModelClient?.()).toBeInstanceOf(DeepSeekHarnessModel);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("preserves missing-configuration and lazy validation behavior", () => {
    expect(configureDeepSeekHarness({ dataRuntime: { rowsByDataSourceId: {} }, apiKey: "  " }).createModelClient?.()).toBeNull();
    const options = configureDeepSeekHarness({ dataRuntime: { rowsByDataSourceId: {} }, apiKey: "test-placeholder", requireProviderUsage: false });
    expect(() => options.createModelClient?.()).toThrow("用量校验不能关闭");
  });

  it("retains the legacy error identity while allowing provider-independent fatal handling", () => {
    const error = new DeepSeekProviderProtocolError();
    expect(error).toBeInstanceOf(HarnessModelProtocolError);
    expect(error.name).toBe("DeepSeekProviderProtocolError");
    expect(error.code).toBe("provider_model_mismatch");
  });
});
