import { z } from "zod";
import type { ChangeSet, DataRecipe } from "@/core/models";
import { appSpecSchema, changeSetSchema, dataRecipeSchema } from "@/core/schemas";

export const MAX_HARNESS_INSTRUCTION_LENGTH = 1_000;
export const MAX_HARNESS_REQUEST_BYTES = 180_000;
export const MAX_HARNESS_EVENTS = 80;
export const MAX_HARNESS_TASKS = 20;

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

export const harnessToolNameSchema = z.enum([
  "inspectDataset",
  "inspectFields",
  "previewDataRecipe",
  "validateDataRecipe",
  "inspectAppSpec",
  "createChangeSetPreview",
]);
export type HarnessToolName = z.infer<typeof harnessToolNameSchema>;

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

export const harnessContextUsageSchema = z.object({
  totalInputChars: z.number().int().nonnegative(),
  requests: z.array(z.object({
    iteration: z.number().int().positive(),
    inputChars: z.number().int().nonnegative(),
    compacted: z.boolean(),
  }).strict()).max(8),
}).strict();

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
  error: z.string().max(1_000).optional(),
  model: z.string().min(1).max(160).optional(),
  usage: harnessModelUsageSchema.optional(),
  contextUsage: harnessContextUsageSchema.optional(),
  totalDurationMs: z.number().int().nonnegative().optional(),
}).strict();
export type HarnessTaskSummary = z.infer<typeof harnessTaskSummarySchema>;

export const harnessRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(160).regex(/^[A-Za-z0-9_-]+$/),
  instruction: z.string().trim().min(1).max(MAX_HARNESS_INSTRUCTION_LENGTH),
  pageId: z.string().min(1).max(120),
  appSpec: appSpecSchema,
  recipes: z.array(dataRecipeSchema).max(10),
  role: z.enum(["viewer", "editor", "admin"]),
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
  next(input: HarnessModelInput): Promise<HarnessModelResult>;
}

export interface HarnessToolExecutionResult {
  summary: string;
  data: unknown;
  pendingChangeSet?: ChangeSet;
}

export interface HarnessRecipeCollection {
  recipes: DataRecipe[];
}
