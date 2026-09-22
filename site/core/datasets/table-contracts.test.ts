import { z } from "zod";
import { describe, expect, expectTypeOf, it } from "vitest";
import { notebookFieldSchema, notebookSqlTableSchema, notebookTableSchema, type NotebookTable } from "@/core/notebook/contracts";
import { dataFieldSchema, dataTableSchema, dataValueSchema, type DataTable } from "./table-contracts";

// Literal pre-extraction contracts lock wire behavior independently of the new
// shared definitions. These are compatibility witnesses, not production schemas.
const legacyFieldSchema = z.object({
  name: z.string().min(1).max(120), label: z.string().min(1).max(160),
  type: z.enum(["string", "number", "date", "boolean"]),
}).strict();
const legacyValueSchema = z.union([z.string().max(20_000), z.number().finite(), z.boolean(), z.null()]);
const legacyTableSchema = z.object({
  fields: z.array(legacyFieldSchema).min(1).max(100),
  rows: z.array(z.record(z.string(), legacyValueSchema)).max(1_000),
  truncated: z.boolean(),
}).strict();
const legacySqlTableSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,119}$/u),
  fields: z.array(legacyFieldSchema).min(1).max(100),
  rows: z.array(z.record(z.string(), legacyValueSchema)).max(50_000),
}).strict();
const field = { name: "value", label: "合成值", type: "string" } as const;
const table = (rows: unknown[]) => ({ fields: [field], rows, truncated: false });
function expectSameParse(actualSchema: z.ZodType, legacySchema: z.ZodType, input: unknown) {
  const actual = actualSchema.safeParse(input), legacy = legacySchema.safeParse(input);
  expect(actual.success).toBe(legacy.success);
  if (actual.success && legacy.success) {
    expect(actual.data).toEqual(legacy.data);
    expect(JSON.stringify(actual.data)).toBe(JSON.stringify(legacy.data));
  } else if (!actual.success && !legacy.success) expect(actual.error.issues).toEqual(legacy.error.issues);
}

describe("literal Notebook table compatibility before Dataset extraction", () => {
  it.each(["string", "number", "date", "boolean"])("preserves %s field metadata without coercion", (type) => {
    expectSameParse(notebookFieldSchema, legacyFieldSchema, { ...field, type });
  });
  it.each([
    { ...field, name: "", label: "ok" }, { ...field, name: "x".repeat(121) },
    { ...field, label: "" }, { ...field, label: "x".repeat(161) },
    { ...field, type: "integer" }, { ...field, extra: "unsupported" },
  ])("keeps field rejection and issue paths for %j", (input) => {
    expectSameParse(notebookFieldSchema, legacyFieldSchema, input);
    expect(notebookFieldSchema.safeParse(input).success).toBe(false);
  });
  it("preserves boundary names/labels and whitespace instead of adding trim rules", () => {
    for (const input of [{ ...field, name: "n".repeat(120), label: "l".repeat(160) }, { ...field, name: " ", label: " " }]) {
      expectSameParse(notebookFieldSchema, legacyFieldSchema, input);
      expect(notebookFieldSchema.parse(input)).toEqual(input);
    }
  });
  it("retains exact decimal/large integer/date strings, finite numbers, false and null", () => {
    const input = { fields: [field, { name: "when", label: "日期", type: "date" }], rows: [
      { value: "9007199254740993", when: "2026-09-16T12:34:56.123+08:00" },
      { value: "123.4500000001", when: "2026-09-16" }, { value: Number.MAX_VALUE },
      { value: 0 }, { value: false }, { value: null }, { value: "" },
    ], truncated: true };
    expectSameParse(notebookTableSchema, legacyTableSchema, input);
    expect(notebookTableSchema.parse(input)).toEqual(input);
  });
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, new Date("2026-09-16T00:00:00Z"), BigInt(1), {}, []])(
    "rejects non-wire scalar %s without converting it to null or text", (value) => {
      expectSameParse(notebookTableSchema, legacyTableSchema, table([{ value }]));
      expect(notebookTableSchema.safeParse(table([{ value }])).success).toBe(false);
    });
  it("preserves zero-row tables, missing row properties and unconstrained record keys", () => {
    for (const input of [table([]), table([{}, { additional: 1, value: null }]), table([{ "": "empty key" }])]) {
      expectSameParse(notebookTableSchema, legacyTableSchema, input);
      expect(notebookTableSchema.parse(input)).toEqual(input);
    }
  });
  it("keeps required fields/truncation and strict table/field object behavior", () => {
    for (const input of [{ rows: [], truncated: false }, { fields: [field], rows: [] },
      { ...table([]), truncated: "false" }, { ...table([]), fields: [] },
      { ...table([]), extra: true }, { ...table([]), fields: [{ ...field, extra: true }] }]) {
      expectSameParse(notebookTableSchema, legacyTableSchema, input);
      expect(notebookTableSchema.safeParse(input).success).toBe(false);
    }
  });
  it("preserves the 100-field boundary without inventing name uniqueness or row-shape checks", () => {
    const fields = Array.from({ length: 100 }, () => ({ ...field }));
    expect(notebookTableSchema.parse({ ...table([{}]), fields }).fields).toHaveLength(100);
    expectSameParse(notebookTableSchema, legacyTableSchema, { ...table([]), fields });
    expectSameParse(notebookTableSchema, legacyTableSchema, { ...table([]), fields: [...fields, field] });
    expect(notebookTableSchema.safeParse({ ...table([]), fields: [...fields, field] }).success).toBe(false);
  });
  it("preserves the 20,000-character scalar boundary", () => {
    expect(notebookTableSchema.parse(table([{ value: "x".repeat(20_000) }])).rows[0].value).toHaveLength(20_000);
    expectSameParse(notebookTableSchema, legacyTableSchema, table([{ value: "x".repeat(20_001) }]));
    expect(notebookTableSchema.safeParse(table([{ value: "x".repeat(20_001) }])).success).toBe(false);
  });
  it("retains Notebook result 1,000 rows versus SQL input 50,000 rows and errors", () => {
    const rows = Array.from({ length: 50_001 }, () => ({ value: 1 }));
    expect(notebookTableSchema.parse(table(rows.slice(0, 1_000))).rows).toHaveLength(1_000);
    expectSameParse(notebookTableSchema, legacyTableSchema, table(rows.slice(0, 1_001)));
    expect(notebookTableSchema.safeParse(table(rows.slice(0, 1_001))).success).toBe(false);
    const input = { name: "sql_input", fields: [field], rows: rows.slice(0, 50_000) };
    expectSameParse(notebookSqlTableSchema, legacySqlTableSchema, input);
    expect(notebookSqlTableSchema.parse(input).rows).toHaveLength(50_000);
    expectSameParse(notebookSqlTableSchema, legacySqlTableSchema, { ...input, rows });
    expect(notebookSqlTableSchema.safeParse({ ...input, rows }).success).toBe(false);
  });
  it("retains SQL input naming and its distinct non-truncated object shape", () => {
    for (const name of ["sales", "s".repeat(120), "invalid name", "1invalid", "s".repeat(121)])
      expectSameParse(notebookSqlTableSchema, legacySqlTableSchema, { name, fields: [field], rows: [] });
    expectSameParse(notebookSqlTableSchema, legacySqlTableSchema, { name: "sales", ...table([]) });
    expect(notebookSqlTableSchema.safeParse({ name: "sales", ...table([]) }).success).toBe(false);
  });
});

describe("shared Dataset table contract", () => {
  it("keeps the original Notebook field export as the same schema instance", () => {
    expect(notebookFieldSchema).toBe(dataFieldSchema);
  });
  it("keeps DataTable and the public NotebookTable type structurally identical", () => {
    expectTypeOf<DataTable>().toEqualTypeOf<NotebookTable>();
    expectTypeOf<DataTable>().toEqualTypeOf<z.infer<typeof notebookTableSchema>>();
    expectTypeOf<DataTable>().toEqualTypeOf<{
      fields: { name: string; label: string; type: "string" | "number" | "date" | "boolean" }[];
      rows: Record<string, string | number | boolean | null>[];
      truncated: boolean;
    }>();
    expect(dataTableSchema.parse(table([]))).toEqual(table([]));
  });
  it("shares the original wire scalar contract without precision or date coercion", () => {
    for (const value of ["", "9007199254740993", "123.4500000001", "2026-09-16", "x".repeat(20_000),
      Number.MAX_VALUE, -0, true, false, null, "x".repeat(20_001), Number.NaN, Infinity, undefined, BigInt(1),
      new Date("2026-09-16T00:00:00Z"), {}, []])
      expectSameParse(dataValueSchema, legacyValueSchema, value);
  });
  it("leaves Notebook and SQL row quotas with their consumers without truncating shared data", () => {
    const rows = Array.from({ length: 50_001 }, () => ({ value: "123.4500000001" }));
    const input = table(rows);
    const parsed = dataTableSchema.parse(input);
    expect(parsed).toEqual(input);
    expect(parsed.rows).toHaveLength(50_001);
    expect(parsed.truncated).toBe(false);
    expect(notebookTableSchema.safeParse(table(rows.slice(0, 1_001))).success).toBe(false);
    expect(notebookSqlTableSchema.safeParse({ name: "sales", fields: [field], rows }).success).toBe(false);
  });
  it("retains shared strictness, required fields, column and scalar limits", () => {
    const legacyStructure = legacyTableSchema.extend({ rows: z.array(z.record(z.string(), legacyValueSchema)) });
    for (const input of [table([]), table([{}, { value: null, additional: false }]),
      { ...table([]), fields: Array.from({ length: 100 }, () => ({ ...field })) },
      { ...table([]), fields: Array.from({ length: 101 }, () => ({ ...field })) },
      { ...table([]), fields: [] }, { ...table([]), fields: [{ ...field, extra: true }] },
      { ...table([]), truncated: "false" }, { ...table([]), extra: true }, { fields: [field], rows: [] },
      table([{ value: "x".repeat(20_001) }])])
      expectSameParse(dataTableSchema, legacyStructure, input);
  });
});
