import type { DataTableProps } from "@/core/models";

interface DataTableViewProps extends Omit<DataTableProps, "binding"> {
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string>>;
}

export function DataTable({ title, subtitle, actionLabel, columns, rows }: DataTableViewProps) {
  return (
    <article className="table-card">
      <div className="card-head">
        <div><b>{title}</b><small>{subtitle}</small></div>
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
