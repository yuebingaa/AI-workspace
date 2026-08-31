"use client";

import { useMemo, useState } from "react";
import { analyzeDataSourceFields, createDataPreview } from "@/core/data";
import type { DataRow, DataSourceDefinition, QueryExecutionRecord } from "@/core/models";

type DataSourceTab = "overview" | "fields" | "preview" | "executions";

const tabs: Array<{ id: DataSourceTab; label: string }> = [
  { id: "overview", label: "概览" },
  { id: "fields", label: "字段" },
  { id: "preview", label: "数据预览" },
  { id: "executions", label: "执行记录" },
];

const typeLabels = { string: "文本", number: "数值", date: "日期", boolean: "布尔值" } as const;
const sourceTypeLabels = { csv: "CSV 文件", json: "JSON 文件", "local-fixture": "本地 Fixture" } as const;

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  return String(value);
}

interface DataSourceDetailsPanelProps {
  source: DataSourceDefinition;
  rows: DataRow[];
  queryRecords: QueryExecutionRecord[];
  onClose: () => void;
}

export function DataSourceDetailsPanel({ source, rows, queryRecords, onClose }: DataSourceDetailsPanelProps) {
  const [tab, setTab] = useState<DataSourceTab>("overview");
  const [visibleFields, setVisibleFields] = useState(() => source.fields.map((field) => field.name));
  const analyses = useMemo(() => analyzeDataSourceFields(source, rows), [rows, source]);
  const preview = useMemo(() => createDataPreview(source, rows, visibleFields, 20), [rows, source, visibleFields]);
  const records = queryRecords.filter((record) => record.dataSourceId === source.id);

  function toggleField(field: string) {
    setVisibleFields((current) => current.includes(field)
      ? (current.length > 1 ? current.filter((item) => item !== field) : current)
      : [...current, field]);
  }

  return (
    <div className="data-source-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="data-source-panel" role="dialog" aria-modal="true" aria-label={`${source.name} 数据源详情`}>
        <header className="data-source-panel-head">
          <div><span className="db">⌘</span><div><small>数据源工作区</small><h2>{source.name}</h2></div></div>
          <button type="button" aria-label="关闭数据源详情" onClick={onClose}>×</button>
        </header>
        <nav className="data-source-tabs" aria-label="数据源详情标签">
          {tabs.map((item) => <button key={item.id} type="button" className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>{item.label}{item.id === "executions" && <span>{records.length}</span>}</button>)}
        </nav>
        <div className="data-source-panel-body">
          {tab === "overview" && (
            <div className="source-overview-grid">
              <article><span>数据源名称</span><b>{source.name}</b><small>{source.id}</small></article>
              <article><span>数据规模</span><b>{source.rowCount.toLocaleString("zh-CN")} 行</b><small>{source.columnCount} 个字段</small></article>
              <article><span>更新时间</span><b>{new Date(source.updatedAt).toLocaleString("zh-CN")}</b><small>Fixture 固定时间</small></article>
              <article><span>数据质量</span><b>{source.qualityScore}%</b><small>通过本地结构校验</small></article>
              <article><span>数据类型</span><b>{sourceTypeLabels[source.sourceType]}</b><small>阶段 A 本地数据</small></article>
            </div>
          )}
          {tab === "fields" && (
            <div className="source-table-scroll"><table className="source-fields-table">
              <thead><tr><th>字段 / 中文标签</th><th>类型</th><th>空值</th><th>唯一值</th><th>数值统计</th><th>示例值</th></tr></thead>
              <tbody>{analyses.map((analysis) => (
                <tr key={analysis.field}>
                  <td><b>{analysis.field}</b><small>{analysis.label}</small></td>
                  <td><span className={`field-type ${analysis.type}`}>{typeLabels[analysis.type]}</span></td>
                  <td>{analysis.nullCount}<small>{(analysis.nullRatio * 100).toFixed(1)}%</small></td>
                  <td>{analysis.uniqueCount}</td>
                  <td>{analysis.minimum === undefined ? "—" : <><span>最小 {displayValue(analysis.minimum)}</span><span>最大 {displayValue(analysis.maximum)}</span><span>平均 {displayValue(analysis.average)}</span></>}</td>
                  <td>{analysis.samples.map(displayValue).join("、") || "—"}</td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
          {tab === "preview" && (
            <div className="source-preview-layout">
              <aside><b>显示字段</b><button type="button" onClick={() => setVisibleFields(source.fields.map((field) => field.name))}>全部显示</button>{source.fields.map((field) => (
                <label key={field.name}><input type="checkbox" checked={visibleFields.includes(field.name)} onChange={() => toggleField(field.name)} />{field.label}<small>{field.name}</small></label>
              ))}</aside>
              <div className="source-table-scroll"><div className="preview-caption">前 {preview.rows.length} 行 · 显示 {preview.fields.length}/{source.fields.length} 个字段</div><table>
                <thead><tr>{preview.fields.map((field) => <th key={field}>{source.fields.find((item) => item.name === field)?.label ?? field}<small>{field}</small></th>)}</tr></thead>
                <tbody>{preview.rows.map((row, index) => <tr key={index}>{preview.fields.map((field) => <td key={field}>{displayValue(row[field])}</td>)}</tr>)}</tbody>
              </table></div>
            </div>
          )}
          {tab === "executions" && (
            <div className="query-record-list">
              {!records.length && <div className="empty-records">画布完成数据绑定计算后，执行记录会显示在这里。</div>}
              {records.map((record) => (
                <article key={record.id} className={record.status}>
                  <div><b>{record.componentId}</b><span>{record.status === "success" ? "成功" : "失败"}</span></div>
                  <p>{record.bindingSummary}</p><small>{record.planSummary}</small>
                  <dl><div><dt>执行编号</dt><dd>{record.id}</dd></div><div><dt>页面</dt><dd>{record.pageId}</dd></div><div><dt>输入 / 输出</dt><dd>{record.inputRowCount} / {record.outputRowCount}</dd></div><div><dt>耗时</dt><dd>{record.durationMs} ms</dd></div><div><dt>开始</dt><dd>{new Date(record.startedAt).toLocaleString("zh-CN")}</dd></div><div><dt>完成</dt><dd>{new Date(record.completedAt).toLocaleString("zh-CN")}</dd></div></dl>
                  {record.error && <div className="query-error">{record.error}</div>}
                </article>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
