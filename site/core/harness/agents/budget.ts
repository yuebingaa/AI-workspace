import { harnessModelUsageSchema, type HarnessModelUsage } from "../contracts";
import { withinModelLimit, type HarnessModelLimit } from "../model-limits";

export interface AgentBudgetLimits {
  modelCalls: HarnessModelLimit;
  toolCalls: number;
  inputChars: HarnessModelLimit;
  requestChars: HarnessModelLimit;
  promptTokens: HarnessModelLimit;
  completionTokensPerCall: HarnessModelLimit;
}

export class AgentBudgetError extends Error {}

/** One ledger for the root and child, including failed and in-flight attempts. */
export class AgentBudget {
  modelCalls = 0;
  toolCalls = 0;
  inputChars = 0;
  usage: HarnessModelUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private reservedPromptTokens = 0;
  private reservedCompletionTokens = 0;
  private exhausted = false;

  constructor(readonly limits: AgentBudgetLimits) {
    if (Object.entries(limits).some(([name, value]) => value === null
      ? name === "toolCalls" : !Number.isSafeInteger(value) || value < 1)) {
      throw new AgentBudgetError("Agent 总预算必须为正整数，模型额度可为 null。");
    }
  }

  assertAvailable() {
    if (this.exhausted) throw new AgentBudgetError("主任务共享预算已用尽，停止后续调用。");
  }

  reserveModel(chars: number, reserveCalls = 0) {
    this.assertAvailable();
    const prompt = Math.ceil(chars); // Conservative preflight; provider usage settles the reservation.
    // With no output quota an unknown failure cannot report a known output size.
    const completion = this.limits.completionTokensPerCall ?? 0;
    const totalCompletionLimit = this.limits.modelCalls !== null && this.limits.completionTokensPerCall !== null
      ? this.limits.modelCalls * this.limits.completionTokensPerCall : null;
    if (!Number.isSafeInteger(chars) || chars < 1 || !withinModelLimit(chars, this.limits.requestChars)
      || !withinModelLimit(this.inputChars + chars, this.limits.inputChars)
      || !withinModelLimit(this.modelCalls + reserveCalls + 1, this.limits.modelCalls)
      || !withinModelLimit(this.usage.promptTokens + this.reservedPromptTokens + prompt, this.limits.promptTokens)
      || !withinModelLimit(this.usage.completionTokens + this.reservedCompletionTokens + completion, totalCompletionLimit)) {
      throw new AgentBudgetError("主任务共享模型 / 上下文预算不足，未启动下一次调用。");
    }
    this.modelCalls += 1;
    this.inputChars += chars;
    this.reservedPromptTokens += prompt;
    this.reservedCompletionTokens += completion;
    let settled = false;
    return (actual?: HarnessModelUsage) => {
      if (settled) return;
      settled = true;
      this.reservedPromptTokens -= prompt;
      this.reservedCompletionTokens -= completion;
      const parsed = harnessModelUsageSchema.safeParse(actual);
      const usage = parsed.success ? parsed.data : { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
      this.usage = {
        promptTokens: this.usage.promptTokens + usage.promptTokens,
        completionTokens: this.usage.completionTokens + usage.completionTokens,
        totalTokens: this.usage.totalTokens + usage.totalTokens,
      };
      if (!withinModelLimit(this.usage.promptTokens, this.limits.promptTokens)
        || !withinModelLimit(usage.completionTokens, this.limits.completionTokensPerCall)
        || usage.totalTokens !== usage.promptTokens + usage.completionTokens
        || !withinModelLimit(this.usage.completionTokens, totalCompletionLimit)) {
        this.exhausted = true;
        throw new AgentBudgetError("模型实际用量超过主任务共享预算，结果未被接受。");
      }
    };
  }

  reserveTool() {
    this.assertAvailable();
    if (this.toolCalls >= this.limits.toolCalls) throw new AgentBudgetError("主任务共享工具调用预算已用尽。");
    this.toolCalls += 1;
  }
}
