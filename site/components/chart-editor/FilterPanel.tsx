"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SelectField, SelectItem, TextInput } from "@/components/ui/fields";
import type { ChartDataset, ChartFilter } from "@/core/chart-editor/config";

export function FilterPanel({ dataset, filters, onChange }: { dataset: ChartDataset; filters: ChartFilter[]; onChange(filters: ChartFilter[]): void }) {
  const [fieldId, setFieldId] = useState(""), [low, setLow] = useState(""), [high, setHigh] = useState(""), [selected, setSelected] = useState(""), [error, setError] = useState("");
  const field = dataset.fields.find(f => f.id === fieldId);
  const values = field ? Array.from(new Set(dataset.rows.map(row => row[field.id]))).slice(0, 1000) : [];
  const range = field?.type === "number" || field?.type === "date";
  function add() {
    if (!field) return;
    if (range) {
      const parse = (value: string) => value === "" ? null : field?.type === "date" ? Date.parse(`${value}T00:00:00Z`) : Number(value);
      const min = parse(low), upper = parse(high), max = upper !== null && field.type === "date" ? upper + 86_400_000 - 1 : upper;
      if ((min !== null && !Number.isFinite(min)) || (max !== null && !Number.isFinite(max)) || (min !== null && max !== null && min > max)) { setError("请输入有效范围，下限不能大于上限。"); return; }
      if (min === null && max === null) { setError("至少填写一个范围边界。"); return; }
      onChange([...filters, { field: field.id, kind: field.type === "date" ? "dateRange" : "range", min, max }]);
    } else {
      if (selected === "") { setError("请选择筛选值。"); return; }
      onChange([...filters, { field: field.id, kind: "oneOf", values: [values[Number(selected)]] }]);
    }
    setError(""); setLow(""); setHigh(""); setSelected("");
  }
  return <section className="gw-shelf"><h3>筛选条件 <span>同时满足</span></h3>
    {filters.map((f, index) => <div className="gw-filter-chip" key={index}><span><b>{dataset.fields.find(field => field.id === f.field)?.name}</b><small>{f.kind === "oneOf" ? f.values.map(v => v === null ? "空值" : String(v)).join("、") : [f.min, f.max].map(v => v === null ? "不限" : f.kind === "dateRange" ? new Date(v).toISOString().slice(0, 10) : v).join(" ～ ")}</small></span><button type="button" aria-label={`移除筛选 ${index + 1}`} onClick={() => onChange(filters.filter((_, i) => i !== index))}>×</button></div>)}
    <SelectField aria-label="筛选字段" value={fieldId} onValueChange={value => { setFieldId(value); setLow(""); setHigh(""); setSelected(""); setError(""); }}><SelectItem value="">选择筛选字段…</SelectItem>{dataset.fields.map(f => <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>)}</SelectField>
    {field && <>{range ? <div className="gw-range"><TextInput aria-label="筛选下限" type={field.type === "date" ? "date" : "number"} value={low} placeholder="下限" onChange={e => setLow(e.target.value)} /><TextInput aria-label="筛选上限" type={field.type === "date" ? "date" : "number"} value={high} placeholder="上限" onChange={e => setHigh(e.target.value)} /></div>
      : <SelectField aria-label="筛选值" value={selected} onValueChange={setSelected}><SelectItem value="">选择一个值…</SelectItem>{values.map((value, index) => <SelectItem key={index} value={String(index)}>{value == null ? "空值" : String(value)}</SelectItem>)}</SelectField>}
      <Button type="button" size="small" onClick={add}>添加筛选</Button></>}
    {error && <small role="alert">{error}</small>}
  </section>;
}
