"use client";

import { Button } from "@/components/ui/button";
import { Checkbox, TextInput } from "@/components/ui/fields";
import { useMemo, useState } from "react";
import { Popover } from "@radix-ui/themes";
import { getCoreRowModel, getFilteredRowModel, getPaginationRowModel, useReactTable, type ColumnDef, type PaginationState, type VisibilityState } from "@tanstack/react-table";
import type { NotebookTable } from "@/core/notebook/contracts";
import type { NotebookResultAvailability } from "@/core/notebook/result-availability";
import { nextNotebookPreviewSort, notebookOrderedPreview, notebookPreviewValue, type NotebookPreviewSort } from "@/core/notebook/table-preview";
import { createTableCsv, csvPreviewFilename, MAX_CSV_EXPORT_BYTES } from "@/core/exports/table-csv";
import { triggerBrowserDownload } from "@/core/exports/browser-download";

/** Local view state only: no query, document mutation or chart ordering. */
export function NotebookResultTable({ title, table, availability: scope }: {
  title: string; table: NotebookTable; availability: NotebookResultAvailability;
}) {
  "use no memo"; // TanStack v8 owns mutable table state; keep this adapter outside compiler memoization.
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize: 20 });
  const [search, setSearch] = useState("");
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [sort, setSort] = useState<NotebookPreviewSort>(null);
  const [exportFeedback, setExportFeedback] = useState<{ error: boolean; message: string } | null>(null);
  const ordered = useMemo(() => notebookOrderedPreview(table, sort), [table, sort]);
  // Generated IDs avoid collisions with dots and Object.prototype member names in user fields.
  const columns = useMemo<ColumnDef<NotebookTable["rows"][number]>[]>(() => table.fields.map((field, index) => ({
    id: `field_${index}`, header: field.label, accessorFn: row => notebookPreviewValue(row, field.name),
    size: 180, minSize: 100, maxSize: 600,
  })), [table.fields]);
  // Mutable v8 handles stay inside this non-memoized adapter (including row/cell rendering).
  // eslint-disable-next-line react-hooks/incompatible-library
  const grid = useReactTable({ data: ordered.rows, columns, state: { pagination, globalFilter: search, columnVisibility },
    onPaginationChange: setPagination, onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(), getFilteredRowModel: getFilteredRowModel(), getPaginationRowModel: getPaginationRowModel(),
    getColumnCanGlobalFilter: () => true,
    globalFilterFn: (row, columnId, value: string) => String(row.getValue(columnId) ?? "NULL").toLocaleLowerCase().includes(value.trim().toLocaleLowerCase()),
    columnResizeMode: "onChange",
  });
  const preview = { sort: ordered.sort, page: pagination.pageIndex, pageCount: Math.max(1, grid.getPageCount()), rows: grid.getRowModel().rows };
  const visibleColumns = grid.getVisibleLeafColumns();
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
    <div className="notebook-table-toolbar">
      <label className="notebook-table-search"><span aria-hidden="true">⌕</span><TextInput aria-label={`${title}搜索当前预览`} placeholder="搜索当前预览…" type="search" value={search} onChange={event => { setSearch(event.target.value); grid.setPageIndex(0); }} /></label>
      <span className="notebook-table-match" aria-live="polite">{search ? `匹配 ${grid.getFilteredRowModel().rows.length} / ${table.rows.length} 行` : `${table.rows.length} 行`}</span>
      <Popover.Root><Popover.Trigger><Button size="small" variant="ghost" type="button">列设置 <span>{visibleColumns.length} / {table.fields.length}</span></Button></Popover.Trigger>
        <Popover.Content className="notebook-column-popover" sideOffset={6} align="end" collisionPadding={12} aria-label={`${title}列设置`}>
          <b>显示字段</b><p>拖动表头右侧边缘调整列宽。</p>
          {grid.getAllLeafColumns().map((column, index) => <label key={column.id}><Checkbox  checked={column.getIsVisible()} disabled={column.getIsVisible() && visibleColumns.length === 1} onCheckedChange={checked => column.toggleVisibility(checked)} /><span>{table.fields[index].label}<small>{table.fields[index].name}</small></span></label>)}
          <Button size="small" variant="ghost" type="button" onClick={() => { grid.resetColumnVisibility(); grid.resetColumnSizing(); }}>恢复全部列与默认宽度</Button>
        </Popover.Content>
      </Popover.Root>
      {search && <Button size="small" variant="ghost" type="button" onClick={() => { setSearch(""); grid.setPageIndex(0); }}>清除搜索</Button>}
    </div>
    <div className="notebook-table-scroll" tabIndex={0} aria-label={`${title}结果表格，可横向滚动`}>
      <table style={{ width: grid.getTotalSize(), minWidth: "100%", tableLayout: "fixed" }}><thead><tr>{visibleColumns.map(column => {
        const field = table.fields[Number(column.id.slice(6))];
        const direction = preview.sort?.fieldName === field.name ? preview.sort.direction : "none";
        const rule = field.type === "number" ? "数值排序" : field.type === "boolean" ? "布尔值排序" : "按原始文本排序，不转换数值或时区";
        return <th key={field.name} scope="col" aria-sort={direction} style={{ width: column.getSize() }} title={`${field.name} · ${field.type}`}>
          <Button variant="ghost" type="button" className="notebook-sort-button" aria-label={`按${field.label}排序`}
            title={`${rule}；点击切换升序、降序、原始顺序；NULL 始终最后`}
            onClick={() => { setSort(nextNotebookPreviewSort(preview.sort, field.name)); grid.setPageIndex(0); }}>
            <span>{field.label}<small>{field.name} · {field.type}</small></span>
            <span aria-hidden="true">{direction === "ascending" ? "↑" : direction === "descending" ? "↓" : "↕"}</span>
          </Button>
          <button type="button" className={`notebook-column-resize${column.getIsResizing() ? " is-resizing" : ""}`} aria-label={`调整${field.label}列宽`}
            title="拖动调整列宽；左右方向键微调；双击恢复" onMouseDown={grid.getHeaderGroups()[0].headers.find(header => header.column.id === column.id)?.getResizeHandler()}
            onTouchStart={grid.getHeaderGroups()[0].headers.find(header => header.column.id === column.id)?.getResizeHandler()}
            onDoubleClick={() => column.resetSize()} onKeyDown={event => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault(); grid.setColumnSizing(sizes => ({ ...sizes, [column.id]: Math.max(100, Math.min(600, column.getSize() + (event.key === "ArrowRight" ? 16 : -16))) }));
            }} />
        </th>;
      })}</tr></thead>
        <tbody>{preview.rows.map(row => <tr key={row.id}>{row.getVisibleCells().map(cell => {
          const value = cell.getValue();
          return <td key={cell.id} title={String(value ?? "NULL")}>{value == null ? <span className="notebook-null">NULL</span> : String(value)}</td>;
        })}</tr>)}</tbody>
      </table>
      {!preview.rows.length && <p className="notebook-table-empty">{search ? "没有匹配的行，试试其他关键词。" : "查询成功，结果为空。"}</p>}
    </div>
    <footer><span aria-label="结果范围">{scopeLabel} · {table.fields.length} 列{scope.completeness === "complete" && scope.knownRowCount === 0 ? " · 查询成功，结果为空" : ""}</span>
      <span aria-live="polite" aria-label="预览排序">{preview.sort && sortedField ? `${sortedField.label} · ${preview.sort.direction === "ascending" ? "升序" : "降序"} · NULL 在最后` : "原始顺序"}</span>
      {preview.pageCount > 1 && <span><Button variant="secondary" type="button" aria-label="上一页结果" disabled={!grid.getCanPreviousPage()} onClick={() => grid.previousPage()}>‹</Button> {`预览 ${preview.page + 1} / ${preview.pageCount}`} <Button variant="secondary" type="button" aria-label="下一页结果" disabled={!grid.getCanNextPage()} onClick={() => grid.nextPage()}>›</Button></span>}
    </footer>
    <section className="notebook-preview-export" aria-label="当前预览导出">
      <div><Button size="small" variant="ghost" type="button" disabled={Boolean(exportProblem)} title={`按当前预览顺序导出已返回的 ${table.rows.length} 行，不限于本页`} onClick={exportPreview}>导出当前预览 CSV</Button>
        <small>仅导出当前已返回预览 {table.rows.length} 行{table.rows.length === 0 ? "（仅表头）" : ""}，含所有列与被搜索隐藏的行，不是全量下载。</small></div>
      {exportProblem && <p role="status">{exportProblem}</p>}
      <details><summary>导出说明</summary>
        <p>搜索与排序仅作用于已返回的预览，不会重新查询或改变下游计算。</p>
        <p>导出当前已返回预览的所有行，不只是本页 20 行；采用当前预览排序，不重新查询，不影响图表或下游计算。未返回的完整结果不会包含在内。</p>
        <p>CSV 以 UTF-8 编码保存，表头使用字段名，不保留列类型。Excel 等软件打开时可能改写大整数、前导零或日期，请用文本导入并核对。NULL 与空文本都会导出为空单元格。</p>
        <p>对可能被识别为公式的文本及表头添加单引号前缀，以降低意外执行风险；不保证所有表格软件绝对安全，重新保存后仍需检查。为保护浏览器内存，单次 CSV 文件上限 {MAX_CSV_EXPORT_BYTES / 1024 / 1024} MiB。</p>
      </details>
      {exportFeedback && <p role={exportFeedback.error ? "alert" : "status"}>{exportFeedback.message}</p>}
    </section>
  </>;
}
