import { z } from "zod";

export const CATALOG_LIMITS = { columns: 500, snapshots: 60, bytes: 8 * 1024 * 1024, freshMs: 15 * 60_000 } as const;
const identifier = z.string().min(1).max(160);
const name = z.string().min(1).max(240);
export const catalogColumnInputSchema = z.object({
  catalog: name, schema: name, table: name, name, dataType: name,
}).strict();
export type CatalogColumnInput = z.infer<typeof catalogColumnInputSchema>;
export const catalogColumnSchema = catalogColumnInputSchema.extend({ tableId: identifier, columnId: identifier });
export const catalogReferenceSchema = z.object({
  id: identifier, connectionId: z.string().min(1).max(100), revision: z.number().int().positive(),
  schemaFingerprint: z.string().regex(/^[a-f0-9]{64}$/u), syncedAt: z.iso.datetime(),
  complete: z.boolean(),
}).strict();
export type CatalogReference = z.infer<typeof catalogReferenceSchema>;
export const catalogSnapshotSchema = z.object({
  reference: catalogReferenceSchema,
  columns: z.array(catalogColumnSchema).max(CATALOG_LIMITS.columns),
}).strict();
export type CatalogSnapshot = z.infer<typeof catalogSnapshotSchema>;
export const catalogSummarySchema = catalogReferenceSchema.extend({
  freshness: z.enum(["fresh", "stale"]), storage: z.enum(["persistent", "memory"]),
  tableCount: z.number().int().nonnegative().max(CATALOG_LIMITS.columns),
}).strict();
export type CatalogSummary = z.infer<typeof catalogSummarySchema>;

/** Trusted scope is supplied by the server adapter, never by an LLM or browser. */
export interface CatalogAccess { connectionId: string; project: string | null; forAi?: boolean }
export interface CatalogBinding { key: string; connectionId: string }
export interface CatalogRepository {
  readonly storage: "persistent" | "memory";
  get(key: string): CatalogSnapshot | null;
  save(key: string, snapshot: CatalogSnapshot, expectedRevision: number | null): void;
}
