// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { initialConfig } from "./config";
import { salesSample } from "./sample";
import { nativeChart, configFromNative, observeNativeChart } from "./native-adapter";
import { VizSpecStore } from "@kanaries/graphic-walker";
import { metadata } from "./config";
import { readFile } from "node:fs/promises";

describe("official Graphic Walker public chart round-trip", () => {
  it("installs the pinned ESM fix for later Tooltip aggregation and removal", async () => {
    const source = await readFile("node_modules/@kanaries/graphic-walker/dist/graphic-walker.es.js", "utf8");
    expect(source).toContain("r.setFieldAggregator(t.id, b, x)");
    expect(source).toContain("r.removeField(t.id, b)");
  });
  it("observes the official undo timeline without depending on auto-action export tracking", () => {
    const config = initialConfig(salesSample), store = new VizSpecStore(metadata(salesSample));
    store.importCode([nativeChart(config, salesSample)]);
    const initial = JSON.stringify(store.exportCode()[0]), dirty: boolean[] = [];
    const dispose = observeNativeChart(store, snapshot => dirty.push(JSON.stringify(snapshot) !== initial));
    const other = new VizSpecStore(metadata(salesSample));
    other.importCode([nativeChart(config, salesSample)]);
    other.setFieldAggregator("rows", 0, "mean");
    expect(dirty).toEqual([]);
    store.setFieldAggregator("rows", 0, "mean");
    store.undo();
    expect(dirty).toEqual([true, false]);
    dispose();
    store.setFieldAggregator("rows", 0, "max");
    expect(dirty).toEqual([true, false]);
  });
  it("round-trips quarter, aggregate, series, facets, filters and saved theme", () => {
    const config = initialConfig(salesSample);
    config.filters = [{ field: "customer", kind: "oneOf", values: ["企业客户"] }];
    config.channels.facetX = { field: "customer", aggregate: "sum", timeUnit: "none" };
    config.channels.facetY = { field: "quarter", aggregate: "sum", timeUnit: "year" };
    config.style.palette = "warm";
    expect(configFromNative(nativeChart(config, salesSample), config, salesSample)).toEqual(config);
  });
  it("maps real official aggregate / mark edits back to the shared config", () => {
    const config = initialConfig(salesSample), chart = nativeChart(config, salesSample);
    chart.encodings.rows[0].aggName = "mean"; chart.config.geoms = ["line"];
    expect(configFromNative(chart, config, salesSample)).toMatchObject({ mark: "line", channels: { y: { aggregate: "mean" } } });
  });
  it("does not silently discard unsupported official operations", () => {
    const config = initialConfig(salesSample);
    for (const mutate of [
      (chart: ReturnType<typeof nativeChart>) => { chart.config.defaultAggregated = false; },
      (chart: ReturnType<typeof nativeChart>) => { chart.config.geoms = ["point"]; },
      (chart: ReturnType<typeof nativeChart>) => { chart.layout.zeroScale = false; },
      (chart: ReturnType<typeof nativeChart>) => { chart.encodings.size = [chart.encodings.rows[0]]; },
      (chart: ReturnType<typeof nativeChart>) => { chart.encodings.rows[0].name = "无法保留的别名"; },
    ]) { const chart = nativeChart(config, salesSample); mutate(chart); expect(() => configFromNative(chart, config, salesSample)).toThrow(/无损保存/); }
  });
});
