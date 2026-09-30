import { describe, expect, it } from "vitest";
import { parseChartDefinitionV2, visualizationDataKey } from "./definition";
import { definition, sales, singleDimension } from "./test-fixture";
import { compileVisualization } from "./plan";

describe("portable V2 definition and compiler", () => {
  it("round trips JSON without renderer state or a Notebook dependency", () => {
    expect(parseChartDefinitionV2(JSON.parse(JSON.stringify(definition())))).toEqual(definition());
  });
  it.each([
    (d: ReturnType<typeof definition>) => { d.schemaVersion = 3 as 2; },
    d => { Object.assign(d, { graphicWalker: {} }); },
    d => { d.data.measures.push({ field: "成交金额", as: "extra", aggregate: "sum" }); },
    d => { d.encoding.y = "missing"; },
    d => { d.data.measures[0].as = "QUARTER"; },
    d => { d.data.dimensions[0].as = "viz_input_order"; },
    d => { d.data.timezone = "Asia/Shanghai" as "UTC"; },
    d => { d.data.orderBy = [{ field: "missing", direction: "descending", nulls: "last" }]; },
    d => { d.encoding.tooltip.push("missing"); },
    d => { delete d.encoding.color; },
    d => { d.encoding.facetX = "missing"; },
    d => { d.encoding.facetY = "amount"; },
    d => { d.encoding.facetX = d.encoding.color; },
    d => { d.data.mode = "rows"; },
    d => { d.data.measures[0] = { field: "成交金额", as: "amount", aggregate: "countRows" }; },
    d => { d.data.filters = [{ kind: "range", field: "成交金额", min: 20, max: 10 }]; },
  ] satisfies ((d: ReturnType<typeof definition>) => void)[])("rejects unsupported/ambiguous definition %#", edit => {
    const d = definition(); edit(d); expect(() => parseChartDefinitionV2(d)).toThrow(/配置/);
  });
  it("keeps presentation and mark out of computation identity", () => {
    const d = definition(), key = visualizationDataKey(d); d.presentation.palette = "warm"; d.mark = "line";
    expect(visualizationDataKey(d)).toBe(key); d.data.limit = 5; expect(visualizationDataKey(d)).not.toBe(key);
  });
  it("allows four visible grouping dimensions; facet grouping changes calculation identity", () => {
    const d = definition(), before = visualizationDataKey(d);
    d.data.dimensions.push({ field: "地区", as: "region", timeUnit: "none" }, { field: "渠道", as: "channel", timeUnit: "none" });
    d.encoding.facetX = "region"; d.encoding.facetY = "channel"; d.encoding.tooltip.push("region", "channel");
    expect(parseChartDefinitionV2(d)).toEqual(d); expect(visualizationDataKey(d)).not.toEqual(before);
    delete d.encoding.facetY; expect(() => parseChartDefinitionV2(d)).toThrow();
  });
  it("quotes identifiers and literals without accepting raw SQL", () => {
    const d = singleDimension(), table = structuredClone(sales), column = '客户"类型';
    table.fields[1].name = column; table.rows = table.rows.map(({ 客户类型, ...rest }) => ({ ...rest, [column]: 客户类型 }));
    d.data.dimensions[0].field = column;
    d.data.filters = [{ kind: "oneOf", field: column, values: ["O'Reilly", null] }];
    const plan = compileVisualization(d, table);
    expect(plan.sql).toContain('"客户""类型"'); expect(plan.sql).toContain("'O''Reilly'");
    expect(plan.sql).toContain("IS NULL"); expect(plan.sql).toContain("NULLS LAST");
  });
  it.each([
    (t: typeof sales) => { t.truncated = true; },
    t => { delete t.rows[0].成交金额; },
    t => { t.rows[0].成交金额 = Number.MAX_SAFE_INTEGER + 1; },
    t => { t.rows[0].季度 = "2024-02-30"; },
    t => { t.rows[0].季度 = "2024-01-01T00:00:00Z"; },
    t => { t.fields.push({ ...t.fields[0] }); },
  ] satisfies ((t: typeof sales) => void)[])("refuses unsafe source %#", edit => {
    const table = structuredClone(sales); edit(table); expect(() => compileVisualization(definition(), table)).toThrow();
  });
});
