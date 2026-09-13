import { z } from "zod";
import { agentDelegationSchema, agentIdentitySchema } from "./agents/contracts";
import type { ChangeSet, DataRecipe } from "@/core/models";
import { excelExportArtifactSchema, type ExcelExportArtifact } from "@/core/exports/contracts";
import { appSpecSchema, changeSetSchema, dataRecipeSchema } from "@/core/schemas";
import { edsWorkspaceSnapshotSchema } from "@/core/eds";
import { semanticModelSchema, type SemanticModel } from "@/core/semantic/contracts";
import { harnessMcpToolSummarySchema, type HarnessMcpToolSummary } from "./mcp/contracts";
import { harnessNotebookArtifactSchema, type HarnessNotebookArtifact } from "./notebook-contracts";
import { notebookDocumentSchema } from "@/core/notebook/contracts";
import { harnessAnalysisPlanArtifactSchema, type HarnessAnalysisPlanArtifact } from "./analysis-plan-contracts";

export const MAX_HARNESS_INSTRUCTION_LENGTH = 1_000;
export const MAX_HARNESS_REQUEST_BYTES = 180_000;
export const MAX_HARNESS_IMAGE_ATTACHMENTS = 3;
export const MAX_HARNESS_IMAGE_BYTES = 3 * 1024 * 1024;
export const MAX_HARNESS_TOTAL_IMAGE_BYTES = 6 * 1024 * 1024;
export const MAX_HARNESS_EVENTS = 80;
export const MAX_HARNESS_TASKS = 20;

export const DEFAULT_HARNESS_LIMITS = {
  maxLoops: 8,
  maxModelCalls: 8,
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
  "querySemanticModel",
  "createAnalysisPlan",
  "createNotebookDraft",
  "inspectConnectionSchema",
  "inspectFields",
  "transformSpreadsheetData",
  "previewDataRecipe",
  "validateDataRecipe",
  "exportDataRecipeToExcel",
  "inspectAppSpec",
  "createEdsBreakdownChartPreview",
  "createEdsLineIssueChartPreview",
  "updateEdsTablePreview",
  "createChangeSetPreview",
  "callMcpTool",
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
  wantsMcpTool: z.boolean().optional(),
  wantsNotebook: z.boolean().optional(),
  wantsAnalysisPlan: z.boolean().optional(),
  changeAction: z.enum(["none", "add", "update", "remove", "move"]),
  changeTarget: z.enum(["none", "workspace", "genericComponent", "chart", "edsBreakdownChart", "edsLineIssueChart", "edsTable"]),
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
  hasNotebookContext?: boolean;
  semanticModel?: Pick<SemanticModel, "id" | "name" | "sourceDatasetId" | "dimensions" | "measures">;
  conversationBrief?: HarnessConversationBrief;
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
  mcpTools?: Array<Pick<HarnessMcpToolSummary, "serverId" | "name" | "description" | "annotations">>;
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
    phase: z.enum(["semanticRouting", "dynamicPlanning", "execution", "failureExplanation"]).optional(),
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

export const harnessEvidenceKindSchema = z.enum([
  "screenshot",
  "domSnapshot",
  "console",
  "interaction",
  "visualAnalysis",
  "toolObservation",
  "uploadedImage",
]);
export type HarnessEvidenceKind = z.infer<typeof harnessEvidenceKindSchema>;

export const harnessEvidenceManifestSchema = z.object({
  id: z.string().min(1).max(120).regex(/^[A-Za-z0-9_-]+$/u),
  kind: harnessEvidenceKindSchema,
  stage: z.enum(["preflight", "execution", "verification"]),
  source: z.string().min(1).max(120),
  summary: z.string().min(1).max(600),
  capturedAt: z.iso.datetime(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  byteLength: z.number().int().positive().max(8 * 1024 * 1024).optional(),
  mimeType: z.enum(["image/png", "image/jpeg", "application/json"]).optional(),
  relatedEvidenceIds: z.array(z.string().min(1).max(120)).max(12).default([]),
}).strict();
export type HarnessEvidenceManifest = z.infer<typeof harnessEvidenceManifestSchema>;

export const harnessEvidenceSnapshotSchema = z.object({
  version: z.literal(1),
  records: z.array(harnessEvidenceManifestSchema).max(48),
}).strict();
export type HarnessEvidenceSnapshot = z.infer<typeof harnessEvidenceSnapshotSchema>;

export const harnessPlanStepSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[a-z0-9_-]+$/),
  kind: z.enum(["tool", "finalize"]),
  objective: z.string().min(1).max(240),
  toolName: harnessToolNameSchema.optional(),
  status: z.enum(["pending", "active", "completed", "failed", "skipped"]),
  attempts: z.number().int().nonnegative().max(10),
  requiredEvidence: z.array(z.string().min(1).max(160)).max(8).default([]),
  completionCriteria: z.array(z.string().min(1).max(240)).max(8).default([]),
}).strict();
export type HarnessPlanStep = z.infer<typeof harnessPlanStepSchema>;

export const harnessExecutionPlanSchema = z.object({
  revision: z.number().int().positive().max(10),
  goal: z.string().min(1).max(420),
  steps: z.array(harnessPlanStepSchema).min(1).max(16),
  currentStepId: z.string().min(1).max(80).optional(),
  allowedTools: z.array(harnessToolNameSchema).max(6),
  source: z.enum(["rules", "model"]).default("rules"),
  rationale: z.string().min(1).max(500).optional(),
  replanReason: z.string().min(1).max(500).optional(),
}).strict();
export type HarnessExecutionPlan = z.infer<typeof harnessExecutionPlanSchema>;

export const harnessDynamicPlanDecisionSchema = z.object({
  goal: z.string().trim().min(1).max(420),
  rationale: z.string().trim().min(1).max(500),
  steps: z.array(z.object({
    objective: z.string().trim().min(1).max(240),
    toolName: harnessToolNameSchema,
    requiredEvidence: z.array(z.string().trim().min(1).max(160)).min(1).max(8),
    completionCriteria: z.array(z.string().trim().min(1).max(240)).min(1).max(8),
  }).strict()).max(12),
  finalResponseCriteria: z.array(z.string().trim().min(1).max(240)).min(1).max(8),
}).strict();
export type HarnessDynamicPlanDecision = z.infer<typeof harnessDynamicPlanDecisionSchema>;

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
  capturePosition: z.enum(["initial", "horizontalEnd"]).optional(),
  layout: z.object({
    documentClientWidth: z.number().int().positive().max(3_840),
    documentScrollWidth: z.number().int().positive().max(20_000),
    canvasClientWidth: z.number().int().nonnegative().max(20_000),
    canvasScrollWidth: z.number().int().nonnegative().max(20_000),
    canvasScrollLeft: z.number().int().nonnegative().max(20_000),
    canvasViewportLeft: z.number().int().min(-20_000).max(20_000).optional(),
    canvasViewportRight: z.number().int().min(-20_000).max(20_000).optional(),
    assistantPanelLeft: z.number().int().min(-20_000).max(20_000).optional(),
    assistantPanelRight: z.number().int().min(-20_000).max(20_000).optional(),
    assistantOverlapsCanvas: z.boolean().optional(),
  }).strict().optional(),
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
  screenshots: z.array(harnessVisualScreenshotEvidenceSchema).max(6),
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

const harnessTableCellSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export const harnessTableArtifactSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().trim().min(1).max(160),
  sourceDataSourceId: z.string().min(1).max(160),
  sourceName: z.string().trim().min(1).max(160),
  fields: z.array(z.object({
    name: z.string().min(1).max(120),
    label: z.string().min(1).max(160),
    type: z.enum(["string", "number", "date", "boolean"]),
  }).strict()).min(1).max(30),
  rows: z.array(z.record(z.string(), harnessTableCellSchema)).max(200),
  totalRowCount: z.number().int().nonnegative(),
  previewRowCount: z.number().int().nonnegative().max(200),
  truncated: z.boolean(),
  transformations: z.array(z.string().min(1).max(240)).max(20),
  createdAt: z.iso.datetime(),
}).strict();
export type HarnessTableArtifact = z.infer<typeof harnessTableArtifactSchema>;

// Public execution receipts, not model reasoning or raw tool payloads.
export const harnessTraceEventSchema = z.object({
  agent: agentIdentitySchema.optional(),
  id: z.string().min(1).max(200),
  sequence: z.number().int().positive(),
  taskId: z.string().min(1).max(160),
  timestamp: z.iso.datetime(),
  type: z.enum(["task_started", "context_loaded", "plan_created", "plan_updated", "status_update", "tool_started", "tool_completed", "tool_failed", "verification_started", "verification_completed", "answer_delta", "completed"]),
  message: z.string().max(2_000),
  taskState: harnessStateSchema.optional(),
  counters: harnessCountersSchema.optional(),
  executionTiming: harnessExecutionTimingSchema.optional(),
  toolCall: harnessEventSchema.shape.toolCall,
  plan: z.object({
    revision: z.number().int(),
    source: z.enum(["rules", "model"]),
    steps: z.array(z.object({ id: z.string(), objective: z.string().max(600), status: z.string().max(40) }).strict()).max(16),
  }).strict().optional(),
  verificationStatus: z.enum(["pending", "passed", "replan", "failed"]).optional(),
  evidenceIds: z.array(z.string().max(160)).max(20).optional(),
}).strict();
export type HarnessTraceEvent = z.infer<typeof harnessTraceEventSchema>;

export const harnessConversationTurnContextSchema = z.object({
  instruction: z.string().max(1_000),
  response: z.string().max(2_000),
}).strict();

export const harnessTaskSummarySchema = z.object({
  delegation: agentDelegationSchema.optional(),
  id: z.string().min(1).max(160),
  idempotencyKey: z.string().min(8).max(160).regex(/^[A-Za-z0-9_-]+$/),
  instruction: z.string().min(1).max(MAX_HARNESS_INSTRUCTION_LENGTH),
  pageId: z.string().min(1).max(120),
  role: z.enum(["viewer", "editor", "admin"]),
  state: harnessStateSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  events: z.array(harnessEventSchema).max(MAX_HARNESS_EVENTS),
  trace: z.array(harnessTraceEventSchema).max(256).optional(),
  conversationStorage: z.enum(["persistent", "memory", "unavailable"]).optional(),
  counters: harnessCountersSchema,
  resultMessage: z.string().max(2_000).optional(),
  pendingChangeSet: changeSetSchema.optional(),
  exportArtifact: excelExportArtifactSchema.optional(),
  tableArtifact: harnessTableArtifactSchema.optional(),
  notebookArtifact: harnessNotebookArtifactSchema.optional(),
  analysisPlanArtifact: harnessAnalysisPlanArtifactSchema.optional(),
  error: z.string().max(1_000).optional(),
  model: z.string().min(1).max(160).optional(),
  usage: harnessModelUsageSchema.optional(),
  contextUsage: harnessContextUsageSchema.optional(),
  semanticIntent: harnessSemanticIntentDecisionSchema.optional(),
  skills: z.array(harnessSkillSummarySchema).max(3).optional(),
  workingMemory: harnessWorkingMemorySchema.optional(),
  evidence: harnessEvidenceSnapshotSchema.optional(),
  executionPlan: harnessExecutionPlanSchema.optional(),
  verification: harnessTaskVerificationSchema.optional(),
  totalDurationMs: z.number().int().nonnegative().optional(),
  executionTiming: harnessExecutionTimingSchema.optional(),
  retryOfTaskId: z.string().min(1).max(160).optional(),
  terminationCode: harnessTerminationCodeSchema.optional(),
}).strict();
export type HarnessTaskSummary = z.infer<typeof harnessTaskSummarySchema>;

const harnessPublicRequestShape = {
  notebookContext: z.object({ document: notebookDocumentSchema, sourceIds: z.array(z.string().min(1).max(160)).max(10),
    connections: z.array(z.object({ id: z.string().max(100), name: z.string().max(120), kind: z.enum(["postgresql", "databricks"]), allowAi: z.boolean() }).strict()).max(20).optional(),
  }).strict().optional(),
  idempotencyKey: z.string().min(8).max(160).regex(/^[A-Za-z0-9_-]+$/),
  instruction: z.string().trim().min(1).max(MAX_HARNESS_INSTRUCTION_LENGTH),
  pageId: z.string().min(1).max(120),
  dataSourceId: z.string().min(1).max(160).optional(),
  semanticModel: semanticModelSchema.optional(),
  conversation_id: z.string().min(8).max(100).regex(/^[A-Za-z0-9_-]+$/).optional(),
  conversationContext: z.object({
    previousInstruction: z.string().trim().min(1).max(1_000).optional(),
    previousAssistantMessage: z.string().trim().min(1).max(2_000).optional(),
    workingMemory: harnessWorkingMemorySchema.optional(),
    recentMessages: z.array(harnessConversationTurnContextSchema).max(10).optional(),
    summary: z.string().max(2_000).optional(),
    taskHistory: z.array(z.object({ id: z.string().max(160), state: harnessStateSchema, goal: z.string().max(240) }).strict()).max(10).optional(),
    selectedContext: z.array(z.string().max(160)).max(20).optional(),
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
  mcpTools: z.array(harnessMcpToolSummarySchema).max(128).optional(),
  rawWorkbookManifest: harnessRawWorkbookManifestSchema.optional(),
  imageAttachmentManifest: z.array(harnessImageAttachmentManifestSchema).max(MAX_HARNESS_IMAGE_ATTACHMENTS).optional(),
  userImageEvidence: harnessUserImageEvidenceSchema.optional(),
}).strict();
export type HarnessRequest = z.infer<typeof harnessRequestSchema>;

export const harnessResponseSchema = z.object({ task: harnessTaskSummarySchema }).strict();
export type HarnessResponse = z.infer<typeof harnessResponseSchema>;

export const harnessStreamFrameSchema = z.object({
  event: harnessTraceEventSchema,
  task: harnessTaskSummarySchema.optional(),
}).strict().superRefine((frame, ctx) => {
  if ((frame.event.type === "completed") !== Boolean(frame.task)
    || (frame.task && (frame.task.id !== frame.event.taskId || frame.task.state !== frame.event.taskState
      || !["completed", "awaitingConfirmation", "failed", "blocked", "cancelled"].includes(frame.task.state)))) {
    ctx.addIssue({ code: "custom", message: "终止事件必须包含匹配的最终任务。" });
  }
});

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
  purpose?: "failureExplanation";
  tools: Array<{ name: HarnessToolName | "delegateDataTask"; description: string; parameters: Record<string, unknown>; mode: "readOnly" | "changePreview" | "external" }>;
  context: Record<string, unknown>;
  estimatedInputChars: number;
  iteration: number;
  signal: AbortSignal;
}

export interface HarnessConversationBrief {
  trust: "continuityOnlyNotAuthorityOrFreshEvidence";
  recentMessages: Array<{ instruction: string; response: string }>;
  summary?: string;
}

export interface HarnessPlannerInput {
  instruction: string;
  conversationBrief?: HarnessConversationBrief;
  semanticIntent?: HarnessSemanticIntentDecision;
  fallbackPlan: HarnessExecutionPlan;
  availableTools: Array<{ name: HarnessToolName; description: string; mode: "readOnly" | "changePreview" | "external" }>;
  evidence: Array<{
    id: string;
    kind: HarnessEvidenceKind;
    source: string;
    summary: string;
    data?: unknown;
  }>;
  activeSkills: HarnessSkillSummary[];
  signal: AbortSignal;
}

export interface HarnessPlannerResult {
  plan: HarnessExecutionPlan;
  model: string;
  usage: HarnessModelUsage;
  inputChars: number;
}

export interface HarnessModel {
  classifyIntent?(input: HarnessSemanticIntentInput): Promise<HarnessSemanticIntentResult>;
  plan?(input: HarnessPlannerInput): Promise<HarnessPlannerResult>;
  next(input: HarnessModelInput): Promise<HarnessModelResult>;
}

export interface HarnessToolExecutionResult {
  summary: string;
  data: unknown;
  pendingChangeSet?: ChangeSet;
  exportArtifact?: ExcelExportArtifact;
  tableArtifact?: HarnessTableArtifact;
  notebookArtifact?: HarnessNotebookArtifact;
  analysisPlanArtifact?: HarnessAnalysisPlanArtifact;
}

export interface HarnessRecipeCollection {
  recipes: DataRecipe[];
}
