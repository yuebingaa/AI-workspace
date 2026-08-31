import type { MetricCardProps } from "@/core/models";

export function MetricCard({ label, value, trend, isNew }: MetricCardProps) {
  return (
    <article className={isNew ? "new-metric" : undefined}>
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{trend}</em>
    </article>
  );
}
