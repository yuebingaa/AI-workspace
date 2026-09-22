import { describe, expect, it } from "vitest";
import { z } from "zod";
import { notebookCellSchema, type NotebookCell } from "./definition";
import { notebookDocumentSchema, notebookLayerSchema } from "./contracts";
import { notebookParameterSchema, notebookParameterTable, type NotebookParameter } from "./parameter";
import { affectedCells, cellDependencies, cellsToRun, notebookDependencyCandidates, updateNotebook } from "./graph";
import { notebookFingerprint } from "./client-state";
import { buildNotebookSearchIndex, searchNotebookIndex } from "./search";

const valid: NotebookParameter[] = [
  { type: "text", value: "  字面文本\n' ; SELECT secret  " },
  { type: "number", value: -12.5 },
  { type: "date", value: "2024-02-29" },
  { type: "select", value: "华东", options: ["华东", "华南"] },
];
const base = { id: "parameter", kind: "parameter" as const, title: "参数", outputName: "selected" };

describe("Notebook literal parameter contract", () => {
  it.each(valid)("round trips $type without coercing the value or mutating input", (parameter) => {
    const saved = { ...base, parameter }, before = structuredClone(saved);
    expect(notebookCellSchema.parse(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(notebookLayerSchema.parse({ page_home: { name: "参数", revision: 2, cells: [saved] } }))
      .toEqual({ page_home: { name: "参数", revision: 2, cells: [saved] } });
    const table = notebookParameterTable(parameter);
    expect(table).toEqual({ fields: [{ name: "value", label: "value", type: parameter.type === "number" ? "number"
      : parameter.type === "date" ? "date" : "string" }], rows: [{ value: parameter.value }], truncated: false });
    table.rows[0].value = "changed only in output";
    expect(saved).toEqual(before);
  });

  it.each(["", "  ", "\n", "x".repeat(2_000)])("preserves bounded text including empty and whitespace", (value) => {
    expect(notebookParameterTable({ type: "text", value }).rows).toEqual([{ value }]);
  });

  it.each([0, -0.5, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER])("accepts finite bounded numeric value %s", (value) => {
    expect(notebookParameterSchema.parse({ type: "number", value })).toEqual({ type: "number", value });
  });

  const invalid: Array<{ name: string; parameter: unknown }> = [
    { name: "overlong text", parameter: { type: "text", value: "x".repeat(2_001) } },
    { name: "text coercion", parameter: { type: "text", value: 3 } },
    { name: "numeric coercion", parameter: { type: "number", value: "3" } },
    { name: "missing value", parameter: { type: "number" } },
    { name: "null value", parameter: { type: "text", value: null } },
    { name: "NaN", parameter: { type: "number", value: Number.NaN } },
    { name: "infinite number", parameter: { type: "number", value: Infinity } },
    { name: "unsafe positive number", parameter: { type: "number", value: Number.MAX_SAFE_INTEGER + 1 } },
    { name: "unsafe negative number", parameter: { type: "number", value: -Number.MAX_SAFE_INTEGER - 1 } },
    { name: "impossible leap date", parameter: { type: "date", value: "2023-02-29" } },
    { name: "impossible month day", parameter: { type: "date", value: "2026-04-31" } },
    { name: "datetime not date", parameter: { type: "date", value: "2026-09-17T00:00:00Z" } },
    { name: "noncanonical date", parameter: { type: "date", value: "2026-9-1" } },
    { name: "empty options", parameter: { type: "select", value: "a", options: [] } },
    { name: "too many options", parameter: { type: "select", value: "a0", options: Array.from({ length: 51 }, (_, i) => `a${i}`) } },
    { name: "empty option", parameter: { type: "select", value: "", options: [""] } },
    { name: "blank option", parameter: { type: "select", value: " ", options: [" "] } },
    { name: "duplicate option", parameter: { type: "select", value: "a", options: ["a", "a"] } },
    { name: "unknown selected value", parameter: { type: "select", value: "c", options: ["a", "b"] } },
    { name: "overlong option", parameter: { type: "select", value: "x".repeat(201), options: ["x".repeat(201)] } },
    { name: "unknown type", parameter: { type: "script", value: "print(1)" } },
    { name: "extra execution key", parameter: { type: "text", value: "a", sql: "SELECT 1" } },
    { name: "extra options for text", parameter: { type: "text", value: "a", options: ["a"] } },
  ];
  it.each(invalid)("rejects $name at both configuration and document boundaries", ({ parameter }) => {
    expect(notebookParameterSchema.safeParse(parameter).success).toBe(false);
    expect(notebookDocumentSchema.safeParse({ name: "Rejected", revision: 0, cells: [{ ...base, parameter }] }).success).toBe(false);
  });

  it("preserves exact select options and checks 50-option / 200-character boundaries", () => {
    const options = Array.from({ length: 50 }, (_, index) => `${index}`.padEnd(200, "x"));
    const parameter: NotebookParameter = { type: "select", value: options[49], options };
    expect(notebookParameterSchema.parse(parameter)).toEqual(parameter);
    expect(notebookParameterSchema.parse({ type: "select", value: " a ", options: ["a", " a "] }).value).toBe(" a ");
  });

  it("keeps one top-level parameter kind with a nested typed model schema", () => {
    expect(notebookCellSchema.options.filter((schema) => schema.shape.kind.value === "parameter")).toHaveLength(1);
    const json = z.toJSONSchema(notebookParameterSchema, { io: "input" });
    const serialized = JSON.stringify(json);
    expect(serialized).toContain('"maxLength":2000');
    expect(serialized).toContain('"maxItems":50');
    expect(serialized).toContain('"maximum":9007199254740991');
    expect(serialized).toContain('"format":"date"');
    expect(json.oneOf).toHaveLength(4);
    expect(notebookCellSchema.safeParse({ ...base, parameter: valid[0], inputCellIds: ["other"] }).success).toBe(false);
    expect(notebookCellSchema.safeParse({ ...base, outputName: "bad-name", parameter: valid[0] }).success).toBe(false);
  });

  it("keeps old stored definitions unchanged without adding defaults", () => {
    const legacy = { name: "Legacy", revision: 1, cells: [
      { id: "data", kind: "data", title: "Input", sourceDataSourceId: "dataset", outputName: "rows" },
      { id: "text", kind: "text", title: "Note", markdown: "unchanged" },
    ] };
    expect(notebookDocumentSchema.parse(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy);
  });
});

describe("Parameter graph, search and manual result invalidation", () => {
  function fixture() {
    const cells: NotebookCell[] = [
      { id: "show", kind: "table", title: "显示", inputCellId: "query", columns: ["value"] },
      { id: "query", kind: "sql", title: "查询", inputCellIds: [base.id], outputName: "result", sql: "SELECT value FROM selected" },
      { ...base, parameter: { type: "number", value: 3 } },
      { id: "note", kind: "text", title: "无关", markdown: "保持" },
    ];
    return { name: "参数闭环", revision: 4, cells };
  }
  it("is a no-dependency table producer with stable scheduling and selectable output", () => {
    const document = fixture();
    expect(cellDependencies(document.cells[2])).toEqual([]);
    expect(cellsToRun(document, "show").map((cell) => cell.id)).toEqual(["parameter", "query", "show"]);
    expect(notebookDependencyCandidates(document.cells, "query").map((cell) => cell.id)).toEqual(["parameter"]);
    const index = buildNotebookSearchIndex(document);
    expect(index.byVariable.get("selected")).toMatchObject({ kind: "parameter", upstream: [], downstream: ["query"], sourceDataSourceIds: [] });
    expect(searchNotebookIndex(index, { kind: "parameter", direction: "self", depth: 1, searchIn: "metadata" }).matches.map((match) => match.entry.id)).toEqual(["parameter"]);
  });
  it("invalidates the changed parameter and only its descendants without mutating prior definitions", () => {
    const document = fixture(), before = structuredClone(document);
    const next = updateNotebook(document, document.cells.map((cell) => cell.kind === "parameter"
      ? { ...cell, parameter: { type: "number", value: 8 } } : cell));
    expect(next.revision).toBe(5);
    expect(document).toEqual(before);
    expect([...affectedCells(next.cells, [base.id])].sort()).toEqual(["parameter", "query", "show"]);
    for (const id of ["parameter", "query", "show"]) expect(notebookFingerprint(next, id, [], [])).not.toBe(notebookFingerprint(document, id, [], []));
    expect(notebookFingerprint(next, "note", [], [])).toBe(notebookFingerprint(document, "note", [], []));
  });
});
