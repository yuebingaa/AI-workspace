import { z } from "zod";
import { assistantConversationTurnSchema } from "@/core/harness/conversation";

export const DSH_WEB_CHANNEL = "agentcanvas-dsh-web";
const commandId = z.string().min(1).max(160).regex(/^[A-Za-z0-9_.:-]+$/u);
const envelope = { channel: z.literal(DSH_WEB_CHANNEL), nonce: z.string().uuid() };

// Display DTO only. Never send AppSpec, raw tasks, project handles or credentials.
export const dshWebSnapshotSchema = z.object({
  version: z.literal(1),
  session: z.object({ id: z.string().min(1).max(160), title: z.string().max(200) }).strict(),
  turns: z.array(assistantConversationTurnSchema.pick({ id: true, instruction: true, response: true, createdAt: true, state: true })
    .extend({ requestId: commandId.optional() }).strict()).max(20),
  draft: z.string().max(1_000), busy: z.boolean(), canSend: z.boolean(),
  pendingInstruction: z.string().max(1_000), pendingRequestId: commandId.optional(),
  statusText: z.string().max(1_000),
  progress: z.object({ taskId: z.string().min(1).max(160), steps: z.array(z.object({
    id: z.string().min(1).max(200), message: z.string().max(600), state: z.enum(["running", "done", "failure", "stopped"]),
    detail: z.string().max(1000).optional(), cellId: z.string().min(1).max(120).optional(),
  }).strict()).max(80) }).strict().optional(),
}).strict();
export type DshWebSnapshot = z.infer<typeof dshWebSnapshotSchema>;

export const dshWebCommandSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("ready") }).strict(),
  z.object({ ...envelope, type: z.literal("mounted") }).strict(),
  z.object({ ...envelope, type: z.literal("draft"), text: z.string().max(1_000) }).strict(),
  z.object({ ...envelope, type: z.literal("locate-cell"), taskId: z.string().min(1).max(160), cellId: z.string().min(1).max(120) }).strict(),
  z.object({ ...envelope, type: z.literal("send"), requestId: commandId, text: z.string().trim().min(1).max(1_000) }).strict(),
  z.object({ ...envelope, type: z.literal("cancel"), requestId: commandId }).strict(),
]);

export function readDshWebCommand(event: { source: unknown; origin: string; data: unknown },
  expectedSource: unknown, origin: string, nonce: string) {
  if (!expectedSource || event.source !== expectedSource || event.origin !== origin) return null;
  const result = dshWebCommandSchema.safeParse(event.data);
  return result.success && result.data.nonce === nonce ? result.data : null;
}
