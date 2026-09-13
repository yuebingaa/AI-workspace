"use client";

import { useState } from "react";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { HarnessNotebookCell } from "@/core/harness/notebook-contracts";
import type { NotebookTable } from "@/core/notebook/contracts";

const colors = ["#167b60", "#7b6cba", "#cf8c40", "#348aa6"];
export function NotebookResult({ cell, table }: { cell: HarnessNotebookCell; table: NotebookTable }) {
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(table.rows.length / 20));
  const currentPage = Math.min(page, pageCount - 1);
  const chartRows = table.rows.slice(0, 100);
  const radial = cell.kind === "chart" && (cell.chartType === "pie" || cell.chartType === "donut");
  const negativePie = radial && cell.valueFields.some((field) => chartRows.some((row) => typeof row[field] === "number" && row[field] < 0));
  const plot = cell.kind === "chart" && chartRows.length > 0 && !negativePie ? (() => {
    const shared = <><CartesianGrid stroke="#eaf0ec" vertical={false} /><XAxis dataKey={cell.categoryField} tick={{ fontSize: 11 }} minTickGap={16} /><YAxis tick={{ fontSize: 11 }} width={58} /><Tooltip /><Legend /></>;
    if (radial) return <div className="notebook-pies">{cell.valueFields.map((field, index) => <div key={field}><b>{field}</b><ResponsiveContainer width="100%" height={240} minWidth={0}><PieChart><Tooltip /><Legend /><Pie data={chartRows} dataKey={field} nameKey={cell.categoryField} innerRadius={cell.chartType === "donut" ? 48 : 0} outerRadius={78} isAnimationActive={false}>{chartRows.map((_, i) => <Cell key={i} fill={colors[(index + i) % colors.length]} />)}</Pie></PieChart></ResponsiveContainer></div>)}</div>;
    return <ResponsiveContainer width="100%" height={280} minWidth={0}>{cell.chartType === "line" ? <LineChart data={chartRows}>{shared}{cell.valueFields.map((field, i) => <Line key={field} dataKey={field} stroke={colors[i]} isAnimationActive={false} connectNulls={false} />)}</LineChart> : cell.chartType === "area" ? <AreaChart data={chartRows}>{shared}{cell.valueFields.map((field, i) => <Area key={field} dataKey={field} stroke={colors[i]} fill={colors[i]} fillOpacity={0.12} isAnimationActive={false} connectNulls={false} />)}</AreaChart> : <BarChart data={chartRows}>{shared}{cell.valueFields.map((field, i) => <Bar key={field} dataKey={field} fill={colors[i]} radius={[3, 3, 0, 0]} isAnimationActive={false} />)}</BarChart>}</ResponsiveContainer>;
  })() : null;
  return <div className="notebook-result">
    {negativePie && <p role="alert">饼图不能表示负数，请选择柱状图或折线图。</p>}
    {plot && <div className="notebook-plot" role="img" aria-label={`${cell.title}，图表下方提供对应数据表`}>{plot}{table.rows.length > 100 && <small>图表仅绘制前 100 行；请聚合后查看完整分布。</small>}</div>}
    <div className="notebook-table-scroll" tabIndex={0} aria-label={`${cell.title}结果表格，可横向滚动`}>
      <table><thead><tr>{table.fields.map((field) => <th key={field.name} title={`${field.name} · ${field.type}`}>{field.label}<small>{field.name} · {field.type}</small></th>)}</tr></thead>
        <tbody>{table.rows.slice(currentPage * 20, (currentPage + 1) * 20).map((row, index) => <tr key={index}>{table.fields.map((field) => <td key={field.name} title={String(row[field.name] ?? "NULL")}>{row[field.name] === null ? <span className="notebook-null">NULL</span> : String(row[field.name])}</td>)}</tr>)}</tbody>
      </table>
    </div>
    <footer><span>{table.rows.length} 行{table.truncated ? "（预览已截断）" : ""} · {table.fields.length} 列{!table.rows.length ? " · 查询成功，结果为空" : ""}</span>
      {pageCount > 1 && <span><button type="button" aria-label="上一页结果" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>‹</button> {currentPage + 1} / {pageCount} <button type="button" aria-label="下一页结果" disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>›</button></span>}
    </footer>
  </div>;
}
