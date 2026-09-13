import { z } from "zod";

export const connectionIdSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/u);
// Public metadata only. No URL, password, token, or arbitrary client credentials.
export const connectionDescriptorSchema = z.object({
  id: connectionIdSchema, name: z.string().min(1).max(120),
  kind: z.enum(["postgresql", "databricks"]), allowAi: z.boolean(),
}).strict();
export type ConnectionDescriptor = z.infer<typeof connectionDescriptorSchema>;
export const connectionCatalogSchema = z.object({ connections: z.array(connectionDescriptorSchema).max(20) }).strict();
export const connectionColumnSchema = z.object({
  table_schema: z.string().max(240), table_name: z.string().max(240),
  column_name: z.string().max(240), data_type: z.string().max(240),
}).strict();
export const connectionSchemaSchema = z.object({
  columns: z.array(connectionColumnSchema).max(500), truncated: z.boolean(),
}).strict();
export type ConnectionSchema = z.infer<typeof connectionSchemaSchema>;
