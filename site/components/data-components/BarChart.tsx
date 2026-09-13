"use client";

import type { CSSProperties } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart as RechartsBarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { BarChartColor, BarChartProps } from "@/core/models";
import { componentTypographyStyle } from "./typography";

interface BarChartViewProps extends Omit<BarChartProps, "binding"> {
  labels: string[];
  values: number[];
  yAxis: string[];
  domain: { minimum: number; maximum: number };
  nodeId?: string;
  changeFeedback?: "preview" | "applied";
}

interface ChartDatum {
  label: string;
  value: number;
}

const BAR_CHART_PALETTES: Record<BarChartColor, {
  bar: string;
  focus: string;
  negative: string;
  negativeFocus: string;
  slices: string[];
}> = {
  green: { bar: "#91c7b5", focus: "#0d6b57", negative: "#d29b9f", negativeFocus: "#b86b70", slices: ["#0d6b57", "#38a785", "#79cbb2", "#a8ddcd", "#6f8f86", "#b9c9c3", "#6c5ce7", "#e2a85a"] },
  blue: { bar: "#85b8ee", focus: "#2563eb", negative: "#9cb8dc", negativeFocus: "#356aaf", slices: ["#2563eb", "#4f8ee8", "#83b8ef", "#b4d4f5", "#536f9f", "#8ba3c7", "#6c5ce7", "#28a7a1"] },
  violet: { bar: "#b7a9ee", focus: "#6c5ce7", negative: "#b7a9d4", negativeFocus: "#735f9f", slices: ["#6c5ce7", "#8f7fe5", "#b1a5ed", "#d1c9f4", "#765b9e", "#b692ce", "#2a9d8f", "#e0a458"] },
  orange: { bar: "#efbc80", focus: "#d97706", negative: "#d8ad88", negativeFocus: "#a65c17", slices: ["#d97706", "#ea9a35", "#f0ba73", "#f5d7ad", "#a9672b", "#cf9a62", "#287f71", "#6c5ce7"] },
  red: { bar: "#e7a1a7", focus: "#c2414e", negative: "#d98b92", negativeFocus: "#9f303b", slices: ["#c2414e", "#dc6670", "#e6959c", "#f1c0c4", "#984c57", "#c17e86", "#286d9d", "#d59039"] },
  teal: { bar: "#82c9c3", focus: "#0f766e", negative: "#92bdb9", negativeFocus: "#376f6b", slices: ["#0f766e", "#2f9e95", "#71c4bc", "#a9ddd8", "#497d79", "#82aaa6", "#426aa3", "#d48a39"] },
};

function displayValue(value: number) {
  return Number.isInteger(value) ? value.toLocaleString("zh-CN") : value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}

function prefersVerticalLabels(labels: string[]): boolean {
  return labels.length >= 8 && labels.some((label) => Array.from(label).length >= 9);
}

function adaptiveBarSlotWidth(itemCount: number): number {
  if (itemCount >= 13) return 60;
  if (itemCount >= 9) return 70;
  return 84;
}

function ChartDataDescription({ labels, values }: Pick<BarChartViewProps, "labels" | "values">) {
  return (
    <ul className="chart-data-description">
      {labels.map((label, index) => <li key={`${label}-${index}`}>{label}：{displayValue(values[index] ?? 0)}</li>)}
    </ul>
  );
}

function BarColumns({ labels, values, domain, showValues, palette }: Pick<BarChartViewProps, "labels" | "values" | "domain" | "showValues"> & { palette: (typeof BAR_CHART_PALETTES)[BarChartColor] }) {
  const verticalLabels = prefersVerticalLabels(labels);
  const slotWidth = adaptiveBarSlotWidth(values.length);
  const plotWidth = Math.max(520, values.length * slotWidth);
  const chartHeight = verticalLabels ? 168 : 158;
  const data = labels.map((label, index): ChartDatum => ({ label, value: values[index] ?? 0 }));
  return (
    <div className={`bars-scroll${verticalLabels ? " vertical-labels" : ""}`} tabIndex={0} aria-label="柱状图横向滚动区域">
      <div
        className={`recharts-bar-plot${values.length >= 9 ? " dense" : ""}`}
        data-recharts-engine="true"
        style={{ minWidth: `${plotWidth}px`, "--bar-slot-width": `${slotWidth}px` } as CSSProperties}
      >
        <RechartsBarChart
          width={plotWidth}
          height={chartHeight}
          data={data}
          barCategoryGap="55%"
          margin={{ top: showValues ? 18 : 7, right: 3, bottom: 0, left: 3 }}
          accessibilityLayer
        >
          <CartesianGrid vertical={false} stroke="#edf1ef" />
          <XAxis dataKey="label" hide />
          <YAxis domain={[domain.minimum, domain.maximum]} hide allowDataOverflow />
          <ReferenceLine y={0} stroke="#cfd9d5" />
          <Tooltip formatter={(value) => displayValue(Number(value))} />
          <Bar dataKey="value" maxBarSize={18} radius={[4, 4, 1, 1]} isAnimationActive={false}>
            {data.map((item, index) => {
              const last = index === data.length - 1;
              const fill = item.value < 0
                ? last ? palette.negativeFocus : palette.negative
                : last ? palette.focus : palette.bar;
              return <Cell key={`${item.label}-${index}`} fill={fill} className={item.value < 0 ? "negative" : "positive"} />;
            })}
            {showValues && <LabelList dataKey="value" position="top" formatter={(value) => displayValue(Number(value))} className="bar-value" />}
          </Bar>
        </RechartsBarChart>
        <div className={`recharts-category-labels${verticalLabels ? " vertical" : ""}`} style={{ gridTemplateColumns: `repeat(${Math.max(1, labels.length)},var(--bar-slot-width))` }}>
          {labels.map((label, index) => <small key={`${label}-${index}`} title={label}>{label}</small>)}
        </div>
      </div>
    </div>
  );
}

function CurveChart({ labels, values, domain, showValues, area, palette }: Pick<BarChartViewProps, "labels" | "values" | "domain" | "showValues"> & { area: boolean; palette: (typeof BAR_CHART_PALETTES)[BarChartColor] }) {
  const data = labels.map((label, index): ChartDatum => ({ label, value: values[index] ?? 0 }));
  const common = {
    data,
    margin: { top: showValues ? 20 : 10, right: 12, bottom: 8, left: 0 },
    responsive: true,
    style: { width: "100%", height: "155px" },
    accessibilityLayer: true,
  } as const;
  const axes = (
    <>
      <CartesianGrid vertical={false} stroke="#edf1ef" />
      <XAxis dataKey="label" tick={{ fontSize: 8, fill: "#8c9692" }} minTickGap={12} />
      <YAxis domain={[domain.minimum, domain.maximum]} tick={{ fontSize: 8, fill: "#8c9692" }} width={38} allowDataOverflow />
      <ReferenceLine y={0} stroke="#cfd9d5" />
      <Tooltip formatter={(value) => displayValue(Number(value))} />
    </>
  );
  return (
    <div className={`curve-chart recharts-curve-chart ${area ? "area" : "line"}`} data-recharts-engine="true">
      {area ? (
        <AreaChart {...common}>
          {axes}
          <Area type="monotone" dataKey="value" stroke={palette.focus} fill={palette.bar} fillOpacity={0.32} strokeWidth={2.4} isAnimationActive={false}>
            {showValues && <LabelList dataKey="value" position="top" formatter={(value) => displayValue(Number(value))} className="curve-value" />}
          </Area>
        </AreaChart>
      ) : (
        <LineChart {...common}>
          {axes}
          <Line type="monotone" dataKey="value" stroke={palette.focus} strokeWidth={2.4} dot={{ r: 3.5, fill: "#fff", strokeWidth: 2.4 }} activeDot={{ r: 5 }} isAnimationActive={false}>
            {showValues && <LabelList dataKey="value" position="top" formatter={(value) => displayValue(Number(value))} className="curve-value" />}
          </Line>
        </LineChart>
      )}
    </div>
  );
}

function RadialChart({ labels, values, palette, donut, showValues }: Pick<BarChartViewProps, "labels" | "values" | "showValues"> & { palette: string[]; donut: boolean }) {
  const data = labels.map((label, index): ChartDatum => ({ label, value: Math.max(0, values[index] ?? 0) }));
  const total = data.reduce((sum, item) => sum + item.value, 0);
  const chartLabel = labels.map((label, index) => `${label}：${displayValue(values[index] ?? 0)}`).join("；");
  return (
    <div className="radial-chart" data-recharts-engine="true">
      <div className={`radial-plot${donut ? " donut" : ""}`} role="img" aria-label={chartLabel}>
        <PieChart width={170} height={170} accessibilityLayer>
          <Tooltip formatter={(value) => displayValue(Number(value))} />
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={donut ? 48 : 0}
            outerRadius={72}
            paddingAngle={data.length > 1 ? 1 : 0}
            isAnimationActive={false}
          >
            {data.map((item, index) => <Cell key={`${item.label}-${index}`} fill={palette[index % palette.length]} />)}
            {showValues && <LabelList dataKey="value" position="outside" formatter={(value) => displayValue(Number(value))} className="radial-value" />}
          </Pie>
        </PieChart>
        {donut && <span className="radial-center"><b>100%</b><small>汇总占比</small></span>}
      </div>
      <ul className="radial-legend">
        {labels.slice(0, 10).map((label, index) => {
          const value = values[index] ?? 0;
          const ratio = total > 0 ? Math.max(0, value) / total * 100 : 0;
          return (
            <li key={`${label}-${index}`}>
              <i style={{ background: palette[index % palette.length] }} />
              <span title={label}>{label}</span>
              <b>{ratio.toFixed(ratio >= 10 ? 1 : 2)}%{showValues ? ` · ${displayValue(value)}` : ""}</b>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const chartTypeLabels = { bar: "汇总值", line: "折线趋势", area: "面积趋势", pie: "分类占比", donut: "分类占比" } as const;

export function BarChart({ title, subtitle, color = "green", chartType = "bar", showValues = false, labels, values, yAxis, domain, nodeId, changeFeedback, ...typography }: BarChartViewProps) {
  const palette = BAR_CHART_PALETTES[color];
  const colorVariables = {
    "--chart-bar-color": palette.bar,
    "--chart-bar-focus-color": palette.focus,
    "--chart-bar-negative-color": palette.negative,
    "--chart-bar-negative-focus-color": palette.negativeFocus,
  } as CSSProperties;
  return (
    <article
      className="chart-card"
      data-chart-color={color}
      data-chart-type={chartType}
      data-chart-engine="recharts"
      data-show-values={showValues ? "true" : "false"}
      data-has-negative={values.some((value) => value < 0) ? "true" : "false"}
      data-has-positive={values.some((value) => value >= 0) ? "true" : "false"}
      data-node-id={nodeId}
      data-change-feedback={changeFeedback}
      style={colorVariables}
    >
      <div className="card-head">
        <div><b style={componentTypographyStyle(typography)}>{title}</b><small>{subtitle}</small></div>
        <span className="legend"><i />{chartTypeLabels[chartType]}</span>
      </div>
      {chartType === "bar" && <div className={`chart${prefersVerticalLabels(labels) ? " vertical-labels" : ""}`}><div className="y-axis">{yAxis.map((label, index) => <span key={`${index}-${label}`}>{label}</span>)}</div><BarColumns labels={labels} values={values} domain={domain} showValues={showValues} palette={palette} /></div>}
      {(chartType === "line" || chartType === "area") && <CurveChart labels={labels} values={values} domain={domain} showValues={showValues} area={chartType === "area"} palette={palette} />}
      {(chartType === "pie" || chartType === "donut") && <RadialChart labels={labels} values={values} palette={palette.slices} donut={chartType === "donut"} showValues={showValues} />}
      <ChartDataDescription labels={labels} values={values} />
    </article>
  );
}
