import { harnessModelUsageSchema, type HarnessModelUsage } from "../contracts";

export interface AgentBudgetLimits {
  modelCalls: number;
  toolCalls: number;
  inputChars: number;
  requestChars: number;
  promptTokens: number;
  completionTokensPerCall: number;
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
    if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) {
      throw new AgentBudgetError("Agent 总预算必须为正整数。");
    }
  }

  assertAvailable() {
    if (this.exhausted) throw new AgentBudgetError("主任务共享预算已用尽，停止后续调用。");
  }

  reserveModel(chars: number, reserveCalls = 0) {
    this.assertAvailable();
    const prompt = Math.ceil(chars); // Conservative preflight; provider usage settles the reservation.
    const completion = this.limits.completionTokensPerCall;
    if (!Number.isSafeInteger(chars) || chars < 1 || chars > this.limits.requestChars
      || this.inputChars + chars > this.limits.inputChars
      || this.modelCalls + reserveCalls >= this.limits.modelCalls
      || this.usage.promptTokens + this.reservedPromptTokens + prompt > this.limits.promptTokens
      || this.usage.completionTokens + this.reservedCompletionTokens + completion
        > this.limits.modelCalls * completion) {
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
      if (this.usage.promptTokens > this.limits.promptTokens
        || usage.completionTokens > completion || usage.totalTokens !== usage.promptTokens + usage.completionTokens
        || this.usage.completionTokens > this.limits.modelCalls * completion) {
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
