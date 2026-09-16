import { z } from "zod";
import { configuredSnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
import type { NotebookQueryLogEntry } from "../execution-contracts";
import { catalogReferenceSchema } from "@/core/metadata/contracts";

const logEntrySchema: z.ZodType<NotebookQueryLogEntry> = z.object({
  id: z.string(), taskId: z.string(), userId: z.string(), connectionId: z.string().max(100),
  cellId: z.string(), startedAt: z.string(), durationMs: z.number(), status: z.string(), sql: z.string().max(10_000),
  sourceIds: z.array(z.string()), returnedRows: z.number(), truncated: z.boolean(), bytesScanned: z.null(),
  runId: z.string().max(160).optional(), revision: z.number().int().nonnegative().optional(),
  inputResultIds: z.array(z.string().max(240)).max(10).optional(), catalogRef: catalogReferenceSchema.optional(),
}).strict();
const logSchema = z.object({ version: z.literal(1), queries: z.array(logEntrySchema).max(100) }).strict();

// Protected local receipts, no result rows or credentials; retain the existing v1 file.
export function recordNotebookQuery(entry: NotebookQueryLogEntry): void {
  const adapter = configuredSnapshotAdapter("notebook-query-log.json", logSchema, 2 * 1024 * 1024);
  if (!adapter) return;
  const existing = adapter.load();
  adapter.save({ version: 1, queries: [...(existing?.queries ?? []), entry].slice(-100) });
}
