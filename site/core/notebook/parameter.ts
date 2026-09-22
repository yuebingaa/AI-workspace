import { z } from "zod";
import type { DataTable } from "@/core/datasets/table-contracts";

const selectValueSchema = z.string().min(1).max(200).regex(/\S/u, "单选选项不能全为空白");

/** Literal values only: no template, code, connection or secret-input semantics. */
export const notebookParameterSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), value: z.string().max(2_000) }).strict(),
  z.object({
    type: z.literal("number"),
    value: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  }).strict(),
  z.object({ type: z.literal("date"), value: z.iso.date() }).strict(),
  z.object({
    type: z.literal("select"),
    value: selectValueSchema,
    options: z.array(selectValueSchema).min(1).max(50)
      .refine((options) => new Set(options).size === options.length, "单选选项不能重复"),
  }).strict().refine((parameter) => parameter.options.includes(parameter.value), {
    path: ["value"], message: "当前值必须属于单选选项",
  }),
]);
export type NotebookParameter = z.infer<typeof notebookParameterSchema>;

/** The existing declared-DataFrame input path carries values, never SQL source. */
export function notebookParameterTable(parameter: NotebookParameter): DataTable {
  const parsed = notebookParameterSchema.parse(parameter);
  return {
    fields: [{ name: "value", label: "value", type: parsed.type === "number" ? "number" : parsed.type === "date" ? "date" : "string" }],
    rows: [{ value: parsed.value }],
    truncated: false,
  };
}
