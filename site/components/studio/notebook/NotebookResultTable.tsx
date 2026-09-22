"use client";

import { useState } from "react";
import type { NotebookTable } from "@/core/notebook/contracts";
import type { NotebookResultAvailability } from "@/core/notebook/result-availability";
import { nextNotebookPreviewSort, notebookOrderedPreview, notebookTablePreview, type NotebookPreviewSort } from "@/core/notebook/table-preview";
import { createTableCsv, csvPreviewFilename, MAX_CSV_EXPORT_BYTES } from "@/core/exports/table-csv";
import { triggerBrowserDownload } from "@/core/exports/browser-download";

/** Local view state only: no query, document mutation or chart ordering. */
export function NotebookResultTable({ title, table, availability: scope }: {
  title: string; table: NotebookTable; availability: NotebookResultAvailability;
}) {
  const [page, setPage] = useState(0);
  const [sort, setSort] = useState<NotebookPreviewSort>(null);
  const [exportFeedback, setExportFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const preview = notebookTablePreview(table, sort, page);
  const exportProblem = scope.completeness === "inconsistent"
    ? "结果元数据不一致，暂不能导出；请重新运行。"
    : scope.previewRowCount !== table.rows.length
      ? "预览行数与结果元数据不一致，暂不能导出；请重新运行。"
      : "";
  const scopeLabel = scope.completeness === "complete"
    ? `完整结果 ${scope.knownRowCount} 行${scope.previewOnly ? ` · 当前预览 ${scope.previewRowCount} 行` : ""}`
    : `${scope.completeness === "incomplete" ? "结果不完整" : scope.completeness === "inconsistent" ? "结果元数据不一致" : "完整性未知"} · 当前预览 ${scope.previewRowCount} 行`;
  const sortedField = table.fields.find((field) => field.name === preview.sort?.fieldName);
  function exportPreview() {
    if (exportProblem) return;
    try {
      const ordered = notebookOrderedPreview(table, preview.sort);
      const csv = createTableCsv({ ...table, rows: ordered.rows });
      triggerBrowserDownload(new Blob([csv.content], { type: "text/csv;charset=utf-8" }), csvPreviewFilename(title));
      setExportFeedback({ error: false, message: `已发起当前预览 CSV 下载：${csv.rowCount} 行。${csv.protectedCellCount ? `已对 ${csv.protectedCellCount} 个可能被识别为公式的文本或表头添加单引号前缀。` : ""}` });
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : "浏览器未能生成下载文件";
      setExportFeedback({ error: true, message: `当前预览导出失败：${reason}。可再次点击导出重试。` });
    }
  }
  return <>
    <div className="notebook-table-scroll" tabIndex={0} aria-label={`${title}结果表格，可横向滚动`}>
      <table><thead><tr>{table.fields.map((field) => {
        const direction = preview.sort?.fieldName === field.name ? preview.sort.direction : "none";
        const rule = field.type === "number" ? "数值排序" : field.type === "boolean" ? "布尔值排序" : "按原始文本排序，不转换数值或时区";
        return <th key={field.name} scope="col" aria-sort={direction} title={`${field.name} · ${field.type}`}>
          <button type="button" className="notebook-sort-button" aria-label={`按${field.label}排序`}
            title={`${rule}；点击切换升序、降序、原始顺序；NULL 始终最后`}
            onClick={() => { setSort(nextNotebookPreviewSort(preview.sort, field.name)); setPage(0); }}>
            <span>{field.label}<small>{field.name} · {field.type}</small></span>
            <span aria-hidden="true">{direction === "ascending" ? "↑" : direction === "descending" ? "↓" : "↕"}</span>
          </button>
        </th>;
      })}</tr></thead>
        <tbody>{preview.rows.map((row, index) => <tr key={index}>{table.fields.map((field) => <td key={field.name} title={String(row[field.name] ?? "NULL")}>{row[field.name] == null ? <span className="notebook-null">NULL</span> : String(row[field.name])}</td>)}</tr>)}</tbody>
      </table>
    </div>
    <footer><span aria-label="结果范围">{scopeLabel} · {table.fields.length} 列{scope.completeness === "complete" && scope.knownRowCount === 0 ? " · 查询成功，结果为空" : ""}</span>
      {preview.pageCount > 1 && <span><button type="button" aria-label="上一页结果" disabled={preview.page === 0} onClick={() => setPage(preview.page - 1)}>‹</button> {`预览 ${preview.page + 1} / ${preview.pageCount}`} <button type="button" aria-label="下一页结果" disabled={preview.page === preview.pageCount - 1} onClick={() => setPage(preview.page + 1)}>›</button></span>}
    </footer>
    <div className="notebook-preview-order"><span aria-live="polite" aria-label="预览排序">{preview.sort && sortedField ? `${sortedField.label} · ${preview.sort.direction === "ascending" ? "升序" : "降序"} · NULL 在最后` : "原始顺序"}</span>
      <small>仅对当前预览排序，不会重新查询或改变下游计算。</small>
    </div>
    <section className="notebook-preview-export" aria-label="当前预览导出">
      <div><button type="button" disabled={Boolean(exportProblem)} title={`按当前预览顺序导出已返回的 ${table.rows.length} 行，不限于本页`} onClick={exportPreview}>导出当前预览 CSV</button>
        <small>仅导出当前已返回预览 {table.rows.length} 行{table.rows.length === 0 ? "（仅表头）" : ""}，不是全量下载。</small></div>
      {exportProblem && <p role="status">{exportProblem}</p>}
      <details><summary>导出说明</summary>
        <p>导出当前已返回预览的所有行，不只是本页 20 行；采用当前预览排序，不重新查询，不影响图表或下游计算。未返回的完整结果不会包含在内。</p>
        <p>CSV 以 UTF-8 编码保存，表头使用字段名，不保留列类型。Excel 等软件打开时可能改写大整数、前导零或日期，请用文本导入并核对。NULL 与空文本都会导出为空单元格。</p>
        <p>对可能被识别为公式的文本及表头添加单引号前缀，以降低意外执行风险；不保证所有表格软件绝对安全，重新保存后仍需检查。为保护浏览器内存，单次 CSV 文件上限 {MAX_CSV_EXPORT_BYTES / 1024 / 1024} MiB。</p>
      </details>
      {exportFeedback && <p role={exportFeedback.error ? "alert" : "status"}>{exportFeedback.message}</p>}
    </section>
  </>;
}
