import { z } from "zod";

export const agentEngineIdSchema = z.enum(["harness", "dsh"]);
export type AgentEngineId = z.infer<typeof agentEngineIdSchema>;
export const agentEngineSettingsSchema = z.object({
  engine: agentEngineIdSchema,
  revision: z.number().int().nonnegative(),
  activeTasks: z.number().int().nonnegative(),
  persistence: z.literal("process-memory"),
  dsh: z.object({ available: z.boolean(), reason: z.string().optional(), version: z.string().optional(),
    phase: z.enum(["node", "installation", "sdk_import", "carrier_import", "ready"]).optional(),
    code: z.enum(["node_unsupported", "installation_unavailable", "module_not_found", "unsupported_module_url",
      "module_loader_unavailable", "sdk_export_missing", "sdk_import_failed", "carrier_import_failed"]).optional(),
  }).strict(),
  plugins: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), tools: z.array(z.string()) }).strict()),
}).strict();
export type AgentEngineSettings = z.infer<typeof agentEngineSettingsSchema>;
export const agentEngineSelectionSchema = z.object({
  engine: agentEngineIdSchema,
  revision: z.number().int().nonnegative(),
}).strict();

// Engine-neutral task contract. Provider clients and credentials are server-only.
export interface AgentExecutionEngine<Request, Context, Result> {
  readonly id: AgentEngineId;
  run(request: Request, context: Context): Promise<Result>;
}
