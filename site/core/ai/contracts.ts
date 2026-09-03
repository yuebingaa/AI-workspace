import { z } from "zod";
import type { ChangeSet } from "@/core/models";
import { appSpecSchema, changeSetSchema } from "@/core/schemas";

export const MAX_AI_INSTRUCTION_LENGTH = 1_000;
export const MAX_AI_REQUEST_BYTES = 180_000;
export const DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-flash";

const aiPlanPublicRequestShape = {
  instruction: z.string().trim().min(1).max(MAX_AI_INSTRUCTION_LENGTH),
  pageId: z.string().trim().min(1).max(120),
  appSpec: appSpecSchema,
} as const;

export const aiPlanPublicRequestSchema = z.object(aiPlanPublicRequestShape).strict();

export type AiPlanPublicRequest = z.infer<typeof aiPlanPublicRequestSchema>;

export const aiPlanRequestSchema = z.object({
  ...aiPlanPublicRequestShape,
  role: z.enum(["viewer", "editor", "admin"]),
}).strict();

export type AiPlanRequest = z.infer<typeof aiPlanRequestSchema>;

export const aiTokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict();

export type AiTokenUsage = z.infer<typeof aiTokenUsageSchema>;

export const aiPlanMetadataSchema = z.object({
  model: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  usage: aiTokenUsageSchema,
  repairAttempted: z.boolean(),
  transport: z.enum(["responses_json_schema", "chat_function", "chat_json_object"]),
  validationIssues: z.array(z.object({
    stage: z.enum(["json_parse", "draft_schema", "compile", "changeset_validation"]),
    path: z.string().min(1).max(240),
    code: z.string().min(1).max(120),
    operationType: z.enum(["addNode", "updateNodeProps", "removeNode", "moveNode", "updatePage"]).optional(),
  }).strict()).max(12).optional(),
}).strict();

export type AiPlanMetadata = z.infer<typeof aiPlanMetadataSchema>;

export const aiGeneratedPlanSchema = z.object({
  message: z.string().trim().min(1).max(2_000),
  changeSet: changeSetSchema,
}).strict();

export interface AiGeneratedPlan {
  message: string;
  changeSet: ChangeSet;
}

export const aiPlanSuccessSchema = aiGeneratedPlanSchema.extend({
  metadata: aiPlanMetadataSchema,
}).strict();

export type AiPlanSuccess = z.infer<typeof aiPlanSuccessSchema>;

export const aiPlanErrorPayloadSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1).max(1_000),
    retryable: z.boolean(),
  }).strict(),
  metadata: aiPlanMetadataSchema.optional(),
}).strict();

export type AiPlanErrorPayload = z.infer<typeof aiPlanErrorPayloadSchema>;
