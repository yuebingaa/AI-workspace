import { z } from "zod";
import type { ChangeSet, DataRecipe } from "@/core/models";
import { excelExportArtifactSchema, type ExcelExportArtifact } from "@/core/exports/contracts";
import { appSpecSchema, changeSetSchema, dataRecipeSchema } from "@/core/schemas";
import { edsWorkspaceSnapshotSchema } from "@/core/eds";

export const MAX_HARNESS_INSTRUCTION_LENGTH = 1_000;
export const MAX_HARNESS_REQUEST_BYTES = 180_000;
export const MAX_HARNESS_IMAGE_ATTACHMENTS = 3;
export const MAX_HARNESS_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_HARNESS_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_HARNESS_EVENTS = 80;
export const MAX_HARNESS_TASKS = 20;

export const DEFAULT_HARNESS_LIMITS = {
  maxLoops: 8,
  maxModelCalls: 6,
  maxToolCalls: 6,
  modelRequestTimeoutMs: 25_000,
  toolCallTimeoutMs: 10_000,
  totalExecutionTimeoutMs: 90_000,
} as const;

export const HARNESS_CLIENT_TIMEOUT_MS = 95_000;

export const harnessStateSchema = z.enum([
  "planning",
  "executingTool",
  "observing",
  "awaitingConfirmation",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export type HarnessState = z.infer<typeof harnessStateSchema>;

export const harnessTerminationCodeSchema = z.enum([
  "completed",
  "awaitingConfirmation",
  "missingContext",
  "missingDataFields",
  "missingRequirements",
  "protocolViolation",
  "invalidTool",
  "toolExecutionFailed",
  "verificationFailed",
  "contextBudgetExceeded",
  "executionFailed",
  "cancelled",
]);
export type HarnessTerminationCode = z.infer<typeof harnessTerminationCodeSchema>;

export const harnessToolNameSchema = z.enum([
  "analyzeEdsReports",
  "scanEdsRawWorkbook",
  "queryEdsRawWorkbook",
  "inspectEdsRawWorkbook",
  "readEdsRawRows",
  "inspectDataset",
  "inspectFields",
  "previewDataRecipe",
  "validateDataRecipe",
  "exportDataRecipeToExcel",
  "inspectAppSpec",
  "createEdsBreakdownChartPreview",
  "createEdsLineIssueChartPreview",
  "updateEdsTablePreview",
  "createChangeSetPreview",
]);
export type HarnessToolName = z.infer<typeof harnessToolNameSchema>;

export const harnessExecutionPhaseSchema = z.enum([
  "planning",
  "modelRequest",
  "toolExecution",
  "awaitingConfirmation",
  "completed",
  "blocked",
  "failed",
  "cancelled",
]);
export type HarnessExecutionPhase = z.infer<typeof harnessExecutionPhaseSchema>;

export const harnessExecutionTimingSchema = z.object({
  phase: harnessExecutionPhaseSchema,
  activeElapsedMs: z.number().int().nonnegative(),
  remainingMs: z.number().int().nonnegative(),
  totalBudgetMs: z.number().int().positive(),
  modelRequestTimeoutMs: z.number().int().positive(),
  toolCallTimeoutMs: z.number().int().positive(),
  modelDurationMs: z.number().int().nonnegative(),
  toolDurationMs: z.number().int().nonnegative(),
  otherDurationMs: z.number().int().nonnegative(),
  retainedObservationCount: z.number().int().nonnegative(),
}).strict();
export type HarnessExecutionTiming = z.infer<typeof harnessExecutionTimingSchema>;

export const harnessEventSchema = z.object({
  id: z.string().min(1).max(160),
  type: z.enum(["state", "toolCall", "observation", "confirmation", "error"]),
  state: harnessStateSchema,
  timestamp: z.iso.datetime(),
  message: z.string().min(1).max(1_000),
  toolCall: z.object({
    id: z.string().min(1).max(160),
    name: harnessToolNameSchema,
    status: z.enum(["running", "success", "failure"]),
    durationMs: z.number().int().nonnegative(),
  }).strict().optional(),
  timing: z.object({
    phase: harnessExecutionPhaseSchema,
    durationMs: z.number().int().nonnegative(),
    elapsedMs: z.number().int().nonnegative(),
    remainingMs: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();
export type HarnessEvent = z.infer<typeof harnessEventSchema>;

export const harnessCountersSchema = z.object({
  loopCount: z.number().int().nonnegative(),
  modelCallCount: z.number().int().nonnegative(),
  toolCallCount: z.number().int().nonnegative(),
}).strict();

export const harnessModelUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict();

export const harnessTaskComplexitySchema = z.enum(["simpleReadOnly", "multiStep"]);
export type HarnessTaskComplexity = z.infer<typeof harnessTaskComplexitySchema>;

export const harnessSemanticIntentDecisionSchema = z.object({
  mode: z.enum(["conversation", "readOnlyTask", "changePreview"]),
  requiresVisualVerification: z.boolean().optional(),
  wantsData: z.boolean(),
  wantsEdsAnalysis: z.boolean(),
  wantsRawWorkbook: z.boolean(),
  wantsFields: z.boolean(),
  wantsRecipe: z.boolean(),
  wantsAppInspection: z.boolean(),
  wantsExcel: z.boolean(),
  changeAction: z.enum(["none", "add", "update", "remove", "move"]),
  changeTarget: z.enum(["none", "genericComponent", "chart", "edsBreakdownChart", "edsLineIssueChart", "edsTable"]),
  componentKind: z.enum(["none", "chart", "metric", "table", "text", "generic"]),
  chartType: z.enum(["auto", "bar", "line", "area", "pie", "donut"]),
  targetLine: z.string().trim().min(1).max(120).optional(),
  skillIds: z.array(z.enum(["data-visualization", "eds-analysis", "dashboard-editing", "workbook-analysis"])).max(3),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(300),
}).strict().superRefine((decision, context) => {
  const isChange = decision.mode === "changePreview";
  if (isChange !== (decision.changeAction !== "none" && decision.changeTarget !== "none")) {
    context.addIssue({ code: "custom", message: "changePreview 必须同时给出变更动作和目标；非变更模式必须使用 none。" });
  }
  if ((decision.wantsEdsAnalysis || decision.wantsRawWorkbook || decision.wantsFields || decision.wantsRecipe) && !decision.wantsData) {
    context.addIssue({ code: "custom", message: "需要数据子能力时 wantsData 必须为 true。" });
  }
});
export type HarnessSemanticIntentDecision = z.infer<typeof harnessSemanticIntentDecisionSchema>;

export interface HarnessSemanticIntentInput {
  instruction: string;
  previousInstruction?: string;
  previousAssistantMessage?: string;
  page: {
    id: string;
    title: string;
    componentTypes: string[];
  };
  dataSources: Array<{ id: string; name: string; sourceType: string }>;
  hasEdsWorkspace: boolean;
  hasRawWorkbookAccess: boolean;
  hasVisualVerification: boolean;
  userImageEvidence?: {
    summary: string;
    visibleText: string[];
    findings: string[];
    uncertainties: string[];
  };
  role: "viewer" | "editor" | "admin";
  signal: AbortSignal;
}

export interface HarnessSemanticIntentResult {
  decision: HarnessSemanticIntentDecision;
  model: string;
  usage: HarnessModelUsage;
  inputChars: number;
}

export const harnessContextLimitSchema = z.enum([
  "singleRequestChars",
  "taskInputChars",
  "taskPromptTokens",
]);
export type HarnessContextLimit = z.infer<typeof harnessContextLimitSchema>;

export const harnessContextBudgetSchema = z.object({
  maxRequestInputChars: z.number().int().positive(),
  maxToolResultChars: z.number().int().positive(),
  maxToolResultEntries: z.number().int().positive(),
  maxTotalInputChars: z.number().int().positive(),
  maxTotalPromptTokens: z.number().int().positive(),
}).strict();

export const harnessContextUsageSchema = z.object({
  totalInputChars: z.number().int().nonnegative(),
  totalPromptTokens: z.number().int().nonnegative().default(0),
  complexity: harnessTaskComplexitySchema.default("multiStep"),
  limits: harnessContextBudgetSchema.optional(),
  limitReached: harnessContextLimitSchema.optional(),
  requests: z.array(z.object({
    iteration: z.number().int().positive(),
    phase: z.enum(["semanticRouting", "execution"]).optional(),
    inputChars: z.number().int().nonnegative(),
    estimatedPromptTokens: z.number().int().nonnegative().default(0),
    promptTokens: z.number().int().nonnegative().optional(),
    toolObservationChars: z.number().int().nonnegative().default(0),
    toolObservationEntries: z.number().int().nonnegative().default(0),
    budgetCheck: z.literal("beforeModel").default("beforeModel"),
    compacted: z.boolean(),
  }).strict()).max(8),
}).strict();

export const harnessSkillSummarySchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(80),
  version: z.string().min(1).max(32),
}).strict();
export type HarnessSkillSummary = z.infer<typeof harnessSkillSummarySchema>;

export const harnessToolFailureKindSchema = z.enum([
  "argumentValidation",
  "precondition",
  "timeout",
  "execution",
  "repeatedCall",
]);
export type HarnessToolFailureKind = z.infer<typeof harnessToolFailureKindSchema>;

export const harnessWorkingMemorySchema = z.object({
  goal: z.string().min(1).max(420),
  iteration: z.number().int().min(1).max(DEFAULT_HARNESS_LIMITS.maxLoops),
  confirmedDataSources: z.array(z.object({
    id: z.string().min(1).max(160),
    rowCount: z.number().int().nonnegative().optional(),
    columnCount: z.number().int().nonnegative().optional(),
    qualityScore: z.number().finite().optional(),
  }).strict()).max(4),
  confirmedFields: z.array(z.object({
    name: z.string().min(1).max(160),
    type: z.string().min(1).max(80).optional(),
  }).strict()).max(20),
  completedTools: z.array(harnessToolNameSchema).max(15),
  completedSteps: z.array(z.string().min(1).max(240)).max(15),
  keyStatistics: z.array(z.string().min(1).max(240)).max(8),
  pendingGoals: z.array(z.string().min(1).max(240)).max(10),
  failedAttempts: z.array(z.object({
    toolName: harnessToolNameSchema,
    failureKind: harnessToolFailureKindSchema,
    attempt: z.number().int().positive().max(10),
    issueSummary: z.array(z.string().min(1).max(240)).min(1).max(4),
    status: z.enum(["recovering", "recovered", "exhausted"]),
  }).strict()).max(6),
  missingCapabilities: z.array(z.string().min(1).max(240)).max(6),
}).strict();
export type HarnessWorkingMemory = z.infer<typeof harnessWorkingMemorySchema>;

export const harnessPlanStepSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9_-]+$/),
  kind: z.enum(["tool", "finalize"]),
  objective: z.string().min(1).max(240),
  toolName: harnessToolNameSchema.optional(),
  status: z.enum(["pending", "active", "completed", "failed", "skipped"]),
  attempts: z.number().int().nonnegative().max(10),
}).strict();
export type HarnessPlanStep = z.infer<typeof harnessPlanStepSchema>;

export const harnessExecutionPlanSchema = z.object({
  revision: z.number().int().positive().max(10),
  goal: z.string().min(1).max(420),
  steps: z.array(harnessPlanStepSchema).min(1).max(16),
  currentStepId: z.string().min(1).max(80).optional(),
  allowedTools: z.array(harnessToolNameSchema).max(6),
  replanReason: z.string().min(1).max(500).optional(),
}).strict();
export type HarnessExecutionPlan = z.infer<typeof harnessExecutionPlanSchema>;

export const harnessVerificationCheckSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9_-]+$/),
  label: z.string().min(1).max(120),
  status: z.enum(["passed", "failed"]),
  detail: z.string().min(1).max(360),
}).strict();
export type HarnessVerificationCheck = z.infer<typeof harnessVerificationCheckSchema>;

export const harnessVisualScreenshotEvidenceSchema = z.object({
  viewport: z.object({
    width: z.number().int().min(320).max(3_840),
    height: z.number().int().min(480).max(2_160),
  }).strict(),
  pageUrl: z.string().url().max(500),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  byteLength: z.number().int().positive().max(8 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type HarnessVisualScreenshotEvidence = z.infer<typeof harnessVisualScreenshotEvidenceSchema>;

export const harnessImageAttachmentManifestSchema = z.object({
  id: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/u),
  fileName: z.string().trim().min(1).max(180),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  byteLength: z.number().int().positive().max(MAX_HARNESS_IMAGE_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
}).strict();
export type HarnessImageAttachmentManifest = z.infer<typeof harnessImageAttachmentManifestSchema>;

export const harnessUserImageEvidenceSchema = z.object({
  source: z.literal("uploaded-image-multimodal"),
  summary: z.string().trim().min(1).max(1_600),
  visibleText: z.array(z.string().trim().min(1).max(360)).max(20),
  findings: z.array(z.string().trim().min(1).max(500)).max(12),
  uncertainties: z.array(z.string().trim().min(1).max(360)).max(6),
  images: z.array(harnessImageAttachmentManifestSchema).min(1).max(MAX_HARNESS_IMAGE_ATTACHMENTS),
  model: z.string().min(1).max(160),
  analyzedAt: z.iso.datetime(),
  usage: harnessModelUsageSchema.optional(),
}).strict();
export type HarnessUserImageEvidence = z.infer<typeof harnessUserImageEvidenceSchema>;

export const harnessVisualVerificationEvidenceSchema = z.object({
  required: z.boolean(),
  status: z.enum(["passed", "failed", "unavailable", "deferred"]),
  source: z.literal("playwright-multimodal"),
  summary: z.string().min(1).max(600),
  model: z.string().min(1).max(160).optional(),
  capturedAt: z.iso.datetime().optional(),
  screenshots: z.array(harnessVisualScreenshotEvidenceSchema).max(3),
  checks: z.array(harnessVerificationCheckSchema).max(8),
  issues: z.array(z.string().min(1).max(360)).max(6),
  usage: harnessModelUsageSchema.optional(),
}).strict();
export type HarnessVisualVerificationEvidence = z.infer<typeof harnessVisualVerificationEvidenceSchema>;

export const harnessTaskVerificationSchema = z.object({
  attempt: z.number().int().nonnegative().max(3),
  status: z.enum(["pending", "passed", "replan", "failed"]),
  checks: z.array(harnessVerificationCheckSchema).max(12),
  issues: z.array(z.string().min(1).max(360)).max(6),
  evidenceToolCallIds: z.array(z.string().min(1).max(160)).max(15),
  visualEvidence: harnessVisualVerificationEvidenceSchema.optional(),
}).strict();
export type HarnessTaskVerification = z.infer<typeof harnessTaskVerificationSchema>;

export const harnessTaskSummarySchema = z.object({
  id: z.string().min(1).max(160),
  idempotencyKey: z.string().min(8).max(160).regex(/^[A-Za-z0-9_-]+$/),
  instruction: z.string().min(1).max(MAX_HARNESS_INSTRUCTION_LENGTH),
  pageId: z.string().min(1).max(120),
  role: z.enum(["viewer", "editor", "admin"]),
  state: harnessStateSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  events: z.array(harnessEventSchema).max(MAX_HARNESS_EVENTS),
  counters: harnessCountersSchema,
  resultMessage: z.string().max(2_000).optional(),
  pendingChangeSet: changeSetSchema.optional(),
  exportArtifact: excelExportArtifactSchema.optional(),
  error: z.string().max(1_000).optional(),
  model: z.string().min(1).max(160).optional(),
  usage: harnessModelUsageSchema.optional(),
  contextUsage: harnessContextUsageSchema.optional(),
  semanticIntent: harnessSemanticIntentDecisionSchema.optional(),
  skills: z.array(harnessSkillSummarySchema).max(3).optional(),
  workingMemory: harnessWorkingMemorySchema.optional(),
  executionPlan: harnessExecutionPlanSchema.optional(),
  verification: harnessTaskVerificationSchema.optional(),
  totalDurationMs: z.number().int().nonnegative().optional(),
  executionTiming: harnessExecutionTimingSchema.optional(),
  retryOfTaskId: z.string().min(1).max(160).optional(),
  terminationCode: harnessTerminationCodeSchema.optional(),
}).strict();
export type HarnessTaskSummary = z.infer<typeof harnessTaskSummarySchema>;

const harnessPublicRequestShape = {
  idempotencyKey: z.string().min(8).max(160).regex(/^[A-Za-z0-9_-]+$/),
  instruction: z.string().trim().min(1).max(MAX_HARNESS_INSTRUCTION_LENGTH),
  pageId: z.string().min(1).max(120),
  dataSourceId: z.string().min(1).max(160).optional(),
  conversationContext: z.object({
    previousInstruction: z.string().trim().min(1).max(1_000).optional(),
    previousAssistantMessage: z.string().trim().min(1).max(2_000).optional(),
    workingMemory: harnessWorkingMemorySchema.optional(),
  }).strict().optional(),
  appSpec: appSpecSchema,
  recipes: z.array(dataRecipeSchema).max(20),
  edsWorkspace: edsWorkspaceSnapshotSchema.optional(),
  retryOfTaskId: z.string().min(1).max(160).optional(),
} as const;

export const harnessPublicRequestSchema = z.object(harnessPublicRequestShape).strict();
export type HarnessPublicRequest = z.infer<typeof harnessPublicRequestSchema>;

export const harnessRawWorkbookManifestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/u),
  sheets: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    rowCount: z.number().int().nonnegative().max(50_000),
    columnCount: z.number().int().nonnegative().max(100),
  }).strict()).min(1).max(10),
}).strict();
export type HarnessRawWorkbookManifest = z.infer<typeof harnessRawWorkbookManifestSchema>;

export const harnessRequestSchema = z.object({
  ...harnessPublicRequestShape,
  role: z.enum(["viewer", "editor", "admin"]),
  rawWorkbookManifest: harnessRawWorkbookManifestSchema.optional(),
  imageAttachmentManifest: z.array(harnessImageAttachmentManifestSchema).max(MAX_HARNESS_IMAGE_ATTACHMENTS).optional(),
  userImageEvidence: harnessUserImageEvidenceSchema.optional(),
}).strict();
export type HarnessRequest = z.infer<typeof harnessRequestSchema>;

export const harnessResponseSchema = z.object({ task: harnessTaskSummarySchema }).strict();
export type HarnessResponse = z.infer<typeof harnessResponseSchema>;

const harnessTurnMessageSchema = z.string().trim().min(1).max(2_000);

export const harnessCallToolTurnSchema = z.object({
  type: z.literal("callTool"),
  message: harnessTurnMessageSchema,
  toolCallId: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/),
  name: z.string().min(1).max(120),
  arguments: z.record(z.string(), z.unknown()),
}).strict();

export const harnessCompleteTurnSchema = z.object({
  type: z.literal("complete"),
  message: harnessTurnMessageSchema,
}).strict();

export const harnessBlockedTurnSchema = z.object({
  type: z.literal("blocked"),
  message: harnessTurnMessageSchema,
  missingRequirements: z.array(z.string().trim().min(1).max(240)).min(1).max(20),
}).strict();

export const harnessModelTurnSchema = z.discriminatedUnion("type", [
  harnessCallToolTurnSchema,
  harnessCompleteTurnSchema,
  harnessBlockedTurnSchema,
]);
export type HarnessModelTurn = z.infer<typeof harnessModelTurnSchema>;

export interface HarnessModelUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface HarnessModelResult {
  turn: HarnessModelTurn;
  model: string;
  usage: HarnessModelUsage;
}

export interface HarnessObservation {
  toolCallId: string;
  toolName: HarnessToolName;
  summary: string;
  data: unknown;
}

export interface HarnessEditableNodeSummary {
  pageId: string;
  nodeId: string;
  type: string;
  parentId?: string;
  editableProperties: string[];
  currentValues: Record<string, string | number | boolean>;
}

export interface HarnessModelInput {
  tools: Array<{ name: HarnessToolName; description: string; parameters: Record<string, unknown>; mode: "readOnly" | "changePreview" }>;
  context: Record<string, unknown>;
  estimatedInputChars: number;
  iteration: number;
  signal: AbortSignal;
}

export interface HarnessModel {
  classifyIntent?(input: HarnessSemanticIntentInput): Promise<HarnessSemanticIntentResult>;
  next(input: HarnessModelInput): Promise<HarnessModelResult>;
}

export interface HarnessToolExecutionResult {
  summary: string;
  data: unknown;
  pendingChangeSet?: ChangeSet;
  exportArtifact?: ExcelExportArtifact;
}

export interface HarnessRecipeCollection {
  recipes: DataRecipe[];
}
