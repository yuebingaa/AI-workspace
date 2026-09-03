import { describe, expect, it } from "vitest";
import type { HarnessEvaluationCase, HarnessEvaluationHardGates } from "./contracts";
import { harnessEvaluationCaseSchema } from "./contracts";
import { harnessBaselineV1Cases } from "./fixtures/harness-baseline-v1";
import {
  exactToolSequence,
  scoreHarnessEvaluationCase,
  scoreToolSequence,
} from "./scoring";

function baseCase(): Extract<HarnessEvaluationCase, { kind: "harness" }> {
  const found = structuredClone(harnessBaselineV1Cases.find((item) => item.id === "dataset-summary"));
  if (!found || found.kind !== "harness") throw new Error("缺少数据集摘要评测用例");
  return found;
}

const passingGates: HarnessEvaluationHardGates = {
  formalAppSpecUnchanged: true,
  clientIdentityFieldsAcceptedCount: 0,
  invalidPendingChangeSetCount: 0,
  changeSetOperationMismatchCount: 0,
  writeTaskTerminalViolationCount: 0,
  canaryLeakCount: 0,
  passed: true,
};

function scores(
  evaluationCase: Extract<HarnessEvaluationCase, { kind: "harness" }>,
  actualTools: Array<"inspectDataset">,
) {
  return scoreHarnessEvaluationCase({
    evaluationCase,
    terminalStateMatches: true,
    actualTools,
    changeSetMatches: true,
    hardGates: passingGates,
    modelCalls: 1,
    toolCalls: actualTools.length,
    inputChars: 1,
    promptTokens: 1,
  });
}

describe("Harness 评测评分边界", () => {
  it("空 allowedToolSequences 表示不约束顺序，并可通过用例 Schema", () => {
    const evaluationCase = baseCase();
    evaluationCase.expected.allowedToolSequences = [];

    expect(harnessEvaluationCaseSchema.safeParse(evaluationCase).success).toBe(true);
    expect(exactToolSequence(["inspectDataset"], [])).toBe(true);
    expect(scoreToolSequence(["inspectDataset"], [])).toBe(1);
  });

  it("[[]] 只与空实际工具序列完全匹配", () => {
    expect(exactToolSequence([], [[]])).toBe(true);
    expect(scoreToolSequence([], [[]])).toBe(1);
    expect(exactToolSequence(["inspectDataset"], [[]])).toBe(false);
    expect(scoreToolSequence(["inspectDataset"], [[]])).toBe(0);
  });

  it("重复调用同一必需工具不会让 recall 或总分超过上限", () => {
    const evaluationCase = baseCase();
    evaluationCase.expected.allowedToolSequences = [["inspectDataset", "inspectDataset"]];
    const result = scores(evaluationCase, ["inspectDataset", "inspectDataset"]);

    expect(result.toolRecall).toBe(1);
    expect(result.total).toBeLessThanOrEqual(100);
  });

  it("空 requiredTools 与零工具调用产生有限评分", () => {
    const evaluationCase = baseCase();
    evaluationCase.expected.requiredTools = [];
    evaluationCase.expected.allowedToolSequences = [[]];
    const result = scores(evaluationCase, []);

    expect(result.toolRecall).toBe(1);
    expect(result.toolPrecision).toBe(1);
    expect(Object.values(result).every(Number.isFinite)).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(0);
    expect(result.total).toBeLessThanOrEqual(100);
  });
});
