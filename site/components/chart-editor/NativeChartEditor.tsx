"use client";

import { useEffect, useMemo, useState } from "react";
import { GraphicWalker, type VizSpecStore } from "@kanaries/graphic-walker";
import { nativeChart, configFromNative, observeNativeChart } from "@/core/chart-editor/native-adapter";
import { graphicTheme, metadata, type ChartConfig, type ChartDataset } from "@/core/chart-editor/config";
import { Button } from "@/components/ui/button";
import { Checkbox, SelectField, SelectItem, TextInput } from "@/components/ui/fields";
import "./native-chart-editor.css";

export interface NativeChartEditorProps {
  dataset: ChartDataset; config: ChartConfig;
  onSave(config: ChartConfig): void; onDirtyChange(dirty: boolean): void;
}
const toolbar = { exclude: ["aggregation", "autoviz", "transpose", "sort:asc", "sort:dec", "table:summary", "axes_resize", "scale", "coord_system", "geojson", "debug", "config", "limit_axis", "painter", "kanaries"] };
export default function NativeChartEditor({ dataset, config, onSave, onDirtyChange }: NativeChartEditorProps) {
  const [store, setStore] = useState<VizSpecStore | null>(null);
  // The official ShadowDom mounts its store after the host effect. Observe ref
  // attachment explicitly; a one-shot parent effect can miss it altogether.
  const storeRef = useMemo(() => {
    let current: VizSpecStore | null = null;
    return { get current() { return current; }, set current(value: VizSpecStore | null) { current = value; setStore(value); } };
  }, []);
  const initial = useMemo(() => [nativeChart(config, dataset)], [config, dataset]);
  const fields = useMemo(() => metadata(dataset), [dataset]);
  const [title, setTitle] = useState(config.title);
  const [style, setStyle] = useState(config.style);
  const theme = useMemo(() => graphicTheme({ ...config, style }), [config, style]);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const presentationDirty = title !== config.title || JSON.stringify(style) !== JSON.stringify(config.style);
  useEffect(() => { onDirtyChange(dirty || presentationDirty); }, [dirty, presentationDirty, onDirtyChange]);
  useEffect(() => {
    // Public storeRef owns the official undo timeline. No DOM scraping or polling.
    const value = store;
    if (!value) return;
    value.setShowAutoVizPanel(false);
    const before = JSON.stringify(value.exportCode()[0]);
    return observeNativeChart(value, chart => {
      const after = JSON.stringify(chart);
      const changed = before !== after; setDirty(changed);
      try { configFromNative(chart, config, dataset); setError(""); }
      catch (cause) { setError(cause instanceof Error ? cause.message : "图表配置暂不能保存。"); }
    });
  }, [config, dataset, store]);
  function save() {
    try {
      if (!store) throw Error("编辑器尚未就绪。");
      const next = configFromNative(store.exportCode()[0], config, dataset);
      onSave({ ...next, title, style: { ...style, stack: next.style.stack, numberFormat: next.style.numberFormat } });
    } catch (cause) { setError(cause instanceof Error ? cause.message : "保存失败。"); }
  }
  return <section className="native-chart-editor" aria-label="Graphic Walker 官方编辑器">
    <header><div><strong>Graphic Walker</strong><span>官方编辑器 · {dirty || presentationDirty ? "未保存" : "已载入当前配置"}</span></div>
      <Button onClick={save}>保存单元</Button></header>
    <p className="native-chart-hint">拖动字段到列（X）、行（Y）或颜色；先放分面维度，再放坐标字段。预览仅含已返回的 {dataset.rows.length} 行，支持的配置保存并运行后使用完整上游。</p>
    {error && <p role="alert" className="native-chart-error">{error}</p>}
    <details className="native-chart-presentation"><summary>标题与网站样式</summary><div>
      <p className="native-chart-style-note">样式保存后在正式图表生效；当前官方编辑预览可能保留打开时的主题。</p>
      <label>标题<TextInput aria-label="图表标题" value={title} maxLength={120} onChange={event => setTitle(event.target.value)} /></label>
      <label>配色<SelectField aria-label="图表配色" value={style.palette} onValueChange={palette => setStyle({ ...style, palette: palette as ChartConfig["style"]["palette"] })}>
        <SelectItem value="muted">柔和</SelectItem><SelectItem value="blue">湖蓝</SelectItem><SelectItem value="warm">暖橙</SelectItem></SelectField></label>
      <label>字体<SelectField aria-label="图表字体" value={style.font} onValueChange={font => setStyle({ ...style, font: font as ChartConfig["style"]["font"] })}>
        <SelectItem value="sans">无衬线</SelectItem><SelectItem value="serif">衬线</SelectItem></SelectField></label>
      <label>字号<SelectField aria-label="图表字号" value={String(style.fontSize)} onValueChange={fontSize => setStyle({ ...style, fontSize: Number(fontSize) })}>
        {[10, 12, 14, 16, 18, 20].map(size => <SelectItem key={size} value={String(size)}>{size} px</SelectItem>)}</SelectField></label>
      <label>图例位置<SelectField aria-label="图例位置" value={style.legendPosition} onValueChange={legendPosition => setStyle({ ...style, legendPosition: legendPosition as ChartConfig["style"]["legendPosition"] })}>
        <SelectItem value="right">右侧</SelectItem><SelectItem value="top">上方</SelectItem><SelectItem value="bottom">下方</SelectItem></SelectField></label>
      {([['axes', '坐标轴'], ['legend', '图例'], ['grid', '网格线'], ['showTitle', '显示标题']] as const).map(([key, label]) =>
        <label key={key}><Checkbox aria-label={label} checked={style[key]} onCheckedChange={value => setStyle({ ...style, [key]: value })} />{label}</label>)}
    </div></details>
    <div className="native-chart-surface"><GraphicWalker data={dataset.rows} fields={fields} chart={initial}
      storeRef={storeRef} keepAlive={false} appearance="light" i18nLang="zh-CN" vizThemeConfig={theme}
      hideChartNav hideSegmentNav hideProfiling toolbar={toolbar} experimentalFeatures={{ computedField: false }}
      onError={cause => setError(cause.message)} /></div>
    <details className="native-chart-hint"><summary>当前保存范围</summary>
      单指标柱 / 线 / 面积，分组、日期分桶、包含 / 范围筛选和双向分面。现有配色、字体等样式保留。
      信息（Tooltip）里的聚合独立于 Y 轴；额外指标或不同聚合会走兼容预览，结果区会说明范围。
      暂不支持的官方操作会明确提示，不能无损保存时不会覆盖原图；可用官方撤销恢复。
    </details>
  </section>;
}
