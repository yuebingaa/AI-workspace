import { z } from "zod";

export const harnessMcpToolPolicySchema = z.enum(["readOnly", "trusted", "disabled"]);
export type HarnessMcpToolPolicy = z.infer<typeof harnessMcpToolPolicySchema>;

const identifierSchema = z.string().trim().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/u);
const toolNameSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9_.:/-]+$/u);
const environmentNameSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
const toolNameListSchema = z.array(toolNameSchema).max(128);

const httpTransportSchema = z.object({
  type: z.literal("http"),
  url: z.url().max(2_000),
  bearerTokenEnvVar: environmentNameSchema.optional(),
  headersFromEnv: z.record(z.string().trim().min(1).max(120), environmentNameSchema).optional(),
}).strict();

const stdioTransportSchema = z.object({
  type: z.literal("stdio"),
  command: z.string().trim().min(1).max(1_000),
  args: z.array(z.string().max(2_000)).max(64).optional(),
  cwd: z.string().trim().min(1).max(2_000).optional(),
  envVars: z.array(environmentNameSchema).max(64).optional(),
}).strict();

export const harnessMcpServerConfigSchema = z.object({
  id: identifierSchema,
  enabled: z.boolean().default(true),
  required: z.boolean().default(false),
  transport: z.discriminatedUnion("type", [httpTransportSchema, stdioTransportSchema]),
  enabledTools: toolNameListSchema.optional(),
  disabledTools: toolNameListSchema.optional(),
  defaultPolicy: harnessMcpToolPolicySchema.default("readOnly"),
  toolPolicies: z.record(toolNameSchema, harnessMcpToolPolicySchema).default({}),
  allowDestructive: z.boolean().default(false),
  allowOpenWorld: z.boolean().default(false),
  startupTimeoutMs: z.number().int().min(100).max(60_000).default(10_000),
  toolTimeoutMs: z.number().int().min(100).max(120_000).default(30_000),
}).strict();
export type HarnessMcpServerConfig = z.infer<typeof harnessMcpServerConfigSchema>;

export const harnessMcpConfigSchema = z.object({
  version: z.literal(1),
  servers: z.array(harnessMcpServerConfigSchema).max(16),
}).strict().superRefine((config, context) => {
  const ids = new Set<string>();
  for (const [index, server] of config.servers.entries()) {
    if (ids.has(server.id)) {
      context.addIssue({ code: "custom", path: ["servers", index, "id"], message: `MCP server id 重复：${server.id}` });
    }
    ids.add(server.id);
  }
});
export type HarnessMcpConfig = z.infer<typeof harnessMcpConfigSchema>;

export const harnessMcpToolAnnotationsSchema = z.object({
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
}).strict();
export type HarnessMcpToolAnnotations = z.infer<typeof harnessMcpToolAnnotationsSchema>;

export const harnessMcpToolSummarySchema = z.object({
  serverId: identifierSchema,
  name: toolNameSchema,
  description: z.string().trim().min(1).max(360),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: harnessMcpToolAnnotationsSchema,
  policy: z.enum(["readOnly", "trusted"]),
}).strict();
export type HarnessMcpToolSummary = z.infer<typeof harnessMcpToolSummarySchema>;

export interface HarnessMcpCall {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

export interface HarnessMcpCallResult {
  summary: string;
  data: unknown;
}

export interface HarnessMcpRuntime {
  catalog(): HarnessMcpToolSummary[];
  call(input: HarnessMcpCall, signal?: AbortSignal): Promise<HarnessMcpCallResult>;
  diagnostics(): Array<{ serverId: string; status: "connected" | "unavailable"; message: string }>;
  close(): Promise<void>;
}
