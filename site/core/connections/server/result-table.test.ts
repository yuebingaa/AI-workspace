import { describe, expect, it } from "vitest";
import { tableFromText } from "./result-table";
import { CONNECTION_QUERY_LIMITS, ConnectionQueryError } from "./query-contracts";

describe("database result mapping compatibility", () => {
  const fields = [
    { name: "amount", label: "Amount", type: "number" as const },
    { name: "exact", label: "Exact", type: "string" as const },
    { name: "when", label: "When", type: "date" as const },
    { name: "active", label: "Active", type: "boolean" as const },
  ];
  it("preserves precision, date/timezone strings, nulls and empty results", () => {
    expect(tableFromText(fields, [["-12.5", "9007199254740993.123456789", "2026-09-14T08:00:00+08:00", "f"], [null, null, null, null]], false)).toEqual({
      fields, rows: [{ amount: -12.5, exact: "9007199254740993.123456789", when: "2026-09-14T08:00:00+08:00", active: false },
        { amount: null, exact: null, when: null, active: null }], truncated: false,
    });
    expect(tableFromText(fields, [], false)).toEqual({ fields, rows: [], truncated: false });
    expect(tableFromText(fields, [], true).truncated).toBe(true);
  });
  it("retains row/byte/column bounds and rejects malformed primitive values", () => {
    const raw = Array.from({ length: 1001 }, () => ["1", "", null, "t"]);
    const result = tableFromText(fields, raw, false);
    expect(result.rows).toHaveLength(1000);
    expect(result.truncated).toBe(true);
    expect(() => tableFromText(fields, [["NaN", "", null, true]], false)).toThrow("NaN / Infinity");
    expect(() => tableFromText(fields, [[1, "", null, "not-a-boolean"]], false)).toThrow("无效布尔");
    expect(() => tableFromText(fields, [[1]], false)).toThrow("列数不一致");
    expect(() => tableFromText([fields[0], fields[0]], [], false)).toThrow("不重名");
    expect(() => tableFromText(fields, [[1, "x".repeat(20_001), null, true]], false)).toThrow("20000");
    expect(() => tableFromText(fields, Array.from({ length: 110 }, () => [1, "x".repeat(20_000), null, true]), false)).toThrow("2 MiB");
  });
});

const stringField = { name: "value", label: "Value", type: "string" as const };

describe("connection result table boundary", () => {
  it("owns the unchanged row, byte, timeout and concurrency policies", () => {
    expect(CONNECTION_QUERY_LIMITS).toEqual({ rows: 1_000, outputBytes: 2 * 1024 * 1024, timeoutMs: 12_000, maxConcurrent: 2 });
  });

  it("preserves exact text, dates, nulls and field order while converting declared scalars", () => {
    const fields = [stringField, { name: "date", label: "Date", type: "date" as const },
      { name: "amount", label: "Amount", type: "number" as const }, { name: "enabled", label: "Enabled", type: "boolean" as const }];
    const raw = [["9007199254740993.123456789", "2026-09-16T12:34:56.123456+08:00", "-7.25", "t"], [null, null, null, null]];
    const result = tableFromText(fields, raw, false);
    expect(result).toEqual({ fields, rows: [
      { value: "9007199254740993.123456789", date: "2026-09-16T12:34:56.123456+08:00", amount: -7.25, enabled: true },
      { value: null, date: null, amount: null, enabled: null },
    ], truncated: false });
    expect(Object.keys(result.rows[0])).toEqual(fields.map((field) => field.name));
    expect(raw[0][2]).toBe("-7.25");
  });

  it("keeps exactly 1000 rows complete but marks an extra row as truncated", () => {
    const raw = Array.from({ length: 1_000 }, (_, index) => [String(index)]);
    expect(tableFromText([stringField], raw, false)).toMatchObject({ rows: expect.arrayContaining([{ value: "999" }]), truncated: false });
    const limited = tableFromText([stringField], [...raw, ["1000"]], false);
    expect(limited.rows).toHaveLength(1_000);
    expect(limited.rows.at(-1)).toEqual({ value: "999" });
    expect(limited.truncated).toBe(true);
  });

  it("requires 1–100 unique fields and retains schema field bounds", () => {
    const fields = Array.from({ length: 100 }, (_, index) => ({ ...stringField, name: `field_${index}` }));
    expect(tableFromText(fields, [], false).fields).toHaveLength(100);
    for (const invalid of [[], [stringField, stringField], [...fields, { ...stringField, name: "extra" }]]) {
      expect(() => tableFromText(invalid, [], false)).toThrow("查询结果需要 1–100 个不重名的字段");
    }
    expect(() => tableFromText([{ ...stringField, name: "x".repeat(121) }], [], false)).toThrow();
    expect(() => tableFromText([{ ...stringField, label: "x".repeat(161) }], [], false)).toThrow();
  });

  it("rejects missing values, non-finite numbers and invalid booleans without coercing them", () => {
    expect(() => tableFromText([stringField], [[]], false)).toThrow("查询结果列数不一致");
    for (const value of ["NaN", "Infinity", "not-a-number"]) {
      expect(() => tableFromText([{ ...stringField, type: "number" }], [[value]], false)).toThrow("查询结果包含 NaN / Infinity");
    }
    for (const value of [1, 0, "1", "TRUE", ""]) {
      expect(() => tableFromText([{ ...stringField, type: "boolean" }], [[value]], false)).toThrow("无效布尔结果");
    }
    expect(tableFromText([{ ...stringField, type: "boolean" }], [[true], [false], ["true"], ["false"], ["t"], ["f"]], false).rows)
      .toEqual([true, false, true, false, true, false].map((value) => ({ value })));
  });

  it("retains the 20000-character cell bound and rejects extra field properties", () => {
    expect(tableFromText([stringField], [["x".repeat(20_000)]], false).rows[0].value).toHaveLength(20_000);
    expect(() => tableFromText([stringField], [["x".repeat(20_001)]], false)).toThrow();
    const fieldWithExtra = { ...stringField, privateMetadata: "not part of result" };
    expect(() => tableFromText([fieldWithExtra], [], false)).toThrow();
  });

  it("checks the transformed table's UTF-8 bytes independently of row and cell counts", () => {
    const raw = Array.from({ length: 40 }, () => ["数".repeat(20_000)]);
    expect(() => tableFromText([stringField], raw, false)).toThrow(ConnectionQueryError);
    expect(() => tableFromText([stringField], raw, false)).toThrow("数据库结果超过 2 MiB，请减少返回列或先聚合");
  });
});
