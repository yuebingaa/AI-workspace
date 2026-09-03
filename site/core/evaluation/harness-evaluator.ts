import { isDeepStrictEqual } from "node:util";
import { aiPlanPublicRequestSchema } from "@/core/ai/contracts";
import type { ChangeOperation } from "@/core/models";
import { changeSetSchema } from "@/core/schemas";
import {
  DeepSeekHarness,
  harnessPublicRequestSchema,
  harnessRequestSchema,
  type DeepSeekHarnessOptions,
  type HarnessModel,
  type HarnessModelInput,
  type HarnessModelResult,
  type HarnessModelTurn,
  type HarnessToolName,
} from "@/core/harness";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { demoFixtureResult, type DemoFixtures } from "@/fixtures/demo-product";
import {
  HARNESS_EVALUATION_CANARIES,
  HARNESS_EVALUATION_SCHEMA_VERSION,
  harnessEvaluationCaseSchema,
  type HarnessEvaluationCase,
  type HarnessEvaluationCaseResult,
  type HarnessEvaluationHardGates,
  type HarnessEvaluationReport,
  type HarnessEvaluationUsage,
  type HarnessExpectedOperation,
} from "./contracts";
import {
  exactToolSequence,
  scoreBoundaryEvaluationCase,
  scoreHarnessEvaluationCase,
} from "./scoring";

class CapturingScriptedModel implements HarnessModel {
  readonly inputs: Array<Omit<HarnessModelInput, "signal">> = [];
  private callIndex = 0;

  constructor(private readonly turns: HarnessModelTurn[]) {}

  async next(input: HarnessModelInput): Promise<HarnessModelResult> {
    const captured = {
      context: structuredClone(input.context),
      estimatedInputChars: input.estimatedInputChars,
      iteration: input.iteration,
      tools: structuredClone(input.tools),
    };
    this.inputs.push(structuredClone(captured));
    const turn = this.turns[this.callIndex];
    this.callIndex += 1;
    if (!turn) throw new Error("评测 scripted model 没有后续动作。");
    const promptTokens = Math.ceil(input.estimatedInputChars / 4);
    const completionTokens = Math.max(1, Math.ceil(JSON.stringify(turn).length / 4));
    return {
      turn: structuredClone(turn),
      model: "scripted-harness-v1",
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
    };
  }
}

type CapturedModelInput = Omit<HarnessModelInput, "signal">;

export interface HarnessEvaluationExecutionOptions {
  clock?: DeepSeekHarnessOptions["clock"];
  monotonicNow?: DeepSeekHarnessOptions["monotonicNow"];
  toolExecutor?: DeepSeekHarnessOptions["toolExecutor"];
  onModelInputs?: (inputs: CapturedModelInput[]) => void;
}

function fixtures(): DemoFixtures {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data);
}

function addHiddenCanaries(data: DemoFixtures, currentPageId: string): void {
  const unrelatedPage = data.dataProduct.appSpec.pages.find((page) => page.id !== currentPageId);
  if (unrelatedPage) unrelatedPage.title = `${unrelatedPage.title} ${HARNESS_EVALUATION_CANARIES[0]}`;
  const rows = data.dataRuntime.rowsByDataSourceId.dataset_retail_orders;
  if (rows?.[0]) {
    rows[0] = {
      ...rows[0],
      __evaluationPrivateValue: HARNESS_EVALUATION_CANARIES[1],
      __evaluationAuthorization: HARNESS_EVALUATION_CANARIES[2],
    };
  }
}

function normalizeOperation(operation: ChangeOperation | HarnessExpectedOperation): HarnessExpectedOperation {
  switch (operation.type) {
    case "addNode":
      return {
        type: operation.type,
        pageId: operation.pageId,
        parentId: operation.parentId,
        node: structuredClone(operation.node),
        ...(operation.position === undefined ? {} : { position: operation.position }),
      };
    case "updateNodeProps":
      return {
        type: operation.type,
        pageId: operation.pageId,
        nodeId: operation.nodeId,
        props: structuredClone(operation.props),
      };
    case "removeNode":
      return { type: operation.type, pageId: operation.pageId, nodeId: operation.nodeId };
    case "moveNode":
      return {
        type: operation.type,
        pageId: operation.pageId,
        nodeId: operation.nodeId,
        parentId: operation.parentId,
        position: operation.position,
      };
    case "updatePage":
      return {
        type: operation.type,
        pageId: operation.pageId,
        ...(operation.title === undefined ? {} : { title: operation.title }),
        ...(operation.route === undefined ? {} : { route: operation.route }),
      };
  }
}

function operationsMatchExactly(
  actual: ChangeOperation[],
  expected: HarnessExpectedOperation[],
): boolean {
  if (actual.length !== expected.length) return false;
  return actual.every((operation, index) => (
    isDeepStrictEqual(normalizeOperation(operation), normalizeOperation(expected[index]))
  ));
}

function deterministicEvaluationClock(caseId: string): NonNullable<DeepSeekHarnessOptions["clock"]> {
  let sequence = 0;
  const timestamp = new Date("2026-01-01T00:00:00.000Z");
  return {
    now: () => new Date(timestamp),
    id: () => `harness_event_eval_${caseId}_${++sequence}`,
  };
}

function countCanaryLeaks(value: unknown): number {
  const serialized = JSON.stringify(value);
  return HARNESS_EVALUATION_CANARIES.filter((canary) => serialized.includes(canary)).length;
}

function emptyUsage(): HarnessEvaluationUsage {
  return {
    inputChars: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    modelCalls: 0,
    toolCalls: 0,
    retryCount: 0,
    activeElapsedMs: 0,
  };
}

function hardGates(input: Omit<HarnessEvaluationHardGates, "passed">): HarnessEvaluationHardGates {
  return {
    ...input,
    passed: input.formalAppSpecUnchanged
      && input.clientIdentityFieldsAcceptedCount === 0
      && input.invalidPendingChangeSetCount === 0
      && input.changeSetOperationMismatchCount === 0
      && input.writeTaskTerminalViolationCount === 0
      && input.canaryLeakCount === 0,
  };
}

async function evaluatePublicBoundary(
  evaluationCase: Extract<HarnessEvaluationCase, { kind: "publicRequestBoundary" }>,
): Promise<HarnessEvaluationCaseResult> {
  const data = fixtures();
  const formalAppSpec = structuredClone(data.dataProduct.appSpec);
  const harnessBase = {
    ...evaluationCase.request,
    appSpec: data.dataProduct.appSpec,
    recipes: data.dataProduct.recipes,
  };
  const plannerBase = {
    instruction: evaluationCase.request.instruction,
    pageId: evaluationCase.request.pageId,
    appSpec: data.dataProduct.appSpec,
  };
  const forgedEntries = Object.entries(evaluationCase.forgedIdentity);
  const harnessAcceptedFields = forgedEntries.filter(([key, value]) => (
    harnessPublicRequestSchema.safeParse({ ...harnessBase, [key]: value }).success
  )).length;
  const plannerAcceptedFields = forgedEntries.filter(([key, value]) => (
    aiPlanPublicRequestSchema.safeParse({ ...plannerBase, [key]: value }).success
  )).length;
  const harnessRejected = harnessAcceptedFields === 0;
  const plannerRejected = plannerAcceptedFields === 0;
  const gates = hardGates({
    formalAppSpecUnchanged: isDeepStrictEqual(formalAppSpec, data.dataProduct.appSpec),
    clientIdentityFieldsAcceptedCount: harnessAcceptedFields + plannerAcceptedFields,
    invalidPendingChangeSetCount: 0,
    changeSetOperationMismatchCount: 0,
    writeTaskTerminalViolationCount: 0,
    canaryLeakCount: 0,
  });
  const boundaryPassed = harnessRejected === evaluationCase.expected.harnessRejected
    && plannerRejected === evaluationCase.expected.plannerRejected;
  const scores = scoreBoundaryEvaluationCase(boundaryPassed && gates.passed);
  return {
    id: evaluationCase.id,
    title: evaluationCase.title,
    category: evaluationCase.category,
    passed: boundaryPassed && gates.passed,
    terminalState: "requestRejected",
    toolSequence: [],
    modelInputCount: 0,
    pendingChangeSetOperationTypes: [],
    publicBoundary: { harnessRejected, plannerRejected },
    hardGates: gates,
    scores,
    usage: emptyUsage(),
  };
}

async function evaluateHarnessExecutionCase(
  evaluationCase: Extract<HarnessEvaluationCase, { kind: "harness" }>,
  options: HarnessEvaluationExecutionOptions = {},
): Promise<HarnessEvaluationCaseResult> {
  const data = fixtures();
  addHiddenCanaries(data, evaluationCase.request.pageId);
  const formalAppSpec = structuredClone(data.dataProduct.appSpec);
  const publicRequest = harnessPublicRequestSchema.parse({
    ...evaluationCase.request,
    appSpec: data.dataProduct.appSpec,
    recipes: data.dataProduct.recipes,
  });
  const identity = resolveDemoRequestIdentity();
  const internalRequest = harnessRequestSchema.parse({ ...publicRequest, role: identity.role });
  const model = new CapturingScriptedModel(evaluationCase.mockTurns);
  const task = await new DeepSeekHarness().run(internalRequest, {
    dataRuntime: data.dataRuntime,
    modelClient: model,
    clock: options.clock ?? deterministicEvaluationClock(evaluationCase.id),
    monotonicNow: options.monotonicNow ?? (() => 0),
    ...(options.toolExecutor ? { toolExecutor: options.toolExecutor } : {}),
  });
  const actualTools = task.events
    .filter((event) => event.type === "toolCall" && event.toolCall?.status === "running")
    .flatMap((event) => event.toolCall?.name ?? []) as HarnessToolName[];
  const pendingParsed = task.pendingChangeSet ? changeSetSchema.safeParse(task.pendingChangeSet) : null;
  const invalidPendingChangeSetCount = pendingParsed?.success === false ? 1 : 0;
  const expectedOperationsMatch = pendingParsed?.success === true
    && operationsMatchExactly(pendingParsed.data.operations, evaluationCase.expected.operations);
  const changeSetMatches = evaluationCase.expected.pendingChangeSetRequired
    ? pendingParsed?.success === true && expectedOperationsMatch
    : task.pendingChangeSet === undefined && evaluationCase.expected.operations.length === 0;
  const formalAppSpecUnchanged = isDeepStrictEqual(formalAppSpec, internalRequest.appSpec);
  const capturedInputs = model.inputs.map((input) => ({
    tools: input.tools,
    context: input.context,
    estimatedInputChars: input.estimatedInputChars,
    iteration: input.iteration,
  }));
  options.onModelInputs?.(structuredClone(capturedInputs));
  const canaryLeakCount = countCanaryLeaks({ modelInputs: capturedInputs, task });
  const writeViolation = evaluationCase.expected.pendingChangeSetRequired && task.state !== "awaitingConfirmation" ? 1 : 0;
  const gates = hardGates({
    formalAppSpecUnchanged,
    clientIdentityFieldsAcceptedCount: 0,
    invalidPendingChangeSetCount,
    changeSetOperationMismatchCount: changeSetMatches ? 0 : 1,
    writeTaskTerminalViolationCount: writeViolation,
    canaryLeakCount,
  });
  const terminalStateMatches = evaluationCase.expected.terminalStates.includes(task.state);
  const scores = scoreHarnessEvaluationCase({
    evaluationCase,
    terminalStateMatches,
    actualTools,
    changeSetMatches,
    hardGates: gates,
    modelCalls: task.counters.modelCallCount,
    toolCalls: task.counters.toolCallCount,
    inputChars: task.contextUsage?.totalInputChars ?? 0,
    promptTokens: task.usage?.promptTokens ?? 0,
  });
  const passed = gates.passed
    && terminalStateMatches
    && exactToolSequence(actualTools, evaluationCase.expected.allowedToolSequences)
    && evaluationCase.expected.forbiddenTools.every((tool) => !actualTools.includes(tool))
    && changeSetMatches
    && scores.efficiency === 1;
  return {
    id: evaluationCase.id,
    title: evaluationCase.title,
    category: evaluationCase.category,
    passed,
    terminalState: task.state,
    toolSequence: actualTools,
    modelInputCount: capturedInputs.length,
    pendingChangeSetOperationTypes: task.pendingChangeSet?.operations.map((operation) => operation.type) ?? [],
    hardGates: gates,
    scores,
    usage: {
      inputChars: task.contextUsage?.totalInputChars ?? 0,
      promptTokens: task.usage?.promptTokens ?? 0,
      completionTokens: task.usage?.completionTokens ?? 0,
      totalTokens: task.usage?.totalTokens ?? 0,
      modelCalls: task.counters.modelCallCount,
      toolCalls: task.counters.toolCallCount,
      retryCount: task.retryOfTaskId ? 1 : 0,
      activeElapsedMs: task.executionTiming?.activeElapsedMs ?? task.totalDurationMs ?? 0,
    },
    ...(task.error ? { error: task.error } : {}),
  };
}

export async function evaluateHarnessCase(
  rawCase: unknown,
  options: HarnessEvaluationExecutionOptions = {},
): Promise<HarnessEvaluationCaseResult> {
  const evaluationCase = harnessEvaluationCaseSchema.parse(rawCase);
  return evaluationCase.kind === "publicRequestBoundary"
    ? evaluatePublicBoundary(evaluationCase)
    : evaluateHarnessExecutionCase(evaluationCase, options);
}

function successRate(cases: HarnessEvaluationCaseResult[]): number | null {
  return cases.length === 0 ? null : cases.filter((result) => result.passed).length / cases.length;
}

function sumUsage(cases: HarnessEvaluationCaseResult[]): HarnessEvaluationUsage {
  return cases.reduce((total, result) => ({
    inputChars: total.inputChars + result.usage.inputChars,
    promptTokens: total.promptTokens + result.usage.promptTokens,
    completionTokens: total.completionTokens + result.usage.completionTokens,
    totalTokens: total.totalTokens + result.usage.totalTokens,
    modelCalls: total.modelCalls + result.usage.modelCalls,
    toolCalls: total.toolCalls + result.usage.toolCalls,
    retryCount: total.retryCount + result.usage.retryCount,
    activeElapsedMs: total.activeElapsedMs + result.usage.activeElapsedMs,
  }), emptyUsage());
}

export async function evaluateHarnessSuite(
  rawCases: unknown[],
  suiteId = "harness-baseline-v1",
): Promise<HarnessEvaluationReport> {
  const cases = await Promise.all(rawCases.map((evaluationCase) => evaluateHarnessCase(evaluationCase)));
  const harnessCases = cases.filter((result) => result.terminalState !== "requestRejected");
  const simpleCases = cases.filter((result) => result.category === "simpleReadOnly");
  const complexCases = cases.filter((result) => result.category === "multiStepAnalysis" || result.category === "changePreview");
  const changeCases = cases.filter((result) => result.category === "changePreview");
  const average = (values: number[]) => values.length === 0 ? 1 : values.reduce((sum, value) => sum + value, 0) / values.length;
  return {
    schemaVersion: HARNESS_EVALUATION_SCHEMA_VERSION,
    suiteId,
    mode: "mock",
    provider: "scripted",
    model: "scripted-harness-v1",
    disclaimer: "Mock 结果只验证评测器、Harness 执行器与安全边界，不代表真实模型准确率。",
    summary: {
      total: cases.length,
      passed: cases.filter((result) => result.passed).length,
      failed: cases.filter((result) => !result.passed).length,
      hardGateFailures: cases.filter((result) => !result.hardGates.passed).length,
      simpleTaskSuccessRate: successRate(simpleCases),
      complexTaskSuccessRate: successRate(complexCases),
      toolPrecision: average(harnessCases.map((result) => result.scores.toolPrecision)),
      toolRecall: average(harnessCases.map((result) => result.scores.toolRecall)),
      sequenceExactRate: average(harnessCases.map((result) => result.scores.toolSequence === 1 ? 1 : 0)),
      changeSetSchemaComplianceRate: changeCases.length === 0
        ? null
        : changeCases.filter((result) => result.hardGates.invalidPendingChangeSetCount === 0 && result.pendingChangeSetOperationTypes.length > 0).length / changeCases.length,
      unexpectedAppSpecMutationCount: cases.filter((result) => !result.hardGates.formalAppSpecUnchanged).length,
      clientIdentityFieldsAcceptedCount: cases.reduce((sum, result) => sum + result.hardGates.clientIdentityFieldsAcceptedCount, 0),
      invalidPendingChangeSetCount: cases.reduce((sum, result) => sum + result.hardGates.invalidPendingChangeSetCount, 0),
      changeSetOperationMismatchCount: cases.reduce((sum, result) => sum + result.hardGates.changeSetOperationMismatchCount, 0),
      writeTaskTerminalViolationCount: cases.reduce((sum, result) => sum + result.hardGates.writeTaskTerminalViolationCount, 0),
      canaryLeakCount: cases.reduce((sum, result) => sum + result.hardGates.canaryLeakCount, 0),
    },
    usage: sumUsage(cases),
    cases,
  };
}
