import type {
  HarnessEvaluationCase,
  HarnessEvaluationHardGates,
  HarnessEvaluationScores,
} from "./contracts";
import type { HarnessToolName } from "@/core/harness/contracts";

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} 必须是有限数字。`);
  return Math.min(maximum, Math.max(minimum, value));
}

function ratio(numerator: number, denominator: number): number {
  if (denominator === 0) return 1;
  return bounded(numerator / denominator, 0, 1, "评分比率");
}

function occurrences(values: readonly HarnessToolName[]): Map<HarnessToolName, number> {
  const counts = new Map<HarnessToolName, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function longestCommonSubsequence(left: readonly string[], right: readonly string[]): number {
  const rows = Array.from({ length: left.length + 1 }, () => Array<number>(right.length + 1).fill(0));
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      rows[leftIndex][rightIndex] = left[leftIndex - 1] === right[rightIndex - 1]
        ? rows[leftIndex - 1][rightIndex - 1] + 1
        : Math.max(rows[leftIndex - 1][rightIndex], rows[leftIndex][rightIndex - 1]);
    }
  }
  return rows[left.length][right.length];
}

export function exactToolSequence(
  actual: readonly HarnessToolName[],
  allowedSequences: readonly (readonly HarnessToolName[])[],
): boolean {
  if (allowedSequences.length === 0) return true;
  return allowedSequences.some((allowed) => (
    actual.length === allowed.length && actual.every((tool, index) => tool === allowed[index])
  ));
}

export function scoreToolSequence(
  actual: readonly HarnessToolName[],
  allowedSequences: readonly (readonly HarnessToolName[])[],
): number {
  if (allowedSequences.length === 0) return 1;
  return bounded(Math.max(...allowedSequences.map((allowed) => ratio(
    longestCommonSubsequence(actual, allowed),
    Math.max(actual.length, allowed.length),
  ))), 0, 1, "工具顺序评分");
}

export function scoreHarnessEvaluationCase(input: {
  evaluationCase: Extract<HarnessEvaluationCase, { kind: "harness" }>;
  terminalStateMatches: boolean;
  actualTools: HarnessToolName[];
  changeSetMatches: boolean;
  hardGates: HarnessEvaluationHardGates;
  modelCalls: number;
  toolCalls: number;
  inputChars: number;
  promptTokens: number;
}): HarnessEvaluationScores {
  const expected = input.evaluationCase.expected;
  const requiredCounts = occurrences(expected.requiredTools);
  const actualCounts = occurrences(input.actualTools);
  const allowed = new Set(expected.allowedToolSequences.flat());
  const requiredHits = [...requiredCounts.entries()].reduce((total, [tool, count]) => (
    total + Math.min(count, actualCounts.get(tool) ?? 0)
  ), 0);
  const allowedHits = expected.allowedToolSequences.length === 0
    ? input.actualTools.length
    : input.actualTools.filter((tool) => allowed.has(tool) && !expected.forbiddenTools.includes(tool)).length;
  const toolRecall = ratio(requiredHits, expected.requiredTools.length);
  const toolPrecision = ratio(allowedHits, input.actualTools.length);
  const toolSequence = scoreToolSequence(input.actualTools, expected.allowedToolSequences);
  const efficiencyChecks = [
    input.modelCalls <= expected.maximumModelCalls,
    input.toolCalls <= expected.maximumToolCalls,
    input.inputChars <= expected.maximumInputChars,
    input.promptTokens <= expected.maximumPromptTokens,
  ];
  const efficiency = ratio(efficiencyChecks.filter(Boolean).length, efficiencyChecks.length);
  const taskOutcome = input.terminalStateMatches ? 1 : 0;
  const changeSetCompliance = input.changeSetMatches ? 1 : 0;
  const rawTotal = input.hardGates.passed
    ? (taskOutcome * 30) + (toolPrecision * 12.5) + (toolRecall * 12.5) + (toolSequence * 15) + (changeSetCompliance * 20) + (efficiency * 10)
    : 0;
  const scoreValues = { taskOutcome, toolPrecision, toolRecall, toolSequence, changeSetCompliance, efficiency };
  for (const [label, value] of Object.entries(scoreValues)) bounded(value, 0, 1, label);
  const total = bounded(rawTotal, 0, 100, "总分");
  return { taskOutcome, toolPrecision, toolRecall, toolSequence, changeSetCompliance, efficiency, total };
}

export function scoreBoundaryEvaluationCase(passed: boolean): HarnessEvaluationScores {
  const value = passed ? 1 : 0;
  return {
    taskOutcome: value,
    toolPrecision: 1,
    toolRecall: 1,
    toolSequence: 1,
    changeSetCompliance: 1,
    efficiency: 1,
    total: value * 100,
  };
}
