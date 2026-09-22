import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import type { DataTable } from "@/core/datasets/table-contracts";
import { createTableCsv, csvPreviewFilename, MAX_CSV_EXPORT_BYTES } from "./table-csv";

function table(values: (string | number | boolean | null)[]): DataTable {
  return { fields: [{ name: "value", label: "显示标签", type: "string" }], rows: values.map((value) => ({ value })), truncated: false };
}
function decoded(content: string): string[][] {
  return parse(content, { bom: true, skip_empty_lines: false });
}

describe("materialized table CSV serialization", () => {
  it("uses UTF-8 BOM, CRLF, quoted fields, field-name order and a trailing record delimiter", () => {
    const input: DataTable = { fields: [{ name: "second", label: "第二列", type: "number" }, { name: "first", label: "第一列", type: "boolean" }],
      rows: [{ first: false, second: 12.5 }], truncated: false };
    const result = createTableCsv(input);
    expect(result).toEqual({ content: '\ufeff"second","first"\r\n"12.5","false"\r\n', rowCount: 1, columnCount: 2,
      protectedCellCount: 0, byteCount: new TextEncoder().encode('\ufeff"second","first"\r\n"12.5","false"\r\n').byteLength });
    expect(result.content).not.toContain("第二列");
  });

  it("escapes commas, quotes, semicolons and embedded line endings without creating extra fields", () => {
    const values = ['a,b', 'a"b', 'a;b', 'line1\r\nline2', '中文\n下一行', ""];
    const result = createTableCsv(table(values));
    expect(decoded(result.content)).toEqual([["value"], ...values.map((value) => [value])]);
    expect(result.content).toContain('"a""b"');
    expect(result.protectedCellCount).toBe(0);
  });

  it("preserves exact numeric strings, whitespace, dates, time zones and long supported text", () => {
    const values = ["001", "9007199254740993", "123456789.123456789123456789", "2026-09-17T01:02:03+08:00", "  text  ", "x".repeat(20_000)];
    const result = createTableCsv(table(values));
    expect(decoded(result.content)).toEqual([["value"], ...values.map((value) => [value])]);
    expect(result.protectedCellCount).toBe(0);
  });

  it("writes finite numbers and booleans literally, without classifying numeric negatives as formulas", () => {
    const result = createTableCsv(table([0, -5, 1.5, 1e-20, 1e21, true, false]));
    expect(decoded(result.content)).toEqual([["value"], ["0"], ["-5"], ["1.5"], ["1e-20"], ["1e+21"], ["true"], ["false"]]);
    expect(result.protectedCellCount).toBe(0);
  });

  it("writes NULL, missing properties and empty strings as empty CSV fields", () => {
    const input = table([null, ""]);
    input.rows.push({});
    const result = createTableCsv(input);
    expect(decoded(result.content)).toEqual([["value"], [""], [""], [""]]);
    expect(result.rowCount).toBe(3);
  });

  it("exports a successful empty table as a header-only CSV", () => {
    expect(createTableCsv(table([]))).toEqual({ content: '\ufeff"value"\r\n', rowCount: 0, columnCount: 1, protectedCellCount: 0, byteCount: 12 });
  });

  it("does not expand a truncated materialized preview or infer a hidden total", () => {
    const result = createTableCsv({ ...table(Array.from({ length: 1000 }, (_, index) => index)), truncated: true });
    expect(result.rowCount).toBe(1000);
    expect(decoded(result.content)).toHaveLength(1001);
    expect(decoded(result.content).at(-1)).toEqual(["999"]);
  });

  it.each(["=1+1", "+SUM(A1:A2)", "-1", "@SUM(A1)", "＝1+1", "＋1", "－1", "＠A1", " \t=1", "\u0001 \u007f@A1", "\u200b=1", "\u00a0＝1", "\tordinary", "\rordinary", "\nordinary"])("prefixes dangerous text without altering its remaining characters: %j", (value) => {
    const result = createTableCsv(table([value]));
    expect(decoded(result.content)).toEqual([["value"], [`'${value}`]]);
    expect(result.protectedCellCount).toBe(1);
  });

  it("protects header text and quoted payloads without splitting malicious content", () => {
    const input: DataTable = { fields: [{ name: " =header", label: "普通标签", type: "string" }],
      rows: [{ " =header": '=1+2";,=3+4' }], truncated: false };
    const result = createTableCsv(input);
    expect(decoded(result.content)).toEqual([["' =header"], ['\'=1+2";,=3+4']]);
    expect(result.protectedCellCount).toBe(2);
  });

  it("does not prefix ordinary, already-apostrophe-prefixed or internally formula-like text", () => {
    const values = ["'=1", "value=1", "text @example", "a\t=1", "  ordinary", "text\n=2"];
    const result = createTableCsv(table(values));
    expect(decoded(result.content)).toEqual([["value"], ...values.map((value) => [value])]);
    expect(result.protectedCellCount).toBe(0);
  });

  it("does not use inherited values for a missing special-named column", () => {
    const input: DataTable = { fields: [{ name: "toString", label: "字段", type: "string" }], rows: [{}], truncated: false };
    expect(decoded(createTableCsv(input).content)).toEqual([["toString"], [""]]);
  });

  it("preserves legitimate own properties even when their names match Object prototype members", () => {
    const input: DataTable = { fields: ["__proto__", "constructor", "toString"].map((name) => ({ name, label: name, type: "string" })),
      rows: [JSON.parse('{"__proto__":"own proto","constructor":"own constructor","toString":"own string"}')], truncated: false };
    expect(decoded(createTableCsv(input).content)).toEqual([
      ["__proto__", "constructor", "toString"], ["own proto", "own constructor", "own string"],
    ]);
  });

  it("validates special-named own values even if a record parser omits them from its clone", () => {
    const invalid = { fields: [{ name: "__proto__", label: "字段", type: "string" }],
      rows: [JSON.parse('{"__proto__":{"not":"scalar"}}')], truncated: false };
    expect(() => Reflect.apply(createTableCsv, undefined, [invalid])).toThrow("CSV 数据表结构无效");
  });

  it("keeps the original table, field definitions, row objects and values unchanged", () => {
    const input = table(["=1", "001", null, 2]);
    const before = structuredClone(input);
    input.fields.forEach(Object.freeze);
    input.rows.forEach(Object.freeze);
    Object.freeze(input.fields); Object.freeze(input.rows); Object.freeze(input);
    createTableCsv(input);
    expect(input).toEqual(before);
  });

  it.each([NaN, Infinity, -Infinity, {}, [], BigInt(1), undefined])("rejects invalid row values rather than coercing them: %s", (value) => {
    const invalid = { ...table([]), rows: [{ value }] };
    expect(() => Reflect.apply(createTableCsv, undefined, [invalid])).toThrow("CSV 数据表结构无效");
  });

  it.each([
    { ...table([]), fields: [] },
    { ...table([]), fields: [{ name: "", label: "字段", type: "string" }] },
    { ...table([]), fields: [{ name: "value", label: "字段", type: "object" }] },
    { ...table([]), rows: [null] },
    { ...table([]), rows: [[1]] },
    { ...table([]), truncated: "yes" },
  ])("rejects malformed table metadata/rows: %j", (invalid) => {
    expect(() => Reflect.apply(createTableCsv, undefined, [invalid])).toThrow("CSV 数据表结构无效");
  });

  it("rejects duplicate column names before creating an ambiguous CSV", () => {
    const input = table(["a"]);
    input.fields.push({ ...input.fields[0], label: "重复列" });
    expect(() => createTableCsv(input)).toThrow("CSV 字段名称重复");
  });

  it("counts UTF-8 bytes, not JavaScript string length, including BOM and escaping", () => {
    const result = createTableCsv(table(["中文😀", 'a"b', "=1"]));
    expect(result.byteCount).toBe(new TextEncoder().encode(result.content).byteLength);
    expect(result.byteCount).toBeGreaterThan(result.content.length);
  });

  it("allows exactly 4 MiB and rejects the next byte without truncating content", () => {
    const input = table(Array.from({ length: 209 }, () => "a".repeat(20_000)));
    const baseBytes = createTableCsv(input).byteCount;
    const remainingText = MAX_CSV_EXPORT_BYTES - baseBytes - 4; // quoted cell + CRLF
    expect(remainingText).toBeGreaterThan(0);
    expect(remainingText).toBeLessThan(20_000);
    input.rows.push({ value: "b".repeat(remainingText) });
    expect(createTableCsv(input).byteCount).toBe(MAX_CSV_EXPORT_BYTES);
    input.rows[input.rows.length - 1] = { value: "b".repeat(remainingText + 1) };
    expect(() => createTableCsv(input)).toThrow("超过 4 MiB");
  });

  it("applies the byte cap after protection and quoting rather than truncating fields", () => {
    const input = table(Array.from({ length: 140 }, () => "中".repeat(10_000)));
    expect(() => createTableCsv(input)).toThrow("超过 4 MiB");
    expect(input.rows[0].value).toBe("中".repeat(10_000));
    const quoteHeavy = table(Array.from({ length: 110 }, () => '"'.repeat(20_000)));
    expect(() => createTableCsv(quoteHeavy)).toThrow("超过 4 MiB");
  });
});

describe("preview CSV download filename", () => {
  it("preserves Chinese titles and explicitly labels the download as a preview", () => {
    expect(csvPreviewFilename("月度收入 汇总")).toBe("notebook-月度收入 汇总-preview.csv");
  });

  it.each(["", "   ", "\r\n\u0000\u202e"])("uses a deterministic fallback for an empty sanitized title: %j", (title) => {
    expect(csvPreviewFilename(title)).toBe("notebook-result-preview.csv");
  });

  it.each(["../../secret", "C:\\folder\\name", "<bad>:name|with?stars*", "Ｃ：＼path／file", "CON", "AUX.txt", "..", "nul", "safe.csv\r\nX: injected"])("cannot produce a path, device name or header-injection filename: %j", (title) => {
    const result = csvPreviewFilename(title);
    expect(result.startsWith("notebook-")).toBe(true);
    expect(result.endsWith("-preview.csv")).toBe(true);
    expect(result).not.toMatch(/[<>:"/\\|?*\p{Cc}\p{Cf}]/u);
    expect(result).not.toContain("..");
  });

  it("bounds the filename without splitting surrogate pairs", () => {
    const result = csvPreviewFilename("😀".repeat(100));
    expect(result).toBe(`notebook-${"😀".repeat(40)}-preview.csv`);
    expect(result.length).toBeLessThanOrEqual(101);
    expect(csvPreviewFilename("中".repeat(100))).toBe(`notebook-${"中".repeat(80)}-preview.csv`);
  });
});
