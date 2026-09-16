import { describe, expect, it } from "vitest";
import { AgentBudget } from "./budget";

describe("shared agent budget", () => {
  const limits = { modelCalls: 4, toolCalls: 2, inputChars: 1_000, requestChars: 500, promptTokens: 500, completionTokensPerCall: 20 };
  it("unlimited model quotas keep usage accounting and independent tool protection", () => {
    const budget = new AgentBudget({ modelCalls: null, toolCalls: 2, inputChars: null, requestChars: null,
      promptTokens: null, completionTokensPerCall: null });
    for (let index = 0; index < 12; index += 1) {
      budget.reserveModel(30_000, 3)({ promptTokens: 20_000, completionTokens: 4_000, totalTokens: 24_000 });
    }
    expect(budget.modelCalls).toBe(12);
    expect(budget.inputChars).toBe(360_000);
    expect(budget.usage).toEqual({ promptTokens: 240_000, completionTokens: 48_000, totalTokens: 288_000 });
    budget.reserveTool(); budget.reserveTool();
    expect(() => budget.reserveTool()).toThrow(/工具调用预算/);
  });
  it("unlimited quotas do not accept inconsistent usage", () => {
    const budget = new AgentBudget({ modelCalls: null, toolCalls: 2, inputChars: null, requestChars: null,
      promptTokens: null, completionTokensPerCall: null });
    expect(() => budget.reserveModel(20_000)({ promptTokens: 30_000, completionTokens: 3_000, totalTokens: 1 }))
      .toThrow(/实际用量/);
    expect(() => budget.reserveTool()).toThrow(/预算/);
  });
  it("reserves in-flight inputs across workers and settles actual usage once", () => {
    const budget = new AgentBudget(limits);
    const settle = budget.reserveModel(300);
    expect(() => budget.reserveModel(201)).toThrow(/预算/);
    settle({ promptTokens: 40, completionTokens: 10, totalTokens: 50 });
    settle({ promptTokens: 40, completionTokens: 10, totalTokens: 50 });
    budget.reserveModel(300);
    expect(budget.modelCalls).toBe(2);
    expect(budget.usage.totalTokens).toBe(50);
  });
  it("charges unknown failures and makes actual overruns terminal", () => {
    const budget = new AgentBudget(limits);
    budget.reserveModel(200)();
    expect(budget.usage).toEqual({ promptTokens: 200, completionTokens: 20, totalTokens: 220 });
    const settle = budget.reserveModel(200);
    expect(() => settle({ promptTokens: 400, completionTokens: 10, totalTokens: 410 })).toThrow(/实际用量/);
    expect(() => budget.reserveTool()).toThrow(/预算/);
  });
});
