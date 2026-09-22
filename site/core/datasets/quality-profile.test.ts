import { describe, expect, it } from "vitest";
import type { DataRow, DataSourceDefinition } from "@/core/models";
import { parseCsvUpload } from "./server/csv-dataset";
import { profileDatasetRows } from "./quality-profile";

function source(names: string[], rowCount: number): Pick<DataSourceDefinition, "fields" | "rowCount"> {
  return { rowCount, fields: names.map((name) => ({ name, label: name, type: "string", aggregatable: false, supportedAggregations: ["none"] })) };
}

describe("current Dataset statistics and explicit counting rules", () => {
  it("counts null/missing separately from blank strings, zero, false and null-like text", () => {
    const rows: DataRow[] = [{ a: null }, {}, { a: "" }, { a: " " }, { a: "\t" }, { a: 0 }, { a: false }, { a: "NULL" }];
    const before = structuredClone(rows);
    const result = profileDatasetRows(source(["a"], 8), rows);
    expect(result).toMatchObject({ version: 1, rowCount: 8, declaredRowCount: 8, rowCountMatchesSource: true,
      columnCount: 1, cellCount: 8, nullCellCount: 2, nullRate: 0.25, emptyRowCount: 2,
      duplicateRowCount: 1, nonNullBlankStringCount: 3,
      rules: { scope: "current-dataset-rows", nulls: "null-or-missing", blankStrings: "not-null",
        duplicates: "typed-all-declared-fields-excluding-first", emptyRows: "all-declared-fields-null",
        denominator: "rows-times-declared-columns", originalFile: "not-measured" } });
    expect(rows).toEqual(before);
  });

  it("compares declared columns in stable order and counts repeats after the first only", () => {
    const rows: DataRow[] = [
      { a: 1, b: "x", extra: "one" }, { b: "x", a: 1, extra: "two" }, { a: 1, b: "x" },
      { a: "1", b: "x" }, { a: 1, b: "X" }, { a: 1, b: "x " },
    ];
    expect(profileDatasetRows(source(["a", "b"], 6), rows)).toMatchObject({ duplicateRowCount: 2, cellCount: 12 });
    expect(profileDatasetRows(source(["a", "b"], 6), rows.slice(0, 2))).toMatchObject({
      rowCount: 2, declaredRowCount: 6, rowCountMatchesSource: false, duplicateRowCount: 1,
    });
  });

  it("counts all supplied rows rather than the first visible preview and returns no raw values", () => {
    const rows = Array.from({ length: 27 }, (_, index) => ({ a: index < 25 ? `private-marker-${index}` : null }));
    const profile = profileDatasetRows(source(["a"], 27), rows);
    expect(profile).toMatchObject({ rowCount: 27, nullCellCount: 2, emptyRowCount: 2, duplicateRowCount: 1 });
    expect(JSON.stringify(profile)).not.toContain("private-marker");
  });

  it("defines zero-row and zero-column behavior without treating zero-column rows as empty duplicates", () => {
    expect(profileDatasetRows(source(["a"], 0), [])).toMatchObject({ rowCount: 0, cellCount: 0, nullRate: 0, emptyRowCount: 0, duplicateRowCount: 0 });
    expect(profileDatasetRows(source([], 2), [{}, {}])).toMatchObject({ rowCount: 2, cellCount: 0, nullRate: 0, emptyRowCount: 0, duplicateRowCount: 0 });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects non-finite values instead of silently conflating %s with null", (value) => {
    expect(() => profileDatasetRows(source(["private-field"], 2), [{ "private-field": value }, { "private-field": null }]))
      .toThrow("统计输入包含非有限数值");
  });

  it("matches existing CSV normalization and quality counts without changing the imported data", async () => {
    const csv = 'category,amount,note\nA,1,x\nA,01,x\nA,1.0,x\nB,2,\nB,2,"   "\n,,\nC,0,false\nC,0,false\nD,,NULL';
    const bytes = new TextEncoder().encode(csv);
    const imported = await parseCsvUpload({ originalFileName: "quality-synthetic.csv", mimeType: "text/csv",
      stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) });
    const before = structuredClone(imported);
    const result = profileDatasetRows(imported.dataset.source, imported.rows);
    expect(result).toMatchObject({ rowCount: 9, columnCount: 3, cellCount: 27, nullCellCount: 6,
      nullRate: 6 / 27, emptyRowCount: 1, duplicateRowCount: 4, nonNullBlankStringCount: 0 });
    expect(imported.rows.slice(0, 3)).toEqual(Array.from({ length: 3 }, () => ({ category: "A", amount: 1, note: "x" })));
    expect(imported.rows[8]).toEqual({ category: "D", amount: null, note: "NULL" });
    expect(imported.dataset.source.quality).toMatchObject({ nullCellCount: result.nullCellCount,
      nullRate: result.nullRate, duplicateRowCount: result.duplicateRowCount });
    expect(imported).toEqual(before);
  });
});
