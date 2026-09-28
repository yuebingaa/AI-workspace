import { z } from "zod";

const id = z.string().max(160).regex(/^@deepseek-ai\/dsh(?:-[a-z0-9]+)*$/);
export const dshInstalledPackageSchema = z.object({
  id, version: z.string().max(140).regex(/^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[a-zA-Z0-9.-]{1,60})?(?:\+[a-zA-Z0-9.-]{1,60})?$/),
  description: z.string().max(600), category: z.enum(["bundle", "client", "tool", "runtime"]),
  dependencies: z.array(id).max(100),
}).strict();
export const dshPackageInventorySchema = z.object({
  source: z.literal("managed-installation"), complete: z.boolean(),
  packages: z.array(dshInstalledPackageSchema).max(1000),
  issues: z.array(z.object({ id, code: z.literal("metadata-unavailable") }).strict()).max(1000),
}).strict().refine(value => value.complete === (value.issues.length === 0)
  && new Set([...value.packages, ...value.issues].map(row => row.id)).size === value.packages.length + value.issues.length,
{ message: "组件目录不完整或重复" });
export type DshInstalledPackage = z.infer<typeof dshInstalledPackageSchema>;
export type DshPackageInventory = z.infer<typeof dshPackageInventorySchema>;
