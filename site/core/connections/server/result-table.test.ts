import { describe, expect, it } from "vitest";
import { tableFromText } from "./result-table";

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
