import type { MetricCardProps } from "@/core/models";
import { componentTypographyStyle } from "./typography";

interface MetricCardViewProps extends Omit<MetricCardProps, "binding"> {
  value: string;
  nodeId?: string;
  changeFeedback?: "preview" | "applied";
}

export function MetricCard({ label, value, trend, isNew, nodeId, changeFeedback, ...typography }: MetricCardViewProps) {
  return (
    <article className={`metric-card ${isNew ? "new-metric" : ""}`} data-node-id={nodeId} data-change-feedback={changeFeedback}>
      <span style={componentTypographyStyle(typography)}>{label}</span>
      <strong>{value}</strong>
      <em>{trend}</em>
    </article>
  );
}
