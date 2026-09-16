import { DEFAULT_DEEPSEEK_MODEL } from "../contracts";
import type { HarnessRuntimeOptions } from "@/core/harness/runtime";
import { DeepSeekHarnessModel } from "./deepseek-harness-model";

export interface DeepSeekModelConfiguration {
  apiKey?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  requireProviderUsage?: boolean;
  providerPromptTokenLimit?: number;
}

/** Server composition only. Credentials never become part of the Harness request. */
export function configureDeepSeekHarness(options: HarnessRuntimeOptions & DeepSeekModelConfiguration): HarnessRuntimeOptions {
  const { apiKey, model, fetchImpl, requireProviderUsage, providerPromptTokenLimit, ...runtime } = options;
  return {
    ...runtime,
    allowFailureExplanation: runtime.allowFailureExplanation !== false && !requireProviderUsage && !providerPromptTokenLimit,
    createModelClient: runtime.createModelClient ?? (() => {
      const key = apiKey?.trim();
      return key ? new DeepSeekHarnessModel({
        apiKey: key, model: model?.trim() || DEFAULT_DEEPSEEK_MODEL, fetchImpl,
        maxCompletionTokens: runtime.modelMaxCompletionTokens,
        requireProviderUsage, promptTokenLimit: providerPromptTokenLimit,
      }) : null;
    }),
  };
}
