import type { DataTableProps } from "@/core/models";
import { componentTypographyStyle } from "./typography";

interface DataTableViewProps extends Omit<DataTableProps, "binding"> {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string>>;
  nodeId?: string;
  changeFeedback?: "preview" | "applied";
}

export function DataTable({
  title,
  subtitle,
  actionLabel,
  density = "comfortable",
  stripedRows = false,
  accentColor = "green",
  columns,
  rows,
  nodeId,
  changeFeedback,
  ...typography
}: DataTableViewProps) {
  return (
    <article className={`table-card table-density-${density} table-accent-${accentColor}${stripedRows ? " table-striped" : ""}`} data-node-id={nodeId} data-change-feedback={changeFeedback}>
      <div className="card-head">
        <div><b style={componentTypographyStyle(typography)}>{title}</b><small>{subtitle}</small></div>
        <button type="button" title="阶段 A 当前使用模拟导出">{actionLabel}</button>
      </div>
      <div className="table-scroll">
        <table>
          <thead><tr>{columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={`${row.region ?? "row"}-${rowIndex}`}>
                {columns.map((column) => (
                  <td key={column.key} className={column.key.includes("growth") ? "positive" : undefined}>
                    {row[column.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}
