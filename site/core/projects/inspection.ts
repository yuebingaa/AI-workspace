import { z } from "zod";
import { NOTEBOOK_CELL_KINDS } from "@/core/notebook/cell-catalog";

export const PROJECT_INSPECTION_LIMITS = {
  requestBytes: 8 * 1024,
  responseBytes: 512 * 1024,
  notebooks: 30,
  cells: 30,
  notebookBytes: 80_000,
  sourceCharacters: 2_000,
  totalSourceCharacters: 20_000,
} as const;

const kindSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/u);
const knownKinds = new Set<string>(NOTEBOOK_CELL_KINDS);
const cellSchema = z.object({
  index: z.number().int().min(1).max(PROJECT_INSPECTION_LIMITS.cells),
  id: z.string().trim().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_-]*$/u),
  title: z.string().trim().min(1).max(120),
  support: z.enum(["known", "unknown"]),
  kind: kindSchema.optional(),
  source: z.object({
    language: z.enum(["sql", "python", "markdown"]),
    text: z.string().min(1).max(PROJECT_INSPECTION_LIMITS.sourceCharacters),
    truncated: z.boolean(),
  }).strict().optional(),
}).strict().superRefine((cell, context) => {
  if (cell.support === "known" && (!cell.kind || !knownKinds.has(cell.kind))) {
    context.addIssue({ code: "custom", message: "已知单元类型无效" });
  }
  if (cell.support === "unknown" && (cell.source || (cell.kind && knownKinds.has(cell.kind)))) {
    context.addIssue({ code: "custom", message: "未知单元不能包含源码或已知类型" });
  }
  if (cell.source) {
    const expected = cell.kind === "sql" || cell.kind === "warehouseSql" ? "sql"
      : cell.kind === "python" ? "python" : cell.kind === "text" ? "markdown" : null;
    if (cell.source.language !== expected) context.addIssue({ code: "custom", message: "源码类型与单元不符" });
  }
});

/** A display-only DTO: never a ProjectSession, NotebookDocument or save payload. */
export const projectInspectionSchema = z.object({
  mode: z.literal("read-only"),
  project: z.object({
    name: z.string().trim().min(1).max(100),
    updatedAt: z.iso.datetime(),
    stateRevision: z.number().int().nonnegative(),
  }).strict(),
  notebooks: z.array(z.object({
    index: z.number().int().min(1).max(PROJECT_INSPECTION_LIMITS.notebooks),
    name: z.string().trim().min(1).max(160),
    revision: z.number().int().nonnegative(),
    cells: z.array(cellSchema).max(PROJECT_INSPECTION_LIMITS.cells),
  }).strict()).max(PROJECT_INSPECTION_LIMITS.notebooks),
  unknownCellCount: z.number().int().nonnegative().max(900),
  omittedSourceCount: z.number().int().nonnegative().max(900),
}).strict().superRefine((value, context) => {
  const cells = value.notebooks.flatMap((book) => book.cells);
  if (value.unknownCellCount !== cells.filter((cell) => cell.support === "unknown").length) {
    context.addIssue({ code: "custom", message: "未知单元数量不符" });
  }
  if (cells.reduce((total, cell) => total + (cell.source?.text.length ?? 0), 0) > PROJECT_INSPECTION_LIMITS.totalSourceCharacters) {
    context.addIssue({ code: "custom", message: "只读源码预览超出总量限制" });
  }
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > PROJECT_INSPECTION_LIMITS.responseBytes) {
    context.addIssue({ code: "custom", message: "只读预览超出响应大小限制" });
  }
});
export type ProjectInspection = z.infer<typeof projectInspectionSchema>;
