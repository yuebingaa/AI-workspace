import { describe, expect, it } from "vitest";
import type { DataTable } from "@/core/datasets/table-contracts";
import { notebookCellSchema, type NotebookCell, type NotebookArtifact } from "./definition";
import { notebookCellRunSchema, type NotebookDocument } from "./contracts";
import { cellDependencies, cellsToRun, affectedCells, validateNotebook, updateNotebook } from "./graph";
import { adoptNotebookDraft, notebookFingerprint } from "./client-state";
import { requiresSuccessfulNotebookTrial } from "./cell-catalog";
import { MAX_NOTEBOOK_TEXT_OUTPUT_CHARS, MAX_NOTEBOOK_TEXT_REFERENCES, notebookTextReferenceSchema,
  notebookTextReferencesSchema, renderNotebookText, validateNotebookTextTemplate, type NotebookTextReference } from "./text-references";

const reference: NotebookTextReference = { key: "value", cellId: "parameter", field: "value" };
function note(markdown = "当前值：{{value}}", references = [reference]): Extract<NotebookCell, { kind: "text" }> {
  return { id: "note", kind: "text", title: "合成说明", markdown, references };
}
function scalar(value: DataTable["rows"][number][string], field = "value"): DataTable {
  return { fields: [{ name: field, label: field, type: "string" }], rows: [{ [field]: value }], truncated: false };
}
function outputs(value: DataTable["rows"][number][string], field = "value") { return new Map([["parameter", scalar(value, field)]]); }
const parameter: NotebookCell = { id: "parameter", kind: "parameter", title: "参数", outputName: "parameter", parameter: { type: "number", value: 3 } };
const document = (cells: NotebookCell[]): NotebookDocument => ({ name: "合成文档", revision: 0, cells });

describe("controlled text reference definitions", () => {
  it.each([undefined, []])("keeps static legacy braces untouched with references=%s", (references) => {
    const cell = { ...note("旧 {{not.an.expression}} 和 {{未闭合"), references };
    expect(notebookCellSchema.parse(cell)).toEqual(cell);
    expect(renderNotebookText(cell, new Map())).toBe(cell.markdown);
    expect(cellDependencies(cell)).toEqual([]);
    expect(requiresSuccessfulNotebookTrial(cell)).toBe(false);
  });
  it("accepts declared repeated placeholders and ordinary single braces", () => {
    const cell = note("{普通文本} {{value}} / {{value}}；尾部");
    expect(notebookCellSchema.parse(cell)).toEqual(cell);
    expect(renderNotebookText(cell, outputs("数据"))).toBe("{普通文本} 数据 / 数据；尾部");
  });
  it.each(["{{value + 1}}", "{{value.field}}", "{{value[0]}}", "{{fn()}}", "{{ value }}", "{{}}", "{{value", "value}}", "{{{value}}}", "{{value}}}", "{{outer {{value}} }}", "{{value}} {{unknown}}"])("rejects malformed, executable or undeclared template %s", (markdown) => {
    expect(notebookCellSchema.safeParse(note(markdown)).success).toBe(false);
    expect(() => validateNotebookTextTemplate(note(markdown))).toThrow();
  });
  it("rejects unused declarations without interpreting raw text as a reference", () => {
    expect(() => validateNotebookTextTemplate(note("value"))).toThrow("未在文本模板中使用");
    expect(() => validateNotebookTextTemplate(note("{{value}}", [reference, { ...reference, key: "unused" }]))).toThrow("未在文本模板中使用");
  });
  it.each(["", "9name", "with-dash", "with space", "中文", "a".repeat(61)])("rejects invalid placeholder key %s", (key) => {
    expect(notebookTextReferenceSchema.safeParse({ ...reference, key }).success).toBe(false);
  });
  it("shares actual field names rather than limiting them to ASCII output identifiers", () => {
    const field = " 销售 金额（元） "; const cell = note("{{amount}}", [{ ...reference, key: "amount", field }]);
    expect(notebookCellSchema.parse(cell)).toEqual(cell);
    expect(renderNotebookText(cell, outputs("123.45000000000001", field))).toBe("123.45000000000001");
    expect(notebookTextReferenceSchema.safeParse({ ...reference, key: "a".repeat(60), field: "中".repeat(120) }).success).toBe(true);
    expect(notebookTextReferenceSchema.safeParse({ ...reference, field: "a".repeat(121) }).success).toBe(false);
  });
  it("enforces unique keys and the declared reference limit", () => {
    expect(notebookTextReferencesSchema.safeParse([reference, { ...reference, field: "other" }]).success).toBe(false);
    const references = Array.from({ length: MAX_NOTEBOOK_TEXT_REFERENCES }, (_, index) => ({ ...reference, key: `v${index}` }));
    expect(notebookCellSchema.safeParse(note(references.map(({ key }) => `{{${key}}}`).join(""), references)).success).toBe(true);
    expect(notebookTextReferencesSchema.safeParse([...references, { ...reference, key: "overflow" }]).success).toBe(false);
  });
  it("keeps existing cell ID bounds and strict reference shape", () => {
    for (const cellId of ["bad/id", "../parent", "0bad", "a".repeat(121)]) expect(notebookTextReferenceSchema.safeParse({ ...reference, cellId }).success).toBe(false);
    expect(notebookTextReferenceSchema.safeParse({ ...reference, cellId: "cell-with_dash" }).success).toBe(true);
    expect(notebookTextReferenceSchema.safeParse({ ...reference, expression: "execute()" }).success).toBe(false);
  });
});

describe("one-pass scalar text rendering", () => {
  it.each([null, true, false, -7, 1.25, "", "00123", "900719925474099312345.0000001", "2026-09-17T09:30:00+08:00", "中文\n保留  空白"])("renders literal scalar %s without precision or date coercion", (value) => {
    expect(renderNotebookText(note("{{value}}"), outputs(value))).toBe(value === null ? "NULL" : String(value));
  });
  it("substitutes values once, never evaluating or expanding inserted templates", () => {
    const value = "{{value}} ${process.env.SECRET} <script>alert(1)</script> =1+1";
    expect(renderNotebookText(note("结果 {{value}}"), outputs(value))).toBe(`结果 ${value}`);
  });
  it("reads current supplied tables only and requires complete single-row inputs", () => {
    expect(() => renderNotebookText(note(), new Map())).toThrow("没有本次运行");
    for (const rows of [[], [{ value: 1 }, { value: 2 }]]) expect(() => renderNotebookText(note(), new Map([["parameter", { ...scalar(1), rows }]]))).toThrow("恰好 1 行");
    expect(() => renderNotebookText(note(), new Map([["parameter", { ...scalar(1), truncated: true }]]))).toThrow("不完整");
  });
  it("requires an unambiguous declared field and own row property", () => {
    expect(() => renderNotebookText(note(), new Map([["parameter", { ...scalar(1), rows: [{}] }]]))).toThrow("字段不存在");
    expect(() => renderNotebookText(note(), outputs(1, "different"))).toThrow("字段不存在");
    const duplicate = scalar(1); duplicate.fields.push({ ...duplicate.fields[0] });
    expect(() => renderNotebookText(note(), new Map([["parameter", duplicate]]))).toThrow("不明确");
    for (const field of ["constructor", "toString", "__proto__"]) {
      expect(() => renderNotebookText(note("{{value}}", [{ ...reference, field }]), new Map([["parameter", { ...scalar(1, field), rows: [{}] }]]))).toThrow("字段不存在");
      expect(renderNotebookText(note("{{value}}", [{ ...reference, field }]), outputs("自有字段", field))).toBe("自有字段");
    }
  });
  it.each([Number.NaN, Infinity, -Infinity, {}, [], undefined, BigInt(1)])("rejects invalid scalar %s without echoing data", (value) => {
    const table = scalar(1); Object.defineProperty(table.rows[0], "value", { value, enumerable: true });
    expect(() => renderNotebookText(note(), new Map([["parameter", table]]))).toThrow("不是有效");
  });
  it("allows exactly the text result limit but refuses longer or repeated content without truncation", () => {
    const content = "中".repeat(MAX_NOTEBOOK_TEXT_OUTPUT_CHARS);
    expect(renderNotebookText(note("{{value}}"), outputs(content))).toBe(content);
    expect(() => renderNotebookText(note("a{{value}}"), outputs(content))).toThrow("超过 8000");
    expect(() => renderNotebookText(note("{{value}}{{value}}"), outputs(content))).toThrow("超过 8000");
    expect(notebookCellRunSchema.safeParse({ cellId: "note", durationMs: 0, status: "success", text: content }).success).toBe(true);
    expect(notebookCellRunSchema.safeParse({ cellId: "note", durationMs: 0, status: "success", text: `${content}a` }).success).toBe(false);
  });
  it("does not mutate definitions, schemas, rows or source text", () => {
    const cell = note(); const tables = outputs("{{value}}"); const before = structuredClone({ cell, tables });
    Object.freeze(cell.references?.[0]); Object.freeze(cell.references); Object.freeze(cell);
    for (const table of tables.values()) { Object.freeze(table.rows[0]); Object.freeze(table.rows); Object.freeze(table.fields); Object.freeze(table); }
    expect(renderNotebookText(cell, tables)).toBe("当前值：{{value}}");
    expect({ cell, tables }).toEqual(before);
  });
});

describe("text references in existing Notebook dependency and adoption rules", () => {
  it("deduplicates source IDs and runs sources first even when the narrative appears first", () => {
    const cell = note("{{value}} / {{again}}", [reference, { ...reference, key: "again" }]);
    expect(cellDependencies(cell)).toEqual(["parameter"]);
    expect(cellsToRun(document([cell, parameter]), cell.id).map((item) => item.id)).toEqual(["parameter", "note"]);
  });
  it("rejects missing, self and non-table dependencies using the existing graph validator", () => {
    expect(() => validateNotebook(document([note()]))).toThrow("依赖不存在");
    expect(() => validateNotebook(document([note("{{value}}", [{ ...reference, cellId: "note" }])]))).toThrow("不能依赖自身");
    const staticText: NotebookCell = { id: "parameter", kind: "text", title: "说明", markdown: "不是表格" };
    expect(() => validateNotebook(document([staticText, note()]))).toThrow("未提供表格输出");
  });
  it("does not weaken rejection of upstream dependency cycles", () => {
    const a: NotebookCell = { id: "parameter", kind: "sql", title: "A", inputCellIds: ["other"], outputName: "a", sql: "SELECT * FROM b" };
    const b: NotebookCell = { id: "other", kind: "sql", title: "B", inputCellIds: ["parameter"], outputName: "b", sql: "SELECT * FROM a" };
    expect(() => validateNotebook(document([note(), a, b]))).toThrow("循环依赖");
  });
  it("invalidates dependent narrative only, preserves stable IDs across source renaming", () => {
    const unrelated: NotebookCell = { id: "other", kind: "text", title: "静态说明", markdown: "保持不变" };
    const previous = document([parameter, note(), unrelated]);
    const next = updateNotebook(previous, [{ ...parameter, outputName: "renamed", parameter: { type: "number", value: 4 } }, note(), unrelated]);
    expect([...affectedCells(next.cells, ["parameter"])]).toEqual(["parameter", "note"]);
    expect(cellDependencies(next.cells[1])).toEqual(["parameter"]);
    expect(notebookFingerprint(next, "note", [], [])).not.toBe(notebookFingerprint(previous, "note", [], []));
    expect(notebookFingerprint(next, "other", [], [])).toBe(notebookFingerprint(previous, "other", [], []));
    expect(previous.cells[0]).toEqual(parameter);
  });
  it("requires a successful trial for bound narrative without changing static text adoption", () => {
    const data: NotebookCell = { id: "parameter", kind: "data", title: "数据", sourceDataSourceId: "synthetic", outputName: "data_rows" };
    const cells = [data, note()];
    const artifact: NotebookArtifact = { id: "draft", version: 1, status: "draft", name: "合成草稿", cells,
      executionOrder: cells.map((cell) => cell.id), lineage: cells.map((cell) => ({ cellId: cell.id, dependsOn: cellDependencies(cell) })),
      sourceDataSourceIds: ["synthetic"], createdAt: "2026-09-17T00:00:00.000Z", baseRevision: 0 };
    expect(requiresSuccessfulNotebookTrial(cells[0])).toBe(false);
    expect(requiresSuccessfulNotebookTrial(cells[1])).toBe(true);
    expect(() => adoptNotebookDraft(document([]), artifact)).toThrow("成功试运行证据");
    expect(adoptNotebookDraft(document([]), { ...artifact, executionEvidence: { runId: "run", status: "success", completedCellIds: ["parameter", "note"], summary: "通过" } }).cells).toEqual(cells);
    const legacy = { ...artifact, cells: [{ id: "legacy", kind: "text" as const, title: "静态", markdown: "{{不解析}}" }], executionOrder: ["legacy"], lineage: [{ cellId: "legacy", dependsOn: [] }], sourceDataSourceIds: [] };
    expect(adoptNotebookDraft(document([]), legacy).cells).toEqual(legacy.cells);
  });
});
