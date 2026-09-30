import { normalize, type IChart, type IViewField, type VizSpecStore } from "@kanaries/graphic-walker";
import { graphicSpec, metadata, restoreConfig, type Assignment, type ChartConfig, type ChartDataset, type ChartFilter } from "./config";

export function nativeChart(config: ChartConfig, dataset: ChartDataset): IChart {
  return normalize(graphicSpec(config, dataset), metadata(dataset));
}

/** GW 0.5.2 emits this event from its own MobX runtime. Keep this version-specific
 * seam here; a second MobX import cannot reliably observe the bundled store. */
export function observeNativeChart(store: VizSpecStore, onChange: (chart: IChart) => void): () => void {
  const listener = (event: Event) => {
    if (event instanceof CustomEvent && event.detail?.instanceID === store.instanceID) onChange(store.exportCode()[0]);
  };
  document.addEventListener("edit-graphic-walker", listener);
  return () => document.removeEventListener("edit-graphic-walker", listener);
}
const fail = (feature: string): never => { throw Error(`当前 Notebook 尚不能无损保存${feature}，请撤销此项后保存；已保存图表未改动。`); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Strict, isolated public-IChart adapter. Unsupported native edits never silently disappear. */
export function configFromNative(chart: IChart, base: ChartConfig, dataset: ChartDataset): ChartConfig {
  const original = nativeChart(base, dataset);
  if (chart.config.geoms.length !== 1 || !["bar", "line", "area"].includes(chart.config.geoms[0])) fail("这个图表类型（目前为柱 / 线 / 面积图）");
  for (const key of Object.keys(chart.config) as (keyof IChart["config"])[]) {
    if (key !== "geoms" && !same(chart.config[key], original.config[key])) fail(`计算设置 ${key}`);
  }
  for (const key of Object.keys(chart.layout) as (keyof IChart["layout"])[]) {
    if (!["stack", "format"].includes(key) && !same(chart.layout[key], original.layout[key])) fail(`显示设置 ${key}`);
  }
  for (const key of Object.keys(chart.layout.format) as (keyof IChart["layout"]["format"])[]) {
    if (key !== "numberFormat" && !same(chart.layout.format[key], original.layout.format[key])) fail(`格式 ${key}`);
  }
  const enc = chart.encodings;
  for (const field of [...enc.dimensions, ...enc.measures]) {
    const source = dataset.fields.find(item => item.id === field.fid);
    if (source && field.name !== source.name) fail("数据字段重命名");
  }
  for (const [key, fields] of Object.entries(enc)) {
    if (!["dimensions", "measures", "columns", "rows", "color", "details", "filters"].includes(key) && fields.length) fail(`通道 ${key}`);
  }
  if (enc.columns.length < 1 || enc.rows.length < 1) throw Error("请在官方编辑器中配置列（X）和行（Y）。");
  if (enc.columns.length > 2 || enc.rows.length > 2 || enc.color.length > 1) fail("多指标或多层分面");
  function assignment(field: IViewField): Assignment {
    let id = field.fid, timeUnit: Assignment["timeUnit"] = "none";
    if (field.sort === "descending") fail("倒序设置");
    if (field.expression) {
      if (field.expression.op !== "dateTimeDrill") fail("计算字段 / 日期提取");
      id = String(field.expression.params.find(param => param.type === "field")?.value ?? "");
      timeUnit = String(field.expression.params.find(param => param.type === "value")?.value ?? "") as Assignment["timeUnit"];
    } else if (field.computed || field.timeUnit) fail("计算字段或仅显示日期格式");
    const source = dataset.fields.find(item => item.id === id);
    if (!source) return fail("派生字段或记录数虚拟字段，请使用实际数值字段的计数");
    if (!field.expression && field.name !== source.name) fail("字段重命名");
    const expected = source.type === "number" ? "quantitative" : source.type === "date" ? "temporal" : "nominal";
    if (!field.expression && field.semanticType !== expected) fail("字段类型变更");
    return { field: id, aggregate: (source.type === "number" ? field.aggName ?? "sum" : "sum") as Assignment["aggregate"], timeUnit };
  }
  const filters: ChartFilter[] = enc.filters.flatMap(field => {
    if (!field.rule) return [];
    if (field.computed || field.expression || field.enableAgg) fail("派生字段 / 聚合后筛选");
    const rule = field.rule;
    if (rule.type === "one of") return [{ field: field.fid, kind: "oneOf", values: rule.value } as ChartFilter];
    if (rule.type === "range" || rule.type === "temporal range") return [{ field: field.fid,
      kind: rule.type === "range" ? "range" : "dateRange", min: rule.value[0] ?? null, max: rule.value[1] ?? null } as ChartFilter];
    return fail("排除 / 自定义筛选（可使用包含或范围筛选）");
  });
  return restoreConfig(JSON.stringify({ ...base, mark: chart.config.geoms[0],
    channels: { x: assignment(enc.columns.at(-1)!), y: assignment(enc.rows.at(-1)!),
      facetX: enc.columns.length === 2 ? assignment(enc.columns[0]) : null,
      facetY: enc.rows.length === 2 ? assignment(enc.rows[0]) : null,
      color: enc.color[0] ? assignment(enc.color[0]) : null, tooltip: enc.details.map(assignment) }, filters,
    style: { ...base.style, stack: chart.layout.stack, numberFormat: chart.layout.format.numberFormat ?? base.style.numberFormat },
  }), dataset);
}
