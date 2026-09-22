import { z } from "zod";
import { dataFieldSchema, dataValueSchema, type DataTable } from "@/core/datasets/table-contracts";

export const MAX_NOTEBOOK_TEXT_REFERENCES = 10;
export const MAX_NOTEBOOK_TEXT_OUTPUT_CHARS = 8_000;
const keyPattern = /^[A-Za-z][A-Za-z0-9_]{0,59}$/u;

export const notebookTextReferenceSchema = z.object({
  key: z.string().min(1).max(60).regex(keyPattern, "引用名称必须是以字母开头、最多 60 字符的英文标识符"),
  cellId: z.string().trim().min(1).max(120).regex(/^[A-Za-z][A-Za-z0-9_-]*$/u),
  field: dataFieldSchema.shape.name,
}).strict();
export const notebookTextReferencesSchema = z.array(notebookTextReferenceSchema).max(MAX_NOTEBOOK_TEXT_REFERENCES)
  .refine((references) => new Set(references.map((reference) => reference.key)).size === references.length, "文本引用名称不能重复");
export type NotebookTextReference = z.infer<typeof notebookTextReferenceSchema>;
export interface NotebookTextTemplate {
  readonly markdown: string;
  readonly references?: readonly NotebookTextReference[];
}
type Segment = { kind: "text"; value: string } | { kind: "reference"; key: string };

/** Only exact {{key}} tokens are recognized. There is no expression evaluator. */
function templateSegments(input: NotebookTextTemplate): Segment[] {
  if (!input.references?.length) return [{ kind: "text", value: input.markdown }];
  const references = notebookTextReferencesSchema.safeParse(input.references);
  if (!references.success) throw new Error("文本引用配置无效：请检查名称、单元、字段和重复引用。");
  const declared = new Set(references.data.map((reference) => reference.key));
  const used = new Set<string>();
  const segments: Segment[] = [];
  const malformed = () => new Error("文本模板只支持 {{key}} 引用，不支持表达式、嵌套或未闭合的双花括号。");
  if (/\{\{\{|\}\}\}/u.test(input.markdown)) throw malformed();
  let cursor = 0;
  while (cursor < input.markdown.length) {
    const opening = input.markdown.indexOf("{{", cursor);
    const closing = input.markdown.indexOf("}}", cursor);
    if (closing >= 0 && (opening < 0 || closing < opening)) throw malformed();
    if (opening < 0) { segments.push({ kind: "text", value: input.markdown.slice(cursor) }); break; }
    if (opening > cursor) segments.push({ kind: "text", value: input.markdown.slice(cursor, opening) });
    const end = input.markdown.indexOf("}}", opening + 2);
    if (end < 0) throw malformed();
    const key = input.markdown.slice(opening + 2, end);
    if (!keyPattern.test(key)) throw malformed();
    if (!declared.has(key)) throw new Error(`文本模板引用“${key}”尚未声明。`);
    used.add(key); segments.push({ kind: "reference", key }); cursor = end + 2;
  }
  if (references.data.some((reference) => !used.has(reference.key))) throw new Error("存在未在文本模板中使用的引用，请插入占位符或移除引用。");
  return segments;
}

/** Shared definition validation; legacy static text is deliberately not parsed. */
export function validateNotebookTextTemplate(input: NotebookTextTemplate): void {
  templateSegments(input);
}

/** The caller owns current-run success/authorization; this module reads only supplied complete scalar tables. */
export function renderNotebookText(input: NotebookTextTemplate, outputs: ReadonlyMap<string, DataTable>): string {
  const segments = templateSegments(input);
  if (!input.references?.length) return input.markdown;
  const values = new Map<string, string>();
  for (const reference of input.references) {
    const table = outputs.get(reference.cellId);
    if (!table) throw new Error(`文本引用“${reference.key}”没有本次运行的上游结果。`);
    if (table.truncated) throw new Error(`文本引用“${reference.key}”的上游结果不完整，不能使用截断结果。`);
    if (table.rows.length !== 1) throw new Error(`文本引用“${reference.key}”需要恰好 1 行结果，请先在上游筛选或汇总。`);
    if (table.fields.filter((field) => field.name === reference.field).length !== 1 || !Object.hasOwn(table.rows[0], reference.field)) {
      throw new Error(`文本引用“${reference.key}”的字段不存在或不明确，请重新选择字段。`);
    }
    const value = table.rows[0][reference.field];
    if (!dataValueSchema.safeParse(value).success) throw new Error(`文本引用“${reference.key}”不是有效的文本、有限数值、布尔值或空值。`);
    values.set(reference.key, value === null ? "NULL" : String(value));
  }
  let length = 0;
  const rendered = segments.map((segment) => {
    const value = segment.kind === "text" ? segment.value : values.get(segment.key)!;
    length += value.length;
    if (length > MAX_NOTEBOOK_TEXT_OUTPUT_CHARS) throw new Error("文本引用结果超过 8000 字符，请缩小上游文本或减少重复引用。");
    return value;
  });
  return rendered.join("");
}
