/** Legacy server entry. New orchestration uses HarnessRuntime and explicit composition. */
import { HarnessRuntime, type HarnessRuntimeOptions } from "./runtime";
import { configureDeepSeekHarness, type DeepSeekModelConfiguration } from "@/core/ai/server/harness-composition";

export { DeepSeekHarnessModel, DeepSeekProviderProtocolError } from "@/core/ai/server/deepseek-harness-model";
export { HarnessModelFormatError } from "./model-errors";
export { DEFAULT_HARNESS_BOUNDS, MAX_HARNESS_TOOL_ARGUMENT_REPAIRS, MAX_HARNESS_TOOL_RECOVERY_ATTEMPTS, MAX_HARNESS_IDENTICAL_TOOL_FAILURES, MAX_HARNESS_VERIFIER_REPLANS, MAX_HARNESS_MODEL_FORMAT_REPAIRS, MAX_HARNESS_MODEL_POLICY_REPAIRS, HarnessRequestError, HarnessIdempotencyConflictError, HARNESS_HARD_BOUNDS, HarnessIdempotencyCapacityError, resolvedBounds, HarnessIdempotencyStore } from "./runtime";
export type { HarnessBounds } from "./runtime";

export interface DeepSeekHarnessOptions extends HarnessRuntimeOptions, DeepSeekModelConfiguration {}

export class DeepSeekHarness extends HarnessRuntime {
  override run(request: unknown, options: DeepSeekHarnessOptions) {
    return super.run(request, configureDeepSeekHarness(options));
  }
}
