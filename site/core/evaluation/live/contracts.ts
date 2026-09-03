import { z } from "zod";
import {
  harnessEvaluationCategorySchema,
  operationExpectationSchema,
} from "../contracts";
import {
  harnessStateSchema,
  harnessTerminationCodeSchema,
  harnessToolNameSchema,
} from "@/core/harness/contracts";

export const LIVE_HARNESS_SUITE_ID = "harness-live-smoke-v1";
export const LIVE_HARNESS_SUITE_VERSION = "1.0.0";
export const LIVE_HARNESS_SCHEMA_VERSION = 1;

export const LIVE_HARNESS_REPORT_CANARIES = Object.freeze([
  "FAKE_LIVE_SECRET_CANARY_7D2C",
  "FAKE_LIVE_DATA_CANARY_91B4",
  "FAKE_LIVE_INSTRUCTION_CANARY_E6A8",
]);

export const liveHarnessFailureCodeSchema = z.enum([
  "runner_gate",
  "manifest",
  "retry",
  "session",
  "loopback",
  "model_budget",
  "prompt_budget",
  "completion_budget",
  "time_budget",
  "invalid_usage",
  "case_budget",
  "fixture",
  "redirect",
  "http_401",
  "http_403",
  "http_429",
  "http_500",
  "http_other",
  "invalid_response",
  "timeout",
  "transport",
  "cleanup",
  "server_start",
  "git",
  "global_budget",
  "model",
  "provider_model_mismatch",
  "hard_gate",
  "report_safety",
  "internal",
]);
export type LiveHarnessFailureCode = z.infer<typeof liveHarnessFailureCodeSchema>;

export const liveHarnessTrustedModelSchema = z.string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._/:-]+$/);

export class LiveHarnessReportSafetyError extends Error {
  readonly code = "report_safety" as const;

  constructor() {
    super("Live evaluation report safety assertion failed.");
    this.name = "LiveHarnessReportSafetyError";
  }
}

export const LIVE_HARNESS_GLOBAL_BUDGET = Object.freeze({
  maxModelCalls: 7,
  maxPromptTokens: 12_000,
  maxCompletionTokens: 3_000,
  maxActiveElapsedMs: 180_000,
  maxRetriesPerCase: 0,
});

export const liveHarnessBudgetSchema = z.object({
  maxModelCalls: z.number().int().positive(),
  maxPromptTokens: z.number().int().positive(),
  maxCompletionTokens: z.number().int().positive(),
  maxActiveElapsedMs: z.number().int().positive(),
  maxRetriesPerCase: z.literal(0),
}).strict();
export type LiveHarnessBudget = z.infer<typeof liveHarnessBudgetSchema>;

export const liveHarnessBudgetUsageSchema = z.object({
  modelCalls: z.number().int().nonnegative(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  activeElapsedMs: z.number().int().nonnegative(),
}).strict();
export type LiveHarnessBudgetUsage = z.infer<typeof liveHarnessBudgetUsageSchema>;

const liveHarnessCaseRequestSchema = z.object({
  instruction: z.string().trim().min(1).max(1_000),
  pageId: z.string().min(1).max(120),
  dataSourceId: z.string().min(1).max(160).optional(),
}).strict();

export const liveHarnessEvaluationCaseSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  caseVersion: z.literal(1),
  title: z.string().min(1).max(160),
  category: harnessEvaluationCategorySchema,
  request: liveHarnessCaseRequestSchema,
  expected: z.object({
    terminalState: harnessStateSchema,
    terminationCode: harnessTerminationCodeSchema,
    toolSequence: z.array(harnessToolNameSchema),
    operations: z.array(operationExpectationSchema),
  }).strict(),
  limits: z.object({
    maxModelCalls: z.number().int().positive(),
    maxToolCalls: z.number().int().nonnegative(),
    promptTokenReservation: z.number().int().positive(),
    completionTokenReservation: z.number().int().positive(),
    activeElapsedReservationMs: z.number().int().positive(),
    maxCompletionTokensPerCall: z.number().int().positive(),
  }).strict(),
}).strict();
export type LiveHarnessEvaluationCase = z.infer<typeof liveHarnessEvaluationCaseSchema>;

export const liveHarnessCaseHardGatesSchema = z.object({
  formalAppSpecUnchanged: z.boolean(),
  terminalStateMatches: z.boolean(),
  terminationCodeMatches: z.boolean(),
  toolSequenceMatches: z.boolean(),
  toolCallCountMatches: z.boolean(),
  pendingChangeSetSchemaValid: z.boolean(),
  changeSetOperationsMatch: z.boolean(),
  noUnexpectedChangeSet: z.boolean(),
  noForbiddenArtifact: z.boolean(),
  passed: z.boolean(),
}).strict();
export type LiveHarnessCaseHardGates = z.infer<typeof liveHarnessCaseHardGatesSchema>;

export const liveHarnessCaseResultSchema = z.object({
  id: z.string(),
  caseVersion: z.number().int().positive(),
  category: harnessEvaluationCategorySchema,
  terminalState: harnessStateSchema,
  terminationCode: z.union([harnessTerminationCodeSchema, liveHarnessFailureCodeSchema]),
  toolSequence: z.array(harnessToolNameSchema),
  passed: z.boolean(),
  modelCalls: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  retryCount: z.literal(0),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
  activeElapsedMs: z.number().int().nonnegative(),
  hardGates: liveHarnessCaseHardGatesSchema,
}).strict();
export type LiveHarnessCaseResult = z.infer<typeof liveHarnessCaseResultSchema>;

export const liveHarnessEvaluationReportSchema = z.object({
  schemaVersion: z.literal(LIVE_HARNESS_SCHEMA_VERSION),
  suiteId: z.literal(LIVE_HARNESS_SUITE_ID),
  suiteVersion: z.literal(LIVE_HARNESS_SUITE_VERSION),
  mode: z.literal("live"),
  gitCommit: z.string().regex(/^[0-9a-f]{40}$/),
  provider: z.literal("deepseek"),
  model: liveHarnessTrustedModelSchema.nullable(),
  passed: z.boolean(),
  hardGatesPassed: z.boolean(),
  terminationCode: z.union([z.literal("completed"), liveHarnessFailureCodeSchema]),
  budget: z.object({
    limits: liveHarnessBudgetSchema,
    used: liveHarnessBudgetUsageSchema,
    remaining: liveHarnessBudgetUsageSchema.omit({ totalTokens: true }),
  }).strict(),
  cases: z.array(liveHarnessCaseResultSchema).max(3),
}).strict().superRefine((report, context) => {
  if (report.passed || report.hardGatesPassed) {
    if (report.cases.length !== 3 || report.model === null || report.terminationCode !== "completed") {
      context.addIssue({ code: "custom", message: "通过的 Live 报告必须包含三个完整用例和可信模型。" });
    }
  }
});
export type LiveHarnessEvaluationReport = z.infer<typeof liveHarnessEvaluationReportSchema>;

const LIVE_REPORT_FORBIDDEN_MARKERS = [
  "authorization",
  "reasoning_content",
  "rowsbydatasourceid",
];

function reportStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(reportStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(reportStrings);
  return [];
}

export function isLiveHarnessOutputStringSafe(
  value: string,
  options: { sessionNonce?: string; extraCanaries?: readonly string[] } = {},
): boolean {
  const exactCanaries = [
    ...LIVE_HARNESS_REPORT_CANARIES,
    ...(options.extraCanaries ?? []),
    ...(options.sessionNonce ? [options.sessionNonce] : []),
  ].filter((canary) => canary.length > 0);
  const normalized = value.toLowerCase();
  return !exactCanaries.some((canary) => value.includes(canary))
    && !LIVE_REPORT_FORBIDDEN_MARKERS.some((marker) => normalized.includes(marker));
}

export function assertLiveHarnessEvaluationReportSafe(
  rawReport: unknown,
  options: { sessionNonce?: string; extraCanaries?: readonly string[] } = {},
): asserts rawReport is LiveHarnessEvaluationReport {
  const parsed = liveHarnessEvaluationReportSchema.safeParse(rawReport);
  if (!parsed.success) throw new LiveHarnessReportSafetyError();
  for (const value of reportStrings(parsed.data)) {
    if (!isLiveHarnessOutputStringSafe(value, options)) {
      throw new LiveHarnessReportSafetyError();
    }
  }
}
