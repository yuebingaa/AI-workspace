"use client";

import { Component, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { PureRenderer, getComputation, normalize, type IDataQueryPayload, type IRow } from "@kanaries/graphic-walker";
import { aggregations, graphicSpec, graphicTheme, metadata, restoreConfig, type ChartConfig, type ChartDataset } from "@/core/chart-editor/config";
import { ChartImageExport } from "./ChartImageExport";

class RenderGuard extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <p role="alert" className="gw-notice">图表无法显示。请检查字段组合，或恢复上次保存的配置。</p> : this.props.children; }
}

export function ChartCanvas({ config, dataset, incompleteHint, unavailableReason }: { config: ChartConfig; dataset: ChartDataset; incompleteHint?: string; unavailableReason?: string }) {
  const host = useRef<HTMLDivElement>(null);
  const renderer = useRef<ComponentRef<typeof PureRenderer>>(null);
  const [size, setSize] = useState({ width: 650, height: 430 });
  const [output, setOutput] = useState<{ query: string; rows: IRow[]; error?: string } | null>(null);
  const version = useMemo(() => JSON.stringify(graphicSpec(config, dataset)), [config, dataset]);
  const chart = useMemo(() => {
    try { restoreConfig(JSON.stringify(config), dataset); return normalize(graphicSpec(config, dataset), metadata(dataset)); }
    catch { return null; }
  }, [config, dataset]);
  const currentQuery = useRef(version);
  useEffect(() => { currentQuery.current = version; }, [version]);
  const computation = useMemo(() => {
    const compute = getComputation(dataset.rows);
    return async (payload: IDataQueryPayload) => {
      try { const rows = await compute(payload); if (currentQuery.current === version) setOutput({ query: version, rows }); return rows; }
      catch { if (currentQuery.current === version) setOutput({ query: version, rows: [], error: "数据计算失败，请检查日期格式、字段类型或筛选条件。" }); throw Error("图表数据计算失败"); }
    };
  }, [dataset, version]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.max(240, Math.floor(entry.contentRect.width - 70)), height: Math.max(260, Math.floor(entry.contentRect.height - 90)) });
    });
    observer.observe(host.current); return () => observer.disconnect();
  }, []);
  const active = output?.query === version ? output : null;
  const facetCount = (field?: string) => field ? new Set((active?.rows ?? dataset.rows).map(row => row[field])).size : 1;
  const columnCount = Math.max(1, facetCount(config.channels.facetX?.field)), rowCount = Math.max(1, facetCount(config.channels.facetY?.field));
  const faceted = Boolean(config.channels.facetX || config.channels.facetY);
  const theme = useMemo(() => {
    const base = graphicTheme(config);
    if (!faceted) return base;
    // Upstream fixed-size facets don't reserve header/legend space. Auto facets plus public Vega view sizes avoid clipping.
    const legendSpace = config.style.legend && config.style.legendPosition === "right" ? 200 : 90;
    const width = Math.max(200, Math.floor((size.width - legendSpace) / columnCount)), height = Math.max(200, Math.floor((size.height - 160) / rowCount));
    const view = { stroke: null, continuousWidth: width, discreteWidth: width, continuousHeight: height, discreteHeight: height };
    return { light: { ...base.light, view }, dark: { ...base.dark, view } };
  }, [config, faceted, size, columnCount, rowCount]);
  const ready = Boolean(config.channels.x && config.channels.y);
  const state = unavailableReason ? "waiting" : !ready ? "empty" : !chart || active?.error ? "error" : !active ? "loading" : active.rows.length ? "ready" : "no-results";
  // Fresh configuration/theme instances cannot export the preceding chart while Vega catches up.
  // Ordinary resizing stays with the renderer's public overrideSize API, avoiding unnecessary recomputation.
  const renderRevision = JSON.stringify([version, theme]);
  const chartFields = [...(chart?.encodings.dimensions ?? []), ...(chart?.encodings.measures ?? []), ...(chart?.encodings.rows ?? []), ...(chart?.encodings.columns ?? []), ...(chart?.encodings.details ?? [])];
  const names = new Map(chartFields.map(f => [f.fid, f.name]));
  for (const f of chartFields) if (f.aggName) names.set(`${f.fid}_${f.aggName}`, `${f.name} · ${aggregations[f.aggName as keyof typeof aggregations] ?? f.aggName}`);
  const fields = active?.rows[0] ? Object.keys(active.rows[0]) : [];
  const display = (value: unknown, fid: string) => {
    const field = chartFields.find(f => f.fid === fid);
    if (field?.semanticType === "temporal" && (typeof value === "number" || typeof value === "string")) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return field.timeUnit === "quarter" ? `${date.getUTCFullYear()} Q${Math.floor(date.getUTCMonth() / 3) + 1}` : date.toISOString().slice(0, 10);
    }
    return typeof value === "number" ? value.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) : value == null ? "—" : String(value);
  };
  return <section className="gw-canvas" aria-label="图表画布" data-state={state}>
    <header><div><span className="gw-eyebrow">图表预览 · Graphic Walker</span>{config.style.showTitle && <h2>{config.title || "未命名图表"}</h2>}</div>
      <ChartImageExport renderer={renderer} revision={renderRevision} enabled={state === "ready"} title={config.title} /></header>
    <div className="gw-plot" ref={host}>
      {unavailableReason ? <div className="gw-empty" role="status"><h3>等待上游数据</h3><p>{unavailableReason}</p></div>
        : !ready ? <div className="gw-empty"><span aria-hidden="true">▥</span><h3>用字段构建你的图表</h3><p>将字段拖入左侧 X 轴和 Y 轴，或点击选择。</p></div>
        : !chart ? <p role="alert">字段组合无效，请修改配置或恢复已保存的图表。</p> : <RenderGuard key={version}>
          {/* 0.5.2 snapshots vizThemeConfig on mount. Re-key on theme changes; config remains owned here. */}
          <PureRenderer key={renderRevision} ref={renderer} type="remote" computation={computation} visualState={chart.encodings} visualConfig={chart.config} visualLayout={chart.layout}
            name={config.title} appearance="light" locale="zh-CN" vizThemeConfig={theme} disableCollapse
            overrideSize={{ mode: faceted ? "auto" : "fixed", width: size.width, height: size.height }} />
          {state === "loading" && <div className="gw-plot-message" role="status">正在计算图表…</div>}
          {state === "error" && <div className="gw-plot-message" role="alert">{active?.error}</div>}
          {state === "no-results" && <div className="gw-plot-message" role="status">没有符合筛选条件的数据，请调整或移除筛选。</div>}
        </RenderGuard>}
    </div>
    <footer><span>{dataset.synthetic ? "模拟数据" : "当前已载入数据"} · {dataset.rows.length.toLocaleString("zh-CN")} 行参与计算{dataset.totalRows > dataset.rows.length ? ` / 数据源共 ${dataset.totalRows.toLocaleString("zh-CN")} 行（非全量）` : dataset.truncated ? `（非全量；${incompleteHint ?? "请先在 SQL 聚合后绘图"}）` : "（全量）"}</span><span>{active && ready && !active.error ? `${active.rows.length} 个聚合结果` : ""}</span></footer>
    {!unavailableReason && ready && active && !active.error && active.rows.length > 0 && <details className="gw-results"><summary>查看图表计算结果 <small>由 Graphic Walker 返回</small></summary><div><table aria-label="图表计算结果"><thead><tr>{fields.map(f => <th key={f}>{names.get(f) ?? f}</th>)}</tr></thead><tbody>{active.rows.slice(0, 100).map((row, index) => <tr key={index}>{fields.map(f => <td key={f}>{display(row[f], f)}</td>)}</tr>)}</tbody></table></div>{active.rows.length > 100 && <p>表格仅展示前 100 个结果；图表使用全部计算结果。</p>}</details>}
  </section>;
}
