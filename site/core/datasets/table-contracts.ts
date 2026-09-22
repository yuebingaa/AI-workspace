import { z } from "zod";

/** Portable table metadata; no UI, query executor or Notebook policy. */
export const dataFieldSchema = z.object({
  name: z.string().min(1).max(120), label: z.string().min(1).max(160),
  type: z.enum(["string", "number", "date", "boolean"]),
}).strict();

// Dates and exact large integers/decimals stay strings; never coerce wire values.
export const dataValueSchema = z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()]);

/** Materialized table shape only. Each producer retains its own execution/row budgets. */
export const dataTableSchema = z.object({
  fields: z.array(dataFieldSchema).min(1).max(100),
  rows: z.array(z.record(z.string(), dataValueSchema)),
  truncated: z.boolean(),
}).strict();

export type DataTable = z.infer<typeof dataTableSchema>;
