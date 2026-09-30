import { z } from "zod";
import { notebookCellRunSchema, notebookDocumentSchema, type NotebookCellRun } from "./contracts";

const identity = { runId: z.string().min(1).max(160), revision: z.number().int().nonnegative() };
/** Execution observations, not a receipt authorizing adoption or persistence. */
export const notebookExecutionProgressSchema = z.discriminatedUnion("kind", [
  z.object({ ...identity, kind: z.literal("run_started"), cellIds: z.array(z.string().min(1).max(120)).max(30) }).strict(),
  z.object({ ...identity, kind: z.literal("cell_started"), cellId: z.string().min(1).max(120) }).strict(),
  z.object({ ...identity, kind: z.literal("cell_finished"), result: notebookCellRunSchema }).strict(),
]);
export type NotebookExecutionProgress = z.infer<typeof notebookExecutionProgressSchema>;
export type NotebookProgressObserver = (progress: NotebookExecutionProgress) => void;

export const notebookLiveProgressSchema = z.object({
  baseRevision: z.number().int().nonnegative(), editVersion: z.number().int().nonnegative(),
  update: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("draft"), document: notebookDocumentSchema,
      changedCellIds: z.array(z.string().max(120)).max(30), removedCellIds: z.array(z.string().max(120)).max(30) }).strict(),
    ...notebookExecutionProgressSchema.options,
    z.object({ ...identity, kind: z.literal("run_finished"), status: z.enum(["success", "failure"]) }).strict(),
  ]),
}).strict();
export type NotebookLiveProgress = z.infer<typeof notebookLiveProgressSchema>;

/** Display-only prefix; keep the original result identity and never expose logs/full rows. */
export function notebookProgressResult(result: NotebookCellRun): NotebookCellRun {
  const { table, textParts, ...rest } = result;
  delete rest.stdout;
  delete rest.stderr;
  // Full chart evidence belongs to the final receipt, never the bounded live prefix.
  delete rest.visualization;
  // A truncated receipt has no trustworthy Markdown boundaries; use literal display.
  const preview = { ...rest, ...(rest.text ? { text: rest.text.slice(0, 2000) } : {}),
    ...(textParts && (rest.text?.length ?? 0) <= 2000 ? { textParts } : {}) };
  if (!table) return preview;
  const rows = table.rows.slice(0, 50);
  while (rows.length && new TextEncoder().encode(JSON.stringify(rows)).byteLength > 16_000) rows.pop();
  return { ...preview, table: { ...table, rows, truncated: table.truncated || rows.length < table.rows.length } };
}
