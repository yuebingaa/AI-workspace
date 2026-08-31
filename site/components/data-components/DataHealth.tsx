import type { DataHealthProps } from "@/core/models";

export function DataHealth({ title, subtitle, score, items }: DataHealthProps) {
  return (
    <article className="quality-card">
      <div className="card-head"><div><b>{title}</b><small>{subtitle}</small></div></div>
      <div className="score-ring"><strong>{score}</strong><span>/ 100</span></div>
      <ul>
        {items.map((item) => (
          <li key={item.label}><i className={item.status} />{item.label}<b>{item.value}</b></li>
        ))}
      </ul>
    </article>
  );
}
