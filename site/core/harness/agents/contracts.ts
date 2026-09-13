import { z } from "zod";

export const agentIdentitySchema = z.object({
  id: z.string().min(1).max(80),
  role: z.enum(["coordinator", "data"]),
  taskId: z.string().min(1).max(160),
  parentTaskId: z.string().min(1).max(160).optional(),
}).strict();

export const agentDelegationSchema = z.object({
  version: z.literal("data-v1"),
  coordinator: agentIdentitySchema,
  children: z.array(z.object({
    agent: agentIdentitySchema,
    status: z.enum(["pending", "running", "completed", "blocked", "failed", "cancelled"]),
    objective: z.string().min(1).max(1_000),
    evidenceIds: z.array(z.string().max(160)).max(48),
    verification: z.enum(["pending", "passed", "failed"]),
  }).strict()).max(1),
}).strict();

export type AgentIdentity = z.infer<typeof agentIdentitySchema>;
export type AgentDelegation = z.infer<typeof agentDelegationSchema>;
