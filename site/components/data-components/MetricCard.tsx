import type { MetricCardProps } from "@/core/models";

interface MetricCardViewProps extends Omit<MetricCardProps, "binding"> {
  value: string;
}

export function MetricCard({ label, value, trend, isNew }: MetricCardViewProps) {
  return (
    <article className={`metric-card ${isNew ? "new-metric" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{trend}</em>
    </article>
  );
}
