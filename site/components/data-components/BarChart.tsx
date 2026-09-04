import type { BarChartProps } from "@/core/models";

interface BarChartViewProps extends Omit<BarChartProps, "binding"> {
  labels: string[];
  values: number[];
  yAxis: string[];
  domain: { minimum: number; maximum: number };
}

export function BarChart({ title, subtitle, labels, values, yAxis, domain }: BarChartViewProps) {
  const span = domain.maximum - domain.minimum;
  const zeroPosition = (domain.maximum / span) * 100;
  return (
    <article className="chart-card">
      <div className="card-head">
        <div><b>{title}</b><small>{subtitle}</small></div>
        <span className="legend"><i />汇总值</span>
      </div>
      <div className="chart">
        <div className="y-axis">{yAxis.map((label, index) => <span key={`${index}-${label}`}>{label}</span>)}</div>
        <div className="bars">
          {values.map((value, index) => {
            const valuePosition = ((domain.maximum - value) / span) * 100;
            const barHeight = Math.abs(valuePosition - zeroPosition);
            const top = Math.min(valuePosition, zeroPosition);
            return (
              <div className="bar-wrap" key={labels[index]}>
                <div className="bar-track">
                  <i
                    aria-label={`${labels[index]}：${value}`}
                    style={{ top: `${Math.min(98.5, top)}%`, height: `${Math.max(1.5, barHeight)}%` }}
                    className={`${value < 0 ? "negative" : "positive"}${index === 9 ? " focus" : ""}`}
                  />
                </div>
                <small>{labels[index]}</small>
              </div>
            );
          })}
        </div>
      </div>
    </article>
  );
}
