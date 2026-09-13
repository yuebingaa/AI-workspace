import { describe, expect, it } from "vitest";
import { AgentBudget } from "./budget";

describe("shared agent budget", () => {
  const limits = { modelCalls: 4, toolCalls: 2, inputChars: 1_000, requestChars: 500, promptTokens: 500, completionTokensPerCall: 20 };
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
