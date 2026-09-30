"use client";

import { SelectField, SelectItem } from "@/components/ui/fields";
import { aggregations, canAssign, channels, dateUnits, type Assignment, type Channel, type ChartDataset } from "@/core/chart-editor/config";

export const fieldDragType = "application/x-datacanvas-chart-field";
export function FieldShelf({ channel, dataset, items, onAdd, onRemove, onChange, onMove, onError }: {
  channel: Channel; dataset: ChartDataset; items: Assignment[];
  onAdd(id: string): void; onRemove(index: number): void; onChange(index: number, assignment: Assignment): void; onMove(from: number, to: number): void; onError(message: string): void;
}) {
  const options = dataset.fields.filter(f => canAssign(channel, f));
  return <section className="gw-shelf" aria-label={channels[channel]} onDragOver={e => { if (e.dataTransfer.types.includes(fieldDragType)) e.preventDefault(); }} onDrop={event => {
    event.preventDefault(); const id = event.dataTransfer.getData(fieldDragType);
    if (dataset.fields.some(f => f.id === id)) onAdd(id); else onError("请拖入当前数据源中的字段。");
  }}>
    <h3>{channels[channel]}<span>{channel === "y" ? "数值" : channel.includes("facet") ? "分类" : ""}</span></h3>
    <div className="gw-chips">{items.map((item, index) => {
      const field = dataset.fields.find(f => f.id === item.field);
      return <div className="gw-field-chip" key={`${item.field}-${index}`} draggable onDragStart={event => {
        event.dataTransfer.setData(fieldDragType, item.field); event.dataTransfer.setData("application/x-chart-shelf", JSON.stringify({ channel, index }));
      }} onDragOver={e => e.preventDefault()} onDrop={event => {
        const data = event.dataTransfer.getData("application/x-chart-shelf"); if (!data || channel !== "tooltip") return;
        try { const from: unknown = JSON.parse(data); if (typeof from === "object" && from && "channel" in from && from.channel === channel && "index" in from && typeof from.index === "number") { event.stopPropagation(); event.preventDefault(); onMove(from.index, index); } } catch { onError("无法移动字段，请使用上下移动按钮。"); }
      }}>
        <div className="gw-chip-title"><span aria-hidden="true">{field?.type === "number" ? "#" : field?.type === "date" ? "◷" : "Aa"}</span><b>{field?.name}</b>
          {channel === "tooltip" && <><button type="button" aria-label={`上移 ${field?.name}`} disabled={index === 0} onClick={() => onMove(index, index - 1)}>↑</button><button type="button" aria-label={`下移 ${field?.name}`} disabled={index === items.length - 1} onClick={() => onMove(index, index + 1)}>↓</button></>}
          <button type="button" aria-label={`移除 ${channels[channel]} ${field?.name}`} onClick={() => onRemove(index)}>×</button></div>
        {field?.type === "number" && <SelectField aria-label={`${channels[channel]} ${field.name} 聚合`} value={item.aggregate} onValueChange={aggregate => { if (aggregate in aggregations) onChange(index, { ...item, aggregate: aggregate as Assignment["aggregate"] }); }}>{Object.entries(aggregations).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectField>}
        {field?.type === "date" && <SelectField aria-label={`${channels[channel]} ${field.name} 日期粒度`} value={item.timeUnit} onValueChange={timeUnit => { if (timeUnit in dateUnits) onChange(index, { ...item, timeUnit: timeUnit as Assignment["timeUnit"] }); }}>{Object.entries(dateUnits).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectField>}
      </div>;
    })}</div>
    <SelectField aria-label={`选择${channels[channel]}字段`} value="" disabled={!options.length} placeholder={items.length && channel !== "tooltip" ? "更换字段…" : "＋ 选择或拖入字段"} onValueChange={onAdd}>
      <SelectItem value="">{items.length && channel !== "tooltip" ? "更换字段…" : "＋ 选择或拖入字段"}</SelectItem>{options.map(f => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}
    </SelectField>
    {!options.length && <small>当前没有可用的{channel === "y" ? "数值" : "分类"}字段。</small>}
    {channel === "tooltip" && <small>轴和颜色字段自动显示。添加分类字段会细分聚合粒度。</small>}
  </section>;
}
