import { z } from "zod";

export const dshPluginConfigSchema = z.object({ skills: z.boolean() }).strict();
export type DshPluginConfig = z.infer<typeof dshPluginConfigSchema>;
export const dshPluginDocumentSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), config: dshPluginConfigSchema,
}).strict();
export type DshPluginDocument = z.infer<typeof dshPluginDocumentSchema>;
export const dshPluginUpdateSchema = z.object({ revision: z.number().int().nonnegative(), config: dshPluginConfigSchema }).strict();
export const dshPluginEntrySchema = z.object({
  id: z.string(), name: z.string(), description: z.string(),
  scope: z.enum(["session", "global"]), origin: z.enum(["official", "website"]),
  state: z.enum(["configured", "conditional", "disabled", "not-integrated", "unavailable"]),
  reason: z.string(), version: z.string().optional(), tools: z.array(z.string()),
  configurable: z.boolean(),
}).strict();
export const dshPluginSettingsSchema = z.object({
  document: dshPluginDocumentSchema, persistence: z.enum(["json-file", "unconfigured"]),
  activeTasks: z.number().int().nonnegative(), plugins: z.array(dshPluginEntrySchema),
}).strict();
export type DshPluginSettings = z.infer<typeof dshPluginSettingsSchema>;
export type DshPluginEntry = z.infer<typeof dshPluginEntrySchema>;
export function defaultDshPluginDocument(): DshPluginDocument {
  return { schemaVersion: 1, revision: 0, config: { skills: false } };
}
