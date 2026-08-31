import type { MetricCardProps } from "@/core/models";

export function MetricCard({ label, value, trend, isNew }: MetricCardProps) {
  return (
    <article className={`metric-card ${isNew ? "new-metric" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{trend}</em>
    </article>
  );
}
