"use client";

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookTable } from "@/core/notebook/contracts";
import { ChartCanvasBoundary } from "@/components/chart-editor/ChartEditorBoundary";
import { notebookChartDataset } from "@/core/notebook/graphic-walker";
import "./notebook-graphic-walker.css";
import { useMemo } from "react";

const colors = ["#343431", "#74716b", "#a4a099", "#c6c2bb"];

/** Chart sampling follows execution order, independently of the table's local view. */
export function NotebookChart({ cell, table }: { cell: Extract<NotebookCell, { kind: "chart" }>; table: NotebookTable }) {
  const dataset = useMemo(() => cell.graphicWalker ? notebookChartDataset(cell, table) : undefined, [cell, table]);
  if (cell.graphicWalker && dataset) return <div className="notebook-gw-output"><ChartCanvasBoundary dataset={dataset} config={cell.graphicWalker} /></div>;
  const chartRows = table.rows.slice(0, 100);
  const radial = cell.chartType === "pie" || cell.chartType === "donut";
  const negativePie = radial && cell.valueFields.some((field) => chartRows.some((row) => typeof row[field] === "number" && row[field] < 0));
  if (negativePie) return <p role="alert">饼图不能表示负数，请选择柱状图或折线图。</p>;
  if (chartRows.length === 0) return null;

  const shared = <><CartesianGrid stroke="var(--studio-hairline, #e8e6e2)" vertical={false} /><XAxis dataKey={cell.categoryField} tick={{ fontSize: 11 }} minTickGap={16} /><YAxis tick={{ fontSize: 11 }} width={58} /><Tooltip /><Legend /></>;
  const plot = radial
    ? <div className="notebook-pies">{cell.valueFields.map((field, index) => <div key={field}><b>{field}</b><ResponsiveContainer width="100%" height={240} minWidth={0}><PieChart><Tooltip /><Legend /><Pie data={chartRows} dataKey={field} nameKey={cell.categoryField} innerRadius={cell.chartType === "donut" ? 48 : 0} outerRadius={78} isAnimationActive={false}>{chartRows.map((_, i) => <Cell key={i} fill={colors[(index + i) % colors.length]} />)}</Pie></PieChart></ResponsiveContainer></div>)}</div>
    : <ResponsiveContainer width="100%" height={280} minWidth={0}>{cell.chartType === "line" ? <LineChart data={chartRows}>{shared}{cell.valueFields.map((field, i) => <Line key={field} dataKey={field} stroke={colors[i]} isAnimationActive={false} connectNulls={false} />)}</LineChart> : cell.chartType === "area" ? <AreaChart data={chartRows}>{shared}{cell.valueFields.map((field, i) => <Area key={field} dataKey={field} stroke={colors[i]} fill={colors[i]} fillOpacity={0.12} isAnimationActive={false} connectNulls={false} />)}</AreaChart> : <BarChart data={chartRows}>{shared}{cell.valueFields.map((field, i) => <Bar key={field} dataKey={field} fill={colors[i]} radius={[3, 3, 0, 0]} isAnimationActive={false} />)}</BarChart>}</ResponsiveContainer>;

  return <div className="notebook-plot" role="img" aria-label={`${cell.title}，图表下方提供对应数据表`}>
    {plot}{table.rows.length > 100 && <small>图表仅绘制前 100 行；请聚合后查看完整分布。</small>}
  </div>;
}
