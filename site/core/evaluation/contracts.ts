import { z } from "zod";
import {
  harnessModelTurnSchema,
  harnessStateSchema,
  harnessToolNameSchema,
  type HarnessState,
  type HarnessToolName,
} from "@/core/harness/contracts";
import { appNodeSchema } from "@/core/schemas";

export const HARNESS_EVALUATION_SCHEMA_VERSION = 1 as const;

export const HARNESS_EVALUATION_CANARIES = [
  "FAKE_EVAL_PRIVATE_APP_SPEC_7d9c2a",
  "FAKE_EVAL_PRIVATE_DATA_ROW_41b8ef",
  "FAKE_EVAL_AUTHORIZATION_TOKEN_93ac10",
] as const;

const evaluationRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(160).regex(/^[A-Za-z0-9_-]+$/),
  instruction: z.string().trim().min(1).max(1_000),
  pageId: z.string().min(1).max(120),
  dataSourceId: z.string().min(1).max(160).optional(),
}).strict();

const operationExpectationSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("addNode"),
    pageId: z.string().min(1).max(120),
    parentId: z.string().min(1).max(120),
    node: appNodeSchema,
    position: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    type: z.literal("updateNodeProps"),
    pageId: z.string().min(1).max(120),
    nodeId: z.string().min(1).max(120),
    props: z.record(z.string(), z.unknown()),
  }).strict(),
  z.object({
    type: z.literal("removeNode"),
    pageId: z.string().min(1).max(120),
    nodeId: z.string().min(1).max(120),
  }).strict(),
  z.object({
    type: z.literal("moveNode"),
    pageId: z.string().min(1).max(120),
    nodeId: z.string().min(1).max(120),
    parentId: z.string().min(1).max(120),
    position: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    type: z.literal("updatePage"),
    pageId: z.string().min(1).max(120),
    title: z.string().min(1).optional(),
    route: z.string().min(1).optional(),
  }).strict(),
]);

export type HarnessExpectedOperation = z.infer<typeof operationExpectationSchema>;

const harnessExpectedSchema = z.object({
  terminalStates: z.array(harnessStateSchema).min(1),
  requiredTools: z.array(harnessToolNameSchema),
  allowedToolSequences: z.array(z.array(harnessToolNameSchema)),
  forbiddenTools: z.array(harnessToolNameSchema).default([]),
  pendingChangeSetRequired: z.boolean(),
  operations: z.array(operationExpectationSchema).default([]),
  formalAppSpecMustRemainUnchanged: z.literal(true),
  maximumModelCalls: z.number().int().positive(),
  maximumToolCalls: z.number().int().nonnegative(),
  maximumInputChars: z.number().int().positive(),
  maximumPromptTokens: z.number().int().positive(),
}).strict();

const baseEvaluationCaseShape = {
  schemaVersion: z.literal(HARNESS_EVALUATION_SCHEMA_VERSION),
  id: z.string().min(1).max(120).regex(/^[a-z0-9_-]+$/),
  title: z.string().min(1).max(160),
  fixtureId: z.literal("demo-retail-orders"),
} as const;

const harnessExecutionEvaluationCaseSchema = z.object({
  ...baseEvaluationCaseShape,
  kind: z.literal("harness"),
  category: z.enum(["simpleReadOnly", "multiStepAnalysis", "changePreview"]),
  request: evaluationRequestSchema,
  mockTurns: z.array(harnessModelTurnSchema).min(1).max(8),
  expected: harnessExpectedSchema,
}).strict();

const publicBoundaryEvaluationCaseSchema = z.object({
  ...baseEvaluationCaseShape,
  kind: z.literal("publicRequestBoundary"),
  category: z.literal("securityAdversarial"),
  request: evaluationRequestSchema,
  forgedIdentity: z.object({
    role: z.literal("admin"),
    tenantId: z.string().min(1),
    ownerId: z.string().min(1),
    userId: z.string().min(1),
  }).strict(),
  expected: z.object({
    harnessRejected: z.literal(true),
    plannerRejected: z.literal(true),
    formalAppSpecMustRemainUnchanged: z.literal(true),
  }).strict(),
}).strict();

export const harnessEvaluationCaseSchema = z.discriminatedUnion("kind", [
  harnessExecutionEvaluationCaseSchema,
  publicBoundaryEvaluationCaseSchema,
]);

export type HarnessEvaluationCase = z.infer<typeof harnessEvaluationCaseSchema>;

export interface HarnessEvaluationHardGates {
  formalAppSpecUnchanged: boolean;
  clientIdentityFieldsAcceptedCount: number;
  invalidPendingChangeSetCount: number;
  changeSetOperationMismatchCount: number;
  writeTaskTerminalViolationCount: number;
  canaryLeakCount: number;
  passed: boolean;
}

export interface HarnessEvaluationUsage {
  inputChars: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  modelCalls: number;
  toolCalls: number;
  retryCount: number;
  activeElapsedMs: number;
}

export interface HarnessEvaluationScores {
  taskOutcome: number;
  toolPrecision: number;
  toolRecall: number;
  toolSequence: number;
  changeSetCompliance: number;
  efficiency: number;
  total: number;
}

export interface HarnessEvaluationCaseResult {
  id: string;
  title: string;
  category: HarnessEvaluationCase["category"];
  passed: boolean;
  terminalState: HarnessState | "requestRejected";
  toolSequence: HarnessToolName[];
  modelInputCount: number;
  pendingChangeSetOperationTypes: string[];
  publicBoundary?: { harnessRejected: boolean; plannerRejected: boolean };
  hardGates: HarnessEvaluationHardGates;
  scores: HarnessEvaluationScores;
  usage: HarnessEvaluationUsage;
  error?: string;
}

export interface HarnessEvaluationReport {
  schemaVersion: typeof HARNESS_EVALUATION_SCHEMA_VERSION;
  suiteId: string;
  mode: "mock" | "live";
  provider: string;
  model: string;
  disclaimer: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    hardGateFailures: number;
    simpleTaskSuccessRate: number | null;
    complexTaskSuccessRate: number | null;
    toolPrecision: number;
    toolRecall: number;
    sequenceExactRate: number;
    changeSetSchemaComplianceRate: number | null;
    unexpectedAppSpecMutationCount: number;
    clientIdentityFieldsAcceptedCount: number;
    invalidPendingChangeSetCount: number;
    changeSetOperationMismatchCount: number;
    writeTaskTerminalViolationCount: number;
    canaryLeakCount: number;
  };
  usage: HarnessEvaluationUsage;
  cases: HarnessEvaluationCaseResult[];
}
