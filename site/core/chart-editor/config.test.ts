import { describe, expect, it } from "vitest";
import { assignField, canAssign, graphicSpec, graphicTheme, initialConfig, metadata, restoreConfig } from "./config";
import { salesSample } from "./sample";

describe("Graphic Walker editor boundary", () => {
  it("uses an explicitly synthetic, deliberately unsorted transactional source", () => {
    expect(salesSample.synthetic).toBe(true);
    expect(salesSample.rows).toHaveLength(48);
    expect(String(salesSample.rows[0].quarter) > String(salesSample.rows.at(-1)?.quarter)).toBe(true);
    expect(salesSample.rows.reduce((sum, row) => sum + Number(row.amount), 0)).toBe(6_408_000);
  });
  it("delegates quarter drilling, SUM and stacking to the official spec", () => {
    const spec = graphicSpec(initialConfig(salesSample), salesSample);
    expect(spec).toMatchObject({ mark: "area", stack: "stack", aggregate: true, x: [{ field: "fid:quarter", sort: "ascending", timeUnit: "quarter" }],
      y: [{ field: "fid:amount", aggregate: "sum" }], color: { field: "fid:customer" }, config: { timezoneDisplayOffset: 0 }, layout: { format: { timeFormat: "%Y Q%q" } } });
    expect(metadata(salesSample)).toContainEqual({ fid: "amount", name: "成交金额", semanticType: "quantitative", analyticType: "measure" });
    expect(metadata(salesSample)).toContainEqual({ fid: "quarter", name: "季度", semanticType: "temporal", analyticType: "dimension", offset: 0 });
  });
  it("rejects incompatible fields from clicks and drag/drop without changing the old state", () => {
    const config = initialConfig(salesSample);
    expect(() => assignField(config, salesSample, "y", "customer")).toThrow("不支持");
    expect(() => assignField(config, salesSample, "x", "missing")).toThrow();
    expect(canAssign("facetX", salesSample.fields[1])).toBe(false);
    expect(config.channels.y?.field).toBe("amount");
  });
  it("puts facets before the main axes and includes tooltip details without duplicate chips", () => {
    let config = assignField(initialConfig(salesSample), salesSample, "facetY", "customer");
    config = assignField(config, salesSample, "tooltip", "amount");
    config = assignField(config, salesSample, "tooltip", "amount");
    expect(config.channels.tooltip).toHaveLength(1);
    expect(graphicSpec(config, salesSample).y).toEqual([{ field: "fid:customer", sort: "ascending" }, { field: "fid:amount", sort: "ascending", aggregate: "sum" }]);
  });
  it("round trips config/style/filters, never raw rows or executable expressions", () => {
    const config = initialConfig(salesSample);
    config.style.palette = "warm"; config.style.grid = false;
    config.filters = [{ field: "customer", kind: "oneOf", values: ["企业客户"] }, { field: "amount", kind: "range", min: 50000, max: null }];
    const text = JSON.stringify(config);
    expect(restoreConfig(text, salesSample)).toEqual(config);
    expect(text).not.toContain('"rows"');
    expect(graphicSpec(config, salesSample).filters).toEqual([{ field: "fid:customer", oneOf: ["企业客户"] }, { field: "fid:amount", range: [50000, null] }]);
    expect(() => restoreConfig(JSON.stringify({ ...config, expression: "fetch('https://invalid')" }), salesSample)).toThrow("格式");
  });
  it("rejects wrong source, unknown fields, bad types, ranges, versions and corrupt JSON", () => {
    const config = initialConfig(salesSample);
    expect(() => restoreConfig("{", salesSample)).toThrow();
    expect(() => restoreConfig(" ".repeat(250001), salesSample)).toThrow("过大");
    expect(() => restoreConfig(JSON.stringify({ ...config, datasetId: "other" }), salesSample)).toThrow("其他数据源");
    expect(() => restoreConfig(JSON.stringify({ ...config, version: 99 }), salesSample)).toThrow("版本");
    config.channels.y!.field = "customer";
    expect(() => restoreConfig(JSON.stringify(config), salesSample)).toThrow("类型不兼容");
    config.channels.y!.field = "missing";
    expect(() => restoreConfig(JSON.stringify(config), salesSample)).toThrow("字段");
    config.channels.y!.field = "amount"; config.channels.y!.timeUnit = "year";
    expect(() => restoreConfig(JSON.stringify(config), salesSample)).toThrow("类型不兼容");
    config.channels.y!.timeUnit = "none";
    config.filters = [{ field: "amount", kind: "range", min: 2, max: 1 }];
    expect(() => restoreConfig(JSON.stringify(config), salesSample)).toThrow("下限");
  });
  it("projects styles through public Vega theme options", () => {
    const config = initialConfig(salesSample); config.style.axes = false; config.style.legend = false; config.style.grid = false; config.style.fontSize = 16;
    const theme = graphicTheme(config).light;
    expect(theme).toMatchObject({ axis: { labels: false, titleOpacity: 0, grid: false, labelFontSize: 16 }, legend: { disable: true }, range: { category: expect.any(Array) } });
    expect(theme.mark.color).toBe(theme.range.category[0]);
  });
});
