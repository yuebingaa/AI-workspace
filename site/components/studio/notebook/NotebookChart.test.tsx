import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookTable } from "@/core/notebook/contracts";
import { NotebookChart } from "./NotebookChart";

// Observe the rendering adapter contract, not Recharts layout or SVG geometry.
// Real rendering remains covered by the isolated development-site screenshots.
const calls = vi.hoisted(() => new Map<string, Record<string, unknown>[]>());
vi.mock("recharts", async () => {
  const { createElement, Fragment } = await import("react");
  const names = ["Area", "AreaChart", "Bar", "BarChart", "CartesianGrid", "Cell", "Legend", "Line", "LineChart", "Pie", "PieChart", "ResponsiveContainer", "Tooltip", "XAxis", "YAxis"];
  return Object.fromEntries(names.map((name) => [name, function ChartAdapterProbe(props: Record<string, unknown> & { children?: ReactNode }) {
    const previous = calls.get(name) ?? [];
    previous.push(props);
    calls.set(name, previous);
    return createElement(Fragment, null, props.children);
  }]));
});

type ChartCell = Extract<NotebookCell, { kind: "chart" }>;
const colors = ["#343431", "#74716b", "#a4a099", "#c6c2bb"];
const cases = [
  ["bar", "BarChart", "Bar"], ["line", "LineChart", "Line"], ["area", "AreaChart", "Area"],
  ["pie", "PieChart", "Pie"], ["donut", "PieChart", "Pie"],
] as const;
function cell(chartType: ChartCell["chartType"]): ChartCell {
  return { id: "chart", kind: "chart", title: "合成结果图", inputCellId: "source", chartType,
    categoryField: "category", valueFields: ["revenue", "cost"] };
}
function table(): NotebookTable {
  return { fields: [{ name: "category", label: "地区", type: "string" },
    { name: "revenue", label: "收入", type: "number" }, { name: "cost", label: "成本", type: "number" }],
  rows: [{ category: "Beta", revenue: 8, cost: 4 }, { category: "Alpha", revenue: 3, cost: 2 }], truncated: false };
}

beforeEach(() => calls.clear());

describe("Notebook chart rendering boundary", () => {
  it.each(cases)("preserves %s adapter, original row order and accessible chart label", (kind, chart, series) => {
    const input = table();
    const html = renderToStaticMarkup(<NotebookChart cell={cell(kind)} table={input} />);
    expect(html).toContain('class="notebook-plot" role="img" aria-label="合成结果图，图表下方提供对应数据表"');
    expect(calls.get(series)?.map((props) => props.dataKey)).toEqual(["revenue", "cost"]);
    const dataCalls = calls.get(kind === "pie" || kind === "donut" ? "Pie" : chart);
    expect(dataCalls?.length).toBe(kind === "pie" || kind === "donut" ? 2 : 1);
    for (const props of dataCalls ?? []) expect(props.data).toEqual(input.rows);
    expect(html).not.toContain("前 100 行");
    expect(html).not.toContain("role=\"alert\"");
    expect(html).not.toContain("<table");
  });

  it.each(cases)("caps %s at the first 100 source rows without sorting or mutating input", (kind, chart) => {
    const input = table();
    input.rows = Array.from({ length: 101 }, (_, index) => ({ category: `row_${101 - index}`, revenue: index, cost: 0 }));
    const before = structuredClone(input);
    Object.freeze(input.rows);
    const html = renderToStaticMarkup(<NotebookChart cell={cell(kind)} table={input} />);
    const dataCalls = calls.get(kind === "pie" || kind === "donut" ? "Pie" : chart);
    for (const props of dataCalls ?? []) {
      expect(props.data).toEqual(before.rows.slice(0, 100));
      expect(props.data).not.toBe(input.rows);
    }
    expect(input).toEqual(before);
    expect(html).toContain("图表仅绘制前 100 行；请聚合后查看完整分布。");
  });

  it.each(cases)("does not fabricate an empty %s chart", (kind) => {
    const input = { ...table(), rows: [] };
    expect(renderToStaticMarkup(<NotebookChart cell={cell(kind)} table={input} />)).toBe("");
    expect(calls.size).toBe(0);
  });

  it.each(["pie", "donut"] as const)("rejects a negative value in any %s series before rendering a plot", (kind) => {
    const input = table();
    input.rows[1].cost = -1;
    expect(renderToStaticMarkup(<NotebookChart cell={cell(kind)} table={input} />))
      .toBe('<p role="alert">饼图不能表示负数，请选择柱状图或折线图。</p>');
    expect(calls.size).toBe(0);
  });

  it.each(["bar", "line", "area"] as const)("retains negative, null and precise string data for %s without coercion", (kind) => {
    const input = table();
    input.rows = [{ category: null, revenue: -1, cost: null }, { category: "exact", revenue: "9007199254740993.00001", cost: 0 }];
    renderToStaticMarkup(<NotebookChart cell={cell(kind)} table={input} />);
    const chart = { bar: "BarChart", line: "LineChart", area: "AreaChart" }[kind];
    expect(calls.get(chart)?.[0].data).toEqual(input.rows);
  });

  it("keeps the rendering guard limited to visible numeric negatives, not hidden rows or string coercion", () => {
    const input = table();
    input.rows = Array.from({ length: 101 }, (_, index) => ({ category: String(index), revenue: index === 100 ? -1 : "-1", cost: null }));
    const html = renderToStaticMarkup(<NotebookChart cell={cell("pie")} table={input} />);
    expect(html).not.toContain('role="alert"');
    expect(calls.get("Pie")?.[0].data).toEqual(input.rows.slice(0, 100));
  });

  it.each(["bar", "line", "area"] as const)("retains %s theme, axis dimensions, animation and null-gap settings", (kind) => {
    const chartCell = { ...cell(kind), valueFields: ["revenue", "cost", "third", "fourth"] };
    renderToStaticMarkup(<NotebookChart cell={chartCell} table={table()} />);
    expect(calls.get("ResponsiveContainer")).toEqual([expect.objectContaining({ width: "100%", height: 280, minWidth: 0 })]);
    expect(calls.get("CartesianGrid")).toEqual([expect.objectContaining({ stroke: "var(--studio-hairline, #e8e6e2)", vertical: false })]);
    expect(calls.get("XAxis")).toEqual([expect.objectContaining({ dataKey: "category", tick: { fontSize: 11 }, minTickGap: 16 })]);
    expect(calls.get("YAxis")).toEqual([expect.objectContaining({ tick: { fontSize: 11 }, width: 58 })]);
    expect(calls.get("Tooltip")).toHaveLength(1);
    expect(calls.get("Legend")).toHaveLength(1);
    const series = calls.get({ bar: "Bar", line: "Line", area: "Area" }[kind]);
    expect(series).toHaveLength(4);
    for (const [index, props] of (series ?? []).entries()) {
      expect(props.isAnimationActive).toBe(false);
      expect(props.dataKey).toBe(chartCell.valueFields[index]);
      if (kind === "bar") expect(props).toMatchObject({ fill: colors[index], radius: [3, 3, 0, 0] });
      else expect(props).toMatchObject({ stroke: colors[index], connectNulls: false });
      if (kind === "area") expect(props).toMatchObject({ fill: colors[index], fillOpacity: 0.12 });
    }
  });

  it.each(["pie", "donut"] as const)("retains per-series %s circles, dimensions and rotating category palette", (kind) => {
    const html = renderToStaticMarkup(<NotebookChart cell={cell(kind)} table={table()} />);
    expect(html).toContain('class="notebook-pies"');
    expect(html).toContain("<b>revenue</b>");
    expect(html).toContain("<b>cost</b>");
    expect(calls.get("ResponsiveContainer")).toHaveLength(2);
    for (const props of calls.get("ResponsiveContainer") ?? []) expect(props).toMatchObject({ width: "100%", height: 240, minWidth: 0 });
    for (const props of calls.get("Pie") ?? []) expect(props).toMatchObject({ nameKey: "category", innerRadius: kind === "donut" ? 48 : 0, outerRadius: 78, isAnimationActive: false });
    expect(calls.get("Cell")?.map((props) => props.fill)).toEqual([colors[0], colors[1], colors[1], colors[2]]);
    expect(calls.get("CartesianGrid")).toBeUndefined();
    expect(calls.get("XAxis")).toBeUndefined();
    expect(calls.get("YAxis")).toBeUndefined();
  });

  it("escapes a title as an accessible label and does not retain an earlier render's data", () => {
    const chartCell = { ...cell("bar"), title: '<img src=x onerror="alert(1)">' };
    const first = table();
    renderToStaticMarkup(<NotebookChart cell={chartCell} table={first} />);
    const second = { ...table(), rows: [{ category: "fresh", revenue: 0, cost: 0 }] };
    const html = renderToStaticMarkup(<NotebookChart cell={chartCell} table={second} />);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).not.toContain("<img");
    expect(calls.get("BarChart")?.map((props) => props.data)).toEqual([first.rows, second.rows]);
  });
});
