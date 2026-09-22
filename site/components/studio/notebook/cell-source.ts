import { notebookCellSchema, type NotebookCell } from "@/core/notebook/definition";
import { notebookCellPresentation } from "./cell-presentation";

export function cellSource(cell: NotebookCell): { language: string; value: string } {
  const language = notebookCellPresentation[cell.kind].sourceLanguage;
  if (cell.kind === "python") return { language, value: cell.code };
  if (cell.kind === "sql" || cell.kind === "warehouseSql") return { language, value: cell.sql };
  if (cell.kind === "text") return { language, value: cell.markdown };
  if (cell.kind === "transform") return { language, value: JSON.stringify(cell.steps, null, 2) };
  const { id, title, kind, ...configuration } = cell;
  void id; void title; void kind;
  return { language, value: JSON.stringify(configuration, null, 2) };
}

// Review all definition fields as well as SQL, so rebinding inputs or a connection
// cannot be hidden by an unchanged query string. This text is never executed.
export function cellReviewSource(cell: NotebookCell): string {
  if (cell.kind === "sql" || cell.kind === "warehouseSql") {
    const { sql, ...configuration } = cell;
    return `${JSON.stringify(configuration, null, 2)}\n\n${sql}`;
  }
  return JSON.stringify(cell, null, 2);
}

export function applyRecipeSource(cell: Extract<NotebookCell, { kind: "transform" }>, source: string): NotebookCell {
  let steps: unknown;
  try { steps = JSON.parse(source); } catch { throw new Error("处理规则不是有效的 JSON，请检查引号、逗号和括号。"); }
  const result = notebookCellSchema.safeParse({ ...cell, steps });
  if (!result.success) throw new Error(`处理规则格式不符合要求：${result.error.issues.map((issue) => issue.message).slice(0, 3).join("；")}`);
  return result.data;
}

export type SourceLine = { text: string; kind: "same" | "added" | "removed"; oldLine?: number; newLine?: number };
// Linear time, bounded by the source size: keep shared prefix/suffix and show
// the whole changed region. Avoid a quadratic diff for a long generated query.
export function sourceDiff(before: string | undefined, after: string | undefined): SourceLine[] {
  const left = before === undefined ? [] : before.split("\n");
  const right = after === undefined ? [] : after.split("\n");
  let start = 0, end = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
  return [
    ...left.slice(0, start).map((text, i): SourceLine => ({ text, kind: "same", oldLine: i + 1, newLine: i + 1 })),
    ...left.slice(start, left.length - end).map((text, i): SourceLine => ({ text, kind: "removed", oldLine: start + i + 1 })),
    ...right.slice(start, right.length - end).map((text, i): SourceLine => ({ text, kind: "added", newLine: start + i + 1 })),
    ...right.slice(right.length - end).map((text, i): SourceLine => ({ text, kind: "same", oldLine: left.length - end + i + 1, newLine: right.length - end + i + 1 })),
  ];
}
