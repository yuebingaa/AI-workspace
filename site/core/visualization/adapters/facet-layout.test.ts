import { describe, expect, it } from "vitest";
import { materializedFacetGrid, materializedFacetSize } from "./facet-layout";
import { definition } from "../test-fixture";
import type { DataTable } from "@/core/datasets/table-contracts";

describe("materialized facet layout (no computation)", () => {
  const d = definition(); d.encoding.facetX = "region"; d.encoding.facetY = "channel";
  const table: DataTable = { fields: [], rows: ["东区", "西区"].flatMap(region => ["直销", "伙伴"].map(channel => ({ region, channel }))), truncated: false };
  it("counts panels while leaving every computed row untouched", () => {
    const before = structuredClone(table); expect(materializedFacetGrid(d, table)).toEqual({ enabled: true, columns: 2, rows: 2 }); expect(table).toEqual(before);
    expect(materializedFacetSize({ width: 400, height: 300 }, materializedFacetGrid(d, table))).toEqual({ width: 260, height: 200 });
  });
  it("supports no facets and typed empty results without a zero-size division", () => {
    expect(materializedFacetGrid(definition(), table)).toEqual({ enabled: false, columns: 1, rows: 1 });
    expect(materializedFacetGrid(d, { ...table, rows: [] })).toEqual({ enabled: true, columns: 1, rows: 1 });
  });
  it.each([null, true, 123])("refuses ambiguous non-text facets %s", region => {
    expect(() => materializedFacetGrid(d, { ...table, rows: [{ region, channel: "直销" }] })).toThrow(/分面/);
  });
  it("bounds the Cartesian grid, not just populated facet pairs; never truncates", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ region: `r${i}`, channel: `c${i}` }));
    expect(() => materializedFacetGrid(d, { ...table, rows })).toThrow(/36/); expect(rows).toHaveLength(7);
    expect(materializedFacetGrid(d, { ...table, rows: rows.slice(0, 6) })).toEqual({ enabled: true, columns: 6, rows: 6 });
  });
});
