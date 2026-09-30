import { afterAll, describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { executeNotebookSql } from "@/core/notebook/server/query-engine";
import { definition, inputFor, sales, singleDimension } from "../test-fixture";
import { executeVisualization } from "./execute";
import type { ChartDefinitionV2 } from "../definition";
import type { MaterializedVisualization } from "../result";

const evidence: Record<string, { definition: ChartDefinitionV2; result: MaterializedVisualization }> = {};
async function run(d = definition(), table = sales, name?: string) {
  const result = await executeVisualization(await inputFor(d, table), executeNotebookSql);
  if (name) evidence[name] = structuredClone({ definition: d, result }); return result;
}
afterAll(async () => {
  // Optional generated evidence for the isolated browser test. Not a product datastore.
  const target = process.env.VISUALIZATION_V2_EVIDENCE;
  if (target) {
    const file = resolve(target), root = resolve(".runtime");
    if (!file.startsWith(root + sep) || !file.endsWith(".json")) throw Error("Evidence must stay under .runtime");
    await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(evidence, null, 2));
  }
});

describe("V2 real bounded DuckDB computation (synthetic data)", () => {
  it("aggregates complete Chinese sales into a quarterly multi-series table", async () => {
    const result = await run(definition(), sales, "series");
    expect(result.table.rows).toEqual([
      { quarter: "2024-01-01", segment: "个人", amount: 80 }, { quarter: "2024-01-01", segment: "企业", amount: 150 },
      { quarter: "2024-04-01", segment: "个人", amount: 160 }, { quarter: "2024-04-01", segment: "企业", amount: 300 },
    ]);
    expect(result.visualResult).toMatchObject({ inputRowCount: 6, outputRowCount: 4, numericMode: "safe-integer", inputScope: "complete" });
  });
  it("uses all 1,250 upstream rows, not the displayed first 100", async () => {
    const table = { ...sales, rows: Array.from({ length: 1250 }, () => ({ ...sales.rows[0], 成交金额: 2 })) };
    const result = await run(definition(), table);
    expect(result.table.rows[0].amount).toBe(2500); expect(result.visualResult.inputRowCount).toBe(1250);
  });
  it("keeps duplicate raw rows, input order and null values without aggregation", async () => {
    const d = singleDimension(); d.data.mode = "rows"; d.data.measures[0].aggregate = null;
    const table = { ...sales, rows: [{ ...sales.rows[0], 客户类型: "Z", 成交金额: 3 }, { ...sales.rows[0], 客户类型: "A", 成交金额: 0 },
      { ...sales.rows[0], 客户类型: "Z", 成交金额: -2 }, { ...sales.rows[0], 客户类型: "M", 成交金额: null }] };
    expect((await run(d, table, "raw-order")).table.rows).toEqual([{ segment: "Z", amount: 3 }, { segment: "A", amount: 0 }, { segment: "Z", amount: -2 }, { segment: "M", amount: null }]);
  });
  it.each(["year", "month", "day", "none"] as const)("uses real DATE values with %s granularity", async unit => {
    const d = definition(); d.data.dimensions[0].timeUnit = unit;
    const result = await run(d, { ...sales, rows: sales.rows.slice(0, 1) });
    expect(result.table.fields[0].type).toBe("date");
    expect(result.table.rows[0].quarter).toBe(unit === "year" ? "2024-01-01" : unit === "month" ? "2024-01-01" : "2024-01-15");
  });
  it.each([["countRows", 4], ["count", 3], ["distinctCount", 2]] as const)("defines %s NULL semantics", async (aggregate, count) => {
    const d = definition(); d.data.dimensions = [d.data.dimensions[0]]; delete d.encoding.color; d.encoding.tooltip = ["quarter", "amount"];
    d.data.measures[0] = { field: aggregate === "countRows" ? null : "客户类型", as: "amount", aggregate };
    const table = { ...sales, rows: ["甲", "甲", null, "NULL"].map(客户类型 => ({ ...sales.rows[0], 客户类型 })) };
    expect((await run(d, table)).table.rows[0].amount).toBe(count);
  });
  it.each([["sum", 6], ["mean", 2], ["min", -1], ["max", 5], ["median", 2]] as const)("computes %s using DuckDB", async (aggregate, total) => {
    const d = singleDimension(); d.data.measures[0].aggregate = aggregate;
    const table = { ...sales, rows: [-1, 2, 5, null].map(成交金额 => ({ ...sales.rows[0], 成交金额 })) };
    expect((await run(d, table)).table.rows[0].amount).toBe(total);
  });
  it("combines escaped string and numeric filters before grouping", async () => {
    const d = singleDimension(); d.data.filters = [{ kind: "oneOf", field: "客户类型", values: ["O'Reilly"] }, { kind: "range", field: "成交金额", min: 10, max: 20 }];
    const table = { ...sales, rows: [5, 10, 20, 25].map(成交金额 => ({ ...sales.rows[0], 客户类型: "O'Reilly", 成交金额 })) };
    expect((await run(d, table, "filtered")).table.rows).toEqual([{ segment: "O'Reilly", amount: 30 }]);
  });
  it("returns a typed empty result when a filter has no matches", async () => {
    const d = definition(); d.data.filters = [{ kind: "oneOf", field: "客户类型", values: [] }];
    const result = await run(d, sales, "empty"); expect(result.table.rows).toEqual([]); expect(result.table.fields).toHaveLength(3);
  });
  it("supports a typed empty upstream", async () => { expect((await run(definition(), { ...sales, rows: [] })).table.rows).toEqual([]); });
  it("supports the CSV importer UTC-midnight DATE representation without changing input hashes", async () => {
    const table = { ...sales, rows: sales.rows.map(row => ({ ...row, 季度: `${row.季度}T00:00:00.000Z` })) };
    const result = await run(definition(), table);
    expect(result.table.rows).toEqual((await run()).table.rows);
  });
  it("sorts by measure, stabilizes ties, and applies an explicit Top N", async () => {
    const d = singleDimension(); d.data.orderBy = [{ field: "amount", direction: "descending", nulls: "last" }]; d.data.limit = 3;
    const table = { ...sales, rows: [["Z", 30], ["M", 21], ["A", 21], [null, 21], ["Empty", null]].map(([客户类型, 成交金额]) => ({ ...sales.rows[0], 客户类型, 成交金额 })) };
    const result = await run(d, table, "rank");
    expect(result.table.rows).toEqual([{ segment: "Z", amount: 30 }, { segment: "A", amount: 21 }, { segment: "M", amount: 21 }]);
    expect(result.visualResult.explicitLimit).toBe(3);
    delete d.data.limit;
    const full = await run(d, table); expect(full.table.rows.slice(-2)).toEqual([{ segment: null, amount: 21 }, { segment: "Empty", amount: null }]);
  });
  it("rejects an implicit truncated result but accepts an explicit limited complete result", async () => {
    const d = singleDimension(), table = { ...sales, rows: Array.from({ length: 1001 }, (_, i) => ({ ...sales.rows[0], 客户类型: String(i) })) };
    await expect(run(d, table)).rejects.toThrow(/超过展示范围/);
    d.data.limit = 1000; const result = await run(d, table); expect(result.table.rows).toHaveLength(1000); expect(result.table.truncated).toBe(false);
  });
  it("does not silently round an overflowing integer SUM; cancellation is exact", async () => {
    const d = singleDimension(), table = { ...sales, rows: [Number.MAX_SAFE_INTEGER, 2].map(成交金额 => ({ ...sales.rows[0], 成交金额 })) };
    await expect(run(d, table)).rejects.toThrow(/精度|安全数值/);
    table.rows.push({ ...sales.rows[0], 成交金额: -Number.MAX_SAFE_INTEGER });
    expect((await run(d, table)).table.rows[0].amount).toBe(2);
  });
  it("labels Float64 arithmetic honestly and rejects decimal text measures", async () => {
    const d = singleDimension(), table = { ...sales, rows: [0.1, 0.2].map(成交金额 => ({ ...sales.rows[0], 成交金额 })) };
    const result = await run(d, table); expect(result.table.rows[0].amount).toBeCloseTo(0.3); expect(result.visualResult.numericMode).toBe("float64");
    const exact = structuredClone(sales); exact.fields[2].type = "string"; exact.rows = [{ ...sales.rows[0], 成交金额: "9007199254740993.01" }];
    await expect(run(d, exact)).rejects.toThrow(/decimal/);
  });
});
