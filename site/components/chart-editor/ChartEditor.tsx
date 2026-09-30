"use client";

import { useEffect, useId, useReducer, useRef, useState } from "react";
import { Tabs } from "@radix-ui/themes";
import { Button } from "@/components/ui/button";
import { Checkbox, SelectField, SelectItem, TextInput } from "@/components/ui/fields";
import { assignField, channels, initialConfig, restoreConfig, type Assignment, type Channel, type ChartConfig, type ChartDataset } from "@/core/chart-editor/config";
import { ChartCanvas } from "./ChartCanvas";
import { FieldShelf, fieldDragType } from "./FieldShelf";
import { FilterPanel } from "./FilterPanel";
import { chartHistoryReducer, createChartHistory } from "@/core/chart-editor/history";
import "./chart-editor.css";

const marks = { area: "面积图", bar: "柱状图", line: "折线图", point: "散点图" } as const;
export interface ChartEditorProps {
  dataset: ChartDataset;
  onDirtyChange?(dirty: boolean): void;
  owner?: { config: ChartConfig; onSave(config: ChartConfig): void };
  allowedMarks?: readonly ChartConfig["mark"][];
  dataUnavailable?: string;
}
export default function ChartEditor({ dataset, onDirtyChange, owner, allowedMarks, dataUnavailable }: ChartEditorProps) {
  const storageKey = `datacanvas:chart-editor:v1:${dataset.id}`;
  const [initial] = useState(() => {
    if (owner) return { config: owner.config, saved: JSON.stringify(owner.config), error: "" };
    try { const saved = localStorage.getItem(storageKey); return { config: saved ? restoreConfig(saved, dataset) : initialConfig(dataset), saved: saved ?? "", error: "" }; }
    catch { return { config: initialConfig(dataset), saved: "", error: "上次配置无法读取，已显示默认图表；未覆盖已存配置。" }; }
  });
  const [history, dispatch] = useReducer(chartHistoryReducer, initial.config, createChartHistory);
  const config = history.present;
  const [saved, setSaved] = useState(initial.saved);
  // A missing/stale upstream error belongs to that dataset snapshot, not the
  // freshly loaded one. Preserve unsaved config while retiring obsolete errors.
  const [failure, setFailure] = useState({ message: initial.error, dataset });
  const error = failure.dataset === dataset ? failure.message : "";
  const setError = (message: string) => setFailure({ message, dataset });
  const [notice, setNotice] = useState(""), [search, setSearch] = useState(""), [target, setTarget] = useState<Channel>("x");
  const [libraryOpen, setLibraryOpen] = useState(true), libraryId = useId();
  const file = useRef<HTMLInputElement>(null);
  const dirty = JSON.stringify(config) !== (saved || JSON.stringify(initial.config));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  function update(next: ChartConfig) { dispatch({ type: "edit", config: next }); setError(""); setNotice(""); }
  function travel(type: "undo" | "redo") { dispatch({ type }); setError(""); setNotice(""); }
  function assign(channel: Channel, id: string) {
    if (!id) return;
    try { update(assignField(config, dataset, channel, id)); } catch (caught) { setError(caught instanceof Error ? caught.message : "字段无法添加。"); }
  }
  function setItems(channel: Channel, items: Assignment[]) {
    update({ ...config, channels: { ...config.channels, [channel]: channel === "tooltip" ? items : items[0] ?? null } });
  }
  function save() {
    try {
      const text = JSON.stringify(config);
      if (owner) owner.onSave(config); else localStorage.setItem(storageKey, text);
      setSaved(text); setNotice(owner ? "已提交到 Notebook；项目保存状态见工作区顶部。" : "配置已保存到此浏览器；不包含原始数据。"); setError("");
    } catch (caught) { setError(owner && caught instanceof Error ? caught.message : "浏览器存储不可用或空间不足。请导出配置文件保存。"); }
  }
  function restore() {
    try { const text = owner ? JSON.stringify(owner.config) : localStorage.getItem(storageKey); if (!text) throw Error("尚无已保存配置。"); update(restoreConfig(text, dataset)); setSaved(text); setNotice("已恢复上次保存的配置。"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "恢复失败；原配置未改动。"); }
  }
  function exportConfig() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(config, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "chart-config.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function importConfig(upload?: File) {
    if (!upload) return;
    try { if (upload.size > 250_000) throw Error("配置文件过大。"); const next = restoreConfig(await upload.text(), dataset); if (allowedMarks && !allowedMarks.includes(next.mark)) throw Error("当前入口暂不支持此图表类型。"); update(next); setNotice(owner ? "配置已导入，尚未保存到 Notebook。" : "配置已导入，尚未保存到浏览器。"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "配置导入失败，原配置未改动。"); }
  }
  const style = (patch: Partial<ChartConfig["style"]>) => update({ ...config, style: { ...config.style, ...patch } });
  return <div className="gw-editor">
    <header className="gw-toolbar"><div><b>图表编辑器</b><span>{dataset.name}</span></div><div>
      <Button size="small" className="gw-library-toggle" aria-label={libraryOpen ? "收起字段库" : "展开字段库"} aria-expanded={libraryOpen} aria-controls={libraryId} onClick={() => setLibraryOpen(open => !open)}>{libraryOpen ? "收起字段库" : "展开字段库"}</Button>
      <Button size="small" disabled={!history.past.length} onClick={() => travel("undo")}>撤销</Button><Button size="small" disabled={!history.future.length} onClick={() => travel("redo")}>重做</Button>
      <small>{dirty || !saved ? "尚未保存" : "已保存"}</small><Button size="small" onClick={() => file.current?.click()}>导入配置</Button><Button size="small" onClick={exportConfig}>导出配置</Button>
      <Button size="small" disabled={!saved} onClick={restore}>恢复已保存</Button><Button size="small" variant="primary" onClick={save}>{owner ? "保存单元" : "保存配置"}</Button>
      <input ref={file} type="file" accept="application/json,.json" aria-label="导入图表配置文件" hidden onChange={event => { void importConfig(event.target.files?.[0]); event.target.value = ""; }} />
    </div></header>
    {(error || notice) && <div className={`gw-notice ${error ? "gw-error" : ""}`} role={error ? "alert" : "status"}>{error || notice}</div>}
    <div className="gw-body" data-library={libraryOpen ? "expanded" : "collapsed"}>
      <aside id={libraryId} hidden={!libraryOpen} className="gw-library" aria-label="数据字段库"><section className="gw-field-list"><h3>Data <small>{dataset.fields.length} 个字段</small></h3>
        <TextInput size="2" aria-label="搜索字段" placeholder="搜索字段…" value={search} onChange={event => setSearch(event.target.value)} />
        {([['number', '度量 · Measures'], ['dimension', '维度 · Dimensions']] as const).map(([type, label]) => <div key={type} className="gw-field-group"><h4>{label}</h4><div className="gw-field-options">{dataset.fields.filter(f => (type === 'number' ? f.type === 'number' : f.type !== 'number') && `${f.name} ${f.id}`.toLowerCase().includes(search.toLowerCase())).map(f => <button key={f.id} type="button" draggable className="gw-available-field" onDragStart={event => { event.dataTransfer.effectAllowed = "copy"; event.dataTransfer.setData(fieldDragType, f.id); }} onClick={() => assign(target, f.id)} aria-label={`添加字段 ${f.name}`}><span>{f.type === "number" ? "#" : f.type === "date" ? "◷" : "Aa"}</span>{f.name}<small>＋</small></button>)}</div></div>)}
        {!dataset.fields.some(f => `${f.name} ${f.id}`.toLowerCase().includes(search.toLowerCase())) && <p className="gw-hint">没有匹配字段。</p>}
        <div className="gw-target"><small>点击字段添加到</small><SelectField aria-label="字段添加目标" value={target} onValueChange={channel => { if (channel in channels) setTarget(channel as Channel); }}>{Object.entries(channels).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectField></div>
        <p className="gw-hint">拖入右侧配置区，或选择目标后点击字段。</p>
      </section></aside>
      <aside className="gw-controls" aria-label="图表配置面板"><Tabs.Root defaultValue="data">
      <Tabs.List><Tabs.Trigger value="data">Data · 数据</Tabs.Trigger><Tabs.Trigger value="style">Style · 样式</Tabs.Trigger></Tabs.List>
      <Tabs.Content value="data" className="gw-tab-content">
        <label className="gw-control">图表类型<SelectField aria-label="图表类型" value={config.mark} onValueChange={mark => { if (mark in marks) update({ ...config, mark: mark as ChartConfig["mark"] }); }}>{Object.entries(marks).filter(([key]) => !allowedMarks || allowedMarks.includes(key as ChartConfig["mark"])).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectField></label>
        {(Object.keys(channels) as Channel[]).map(channel => {
          const value = config.channels[channel], items = Array.isArray(value) ? value : value ? [value] : [];
          return <FieldShelf key={channel} channel={channel} dataset={dataset} items={items} onAdd={id => assign(channel, id)} onError={setError}
            onRemove={index => setItems(channel, items.filter((_, i) => i !== index))} onChange={(index, next) => setItems(channel, items.map((item, i) => i === index ? next : item))}
            onMove={(from, to) => { if (to < 0 || to >= items.length || from < 0 || from >= items.length) return; const next = [...items]; next.splice(to, 0, ...next.splice(from, 1)); setItems(channel, next); }} />;
        })}
        <FilterPanel dataset={dataset} filters={config.filters} onChange={filters => update({ ...config, filters })} />
      </Tabs.Content>
      <Tabs.Content value="style" className="gw-tab-content">
        <label className="gw-control">标题<TextInput aria-label="图表标题" value={config.title} maxLength={160} onChange={e => update({ ...config, title: e.target.value })} /></label>
        <label className="gw-checkbox"><Checkbox checked={config.style.showTitle} onCheckedChange={showTitle => style({ showTitle })} />显示标题</label>
        <label className="gw-control">配色<SelectField aria-label="配色" value={config.style.palette} onValueChange={palette => { if (palette === "muted" || palette === "blue" || palette === "warm") style({ palette }); }}><SelectItem value="muted">柔和 · 紫绿</SelectItem><SelectItem value="blue">湖蓝</SelectItem><SelectItem value="warm">暖橙</SelectItem></SelectField></label>
        <label className="gw-control">字体<SelectField aria-label="字体" value={config.style.font} onValueChange={font => { if (font === "sans" || font === "serif") style({ font }); }}><SelectItem value="sans">无衬线</SelectItem><SelectItem value="serif">衬线</SelectItem></SelectField></label>
        <label className="gw-control">字号<SelectField aria-label="字号" value={String(config.style.fontSize)} onValueChange={fontSize => style({ fontSize: Number(fontSize) })}>{[10, 12, 14, 16, 18, 20].map(size => <SelectItem key={size} value={String(size)}>{size} px</SelectItem>)}</SelectField></label>
        <label className="gw-control">数值格式<SelectField aria-label="数值格式" value={config.style.numberFormat} onValueChange={numberFormat => { if (numberFormat === ",.0f" || numberFormat === ",.2f" || numberFormat === ".1%") style({ numberFormat }); }}><SelectItem value=",.0f">千分位 · 整数</SelectItem><SelectItem value=",.2f">千分位 · 两位小数</SelectItem><SelectItem value=".1%">百分比（原值 × 100）</SelectItem></SelectField></label>
        {(config.mark === "area" || config.mark === "bar") && <label className="gw-control">堆叠方式<SelectField aria-label="堆叠方式" value={config.style.stack} onValueChange={stack => { if (stack === "stack" || stack === "normalize" || stack === "none") style({ stack }); }}><SelectItem value="stack">堆叠</SelectItem><SelectItem value="normalize">百分比堆叠</SelectItem><SelectItem value="none">不堆叠</SelectItem></SelectField></label>}
        <div className="gw-style-toggles">{([['axes', '显示坐标轴'], ['legend', '显示图例'], ['grid', '显示网格线']] as const).map(([key, label]) => <label className="gw-checkbox" key={key}><Checkbox checked={config.style[key]} onCheckedChange={checked => style({ [key]: checked })} />{label}</label>)}</div>
        {config.style.legend && <label className="gw-control">图例位置<SelectField aria-label="图例位置" value={config.style.legendPosition} onValueChange={legendPosition => { if (legendPosition === "right" || legendPosition === "bottom" || legendPosition === "top") style({ legendPosition }); }}><SelectItem value="right">右侧</SelectItem><SelectItem value="bottom">底部</SelectItem><SelectItem value="top">顶部</SelectItem></SelectField></label>}
        <p className="gw-hint">样式只影响当前图表。切换标签页会保留设置。</p>
      </Tabs.Content>
    </Tabs.Root></aside><ChartCanvas dataset={dataset} config={config} unavailableReason={dataUnavailable} incompleteHint={owner ? "支持的配置保存并运行后使用完整上游" : undefined} /></div>
  </div>;
}
