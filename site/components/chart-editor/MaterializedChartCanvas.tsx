"use client";

import { Component, useEffect, useMemo, useRef, useState, type ComponentRef, type ReactNode } from "react";
import { PureRenderer, getComputation, type IDataQueryPayload } from "@kanaries/graphic-walker";
import { materializedGraphicWalker, assertMaterializedWorkflow } from "@/core/visualization/adapters/graphic-walker";
import { materializedFacetSize } from "@/core/visualization/adapters/facet-layout";
import type { ChartDefinitionV2 } from "@/core/visualization/definition";
import type { MaterializedVisualization } from "@/core/visualization/result";
import { graphicTheme, type ChartConfig } from "@/core/chart-editor/config";
import { ChartImageExport } from "./ChartImageExport";

class RenderGuard extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() { return { error: true }; }
  render() { return this.state.error ? <p role="alert">绘图失败；计算结果仍可在“图表数据”中查看。</p> : this.props.children; }
}

/** Only verified results enter here. GW projects values; SQL owns all business computation. */
export function MaterializedChartCanvas({ definition, result, styleConfig }: {
  definition: ChartDefinitionV2; result: MaterializedVisualization; styleConfig?: ChartConfig;
}) {
  const host = useRef<HTMLDivElement>(null), renderer = useRef<ComponentRef<typeof PureRenderer>>(null);
  const [size, setSize] = useState({ width: 650, height: 430 });
  const [output, setOutput] = useState<{ version: string; error?: string }>();
  const spec = useMemo(() => {
    try { return { value: materializedGraphicWalker(definition, result.table) }; }
    catch (error) { return { error: error instanceof Error ? error.message : "图表字段不支持绘图。" }; }
  }, [definition, result]);
  const theme = useMemo(() => {
    const base = styleConfig ? graphicTheme(styleConfig) : spec.value?.theme;
    if (!base) return undefined;
    const unit = definition.data.dimensions.find(field => field.as === definition.encoding.x)?.timeUnit;
    const labelExpr = unit === "quarter" ? "substring(datum.label,0,4) + ' Q' + ceil(toNumber(substring(datum.label,5,7))/3)"
      : unit === "year" ? "substring(datum.label,0,4)" : unit === "month" ? "substring(datum.label,0,7)" : undefined;
    const axisX = { labelAngle: 0, labelOverlap: true, ...(labelExpr ? { labelExpr } : {}) };
    const facetSize = spec.value?.grid.enabled ? materializedFacetSize(size, spec.value.grid) : undefined;
    const view = facetSize ? { stroke: null, continuousWidth: facetSize.width, discreteWidth: facetSize.width,
      continuousHeight: facetSize.height, discreteHeight: facetSize.height } : undefined;
    return { light: { ...base.light, axisX, ...(view ? { view } : {}) }, dark: { ...base.dark, axisX, ...(view ? { view } : {}) } };
  }, [definition, spec, styleConfig, size]);
  // Computation identity must not include responsive sizes/themes: a resize can
  // remount GW without new data, and a late older render must not leave loading stuck.
  const dataVersion = JSON.stringify([result.visualResult, definition.data, definition.encoding]);
  const version = JSON.stringify([dataVersion, definition, theme]);
  const currentData = useRef(dataVersion);
  useEffect(() => { currentData.current = dataVersion; }, [dataVersion]);
  const computation = useMemo(() => {
    const project = getComputation(result.table.rows);
    return async (payload: IDataQueryPayload) => {
      try { assertMaterializedWorkflow(payload); const rows = await project(payload);
        if (currentData.current === dataVersion) setOutput({ version: dataVersion }); return rows; }
      catch (error) { if (currentData.current === dataVersion) setOutput({ version: dataVersion, error: error instanceof Error ? error.message : "无法绘图" }); throw error; }
    };
  }, [result, dataVersion]);
  useEffect(() => {
    if (!host.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: Math.max(240, Math.floor(entry.contentRect.width - 100)),
      height: Math.max(260, Math.floor(entry.contentRect.height - 95)) }));
    observer.observe(host.current); return () => observer.disconnect();
  }, []);
  const active = output?.version === dataVersion ? output : undefined;
  const state = spec.error || active?.error ? "error" : !active ? "loading" : result.table.rows.length ? "ready" : "no-results";
  return <section className="gw-canvas gw-materialized-canvas" aria-label="完整结果图表" data-state={state}>
    <header><div><span className="gw-eyebrow">完整上游计算 · Graphic Walker 绘图</span>
      {styleConfig?.style.showTitle !== false && <h2>{definition.presentation.title}</h2>}</div>
      <ChartImageExport renderer={renderer} revision={version} enabled={state === "ready"} title={definition.presentation.title} /></header>
    <div className="gw-plot" ref={host}>
      {spec.error ? <p role="alert">{spec.error}</p> : spec.value && <RenderGuard key={version}>
        <PureRenderer key={version} ref={renderer} type="remote" computation={computation} visualState={spec.value.chart.encodings}
          visualConfig={spec.value.chart.config} visualLayout={spec.value.chart.layout} scales={spec.value.scales}
          name={definition.presentation.title} appearance="light" locale="zh-CN" vizThemeConfig={theme} disableCollapse
          overrideSize={{ mode: spec.value.grid.enabled ? "auto" : "fixed", ...size }} />
        {state === "loading" && <p className="gw-plot-message" role="status">正在绘制已计算结果…</p>}
        {state === "error" && <p className="gw-plot-message" role="alert">{active?.error}</p>}
        {state === "no-results" && <p className="gw-plot-message" role="status">没有符合条件的数据，请调整筛选。</p>}
      </RenderGuard>}
    </div>
    <footer><span>完整上游 {result.visualResult.inputRowCount.toLocaleString("zh-CN")} 行 → 图表结果 {result.visualResult.outputRowCount.toLocaleString("zh-CN")} 行</span>
      <span>{spec.value?.grid.enabled && `分面 ${spec.value.grid.columns} 列 × ${spec.value.grid.rows} 行 · 可在图内滚动 · `}
        {definition.data.mode === "rows" ? "保留原始行 · 未聚合" : "服务端聚合 · 不再次聚合"}</span></footer>
  </section>;
}
