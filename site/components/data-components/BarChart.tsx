import type { BarChartProps } from "@/core/models";

interface BarChartViewProps extends Omit<BarChartProps, "binding"> {
  labels: string[];
  values: number[];
  yAxis: string[];
}

export function BarChart({ title, subtitle, labels, values, yAxis }: BarChartViewProps) {
  const maximum = Math.max(...values, 1);
  return (
    <article className="chart-card">
      <div className="card-head">
        <div><b>{title}</b><small>{subtitle}</small></div>
        <span className="legend"><i />实际收入　<span />目标</span>
      </div>
      <div className="chart">
        <div className="y-axis">{yAxis.map((label) => <span key={label}>{label}</span>)}</div>
        <div className="bars">
          {values.map((height, index) => (
            <div className="bar-wrap" key={labels[index]}>
              <i style={{ height: Math.max(8, height / maximum * 132) }} className={index === 9 ? "focus" : ""} />
              <small>{labels[index]}</small>
            </div>
          ))}
        </div>
      </div>
    </article>
  );
}
