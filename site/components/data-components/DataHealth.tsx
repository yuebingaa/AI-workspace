import type { DataHealthProps } from "@/core/models";
import { componentTypographyStyle } from "./typography";

interface DataHealthViewProps extends DataHealthProps {
  nodeId?: string;
  changeFeedback?: "preview" | "applied";
}

export function DataHealth({ title, subtitle, score, items, nodeId, changeFeedback, ...typography }: DataHealthViewProps) {
  return (
    <article className="quality-card" data-node-id={nodeId} data-change-feedback={changeFeedback}>
      <div className="card-head"><div><b style={componentTypographyStyle(typography)}>{title}</b><small>{subtitle}</small></div></div>
      <div className="score-ring"><strong>{score}</strong><span>/ 100</span></div>
      <ul>
        {items.map((item) => (
          <li key={item.label}><i className={item.status} />{item.label}<b>{item.value}</b></li>
        ))}
      </ul>
    </article>
  );
}
