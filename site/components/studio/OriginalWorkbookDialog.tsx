"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { readSheet, type SheetData } from "read-excel-file/browser";
import { triggerBrowserDownload } from "./ExcelDownloadButton";

const ROWS_PER_PAGE = 50;
const MAX_CELL_PREVIEW_CHARS = 500;

export function originalWorkbookColumnLabel(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) return "";
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + value % 26) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

export function formatOriginalWorkbookCell(value: unknown): string {
  const text = value instanceof Date
    ? Number.isNaN(value.getTime()) ? "" : value.toLocaleString("zh-CN")
    : value === null || value === undefined ? "" : String(value);
  return text.length > MAX_CELL_PREVIEW_CHARS ? `${text.slice(0, MAX_CELL_PREVIEW_CHARS)}…` : text;
}

interface OriginalWorkbookDialogProps {
  file: File;
  sheetNames: string[];
  onClose: () => void;
}

export function OriginalWorkbookDialog({ file, sheetNames, onClose }: OriginalWorkbookDialogProps) {
  const [activeSheetIndex, setActiveSheetIndex] = useState(0);
  const [sheetState, setSheetState] = useState<{ sheetName: string; rows: SheetData; error: string | null }>({ sheetName: "", rows: [], error: null });
  const [page, setPage] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  const activeSheetName = sheetNames[activeSheetIndex] ?? sheetNames[0] ?? "";
  const loading = sheetState.sheetName !== activeSheetName;
  const rows = useMemo(() => sheetState.sheetName === activeSheetName ? sheetState.rows : [], [activeSheetName, sheetState]);
  const error = loading ? null : sheetState.error;

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!activeSheetName) {
      queueMicrotask(() => {
        if (!cancelled) setSheetState({ sheetName: "", rows: [], error: "原始工作簿没有可预览的明细工作表。" });
      });
      return () => { cancelled = true; };
    }
    void readSheet(file, activeSheetName, { trim: false }).then((nextRows) => {
      if (!cancelled) setSheetState({ sheetName: activeSheetName, rows: nextRows, error: null });
    }).catch(() => {
      if (!cancelled) setSheetState({ sheetName: activeSheetName, rows: [], error: `无法读取工作表“${activeSheetName}”，请重新导入原始工作簿。` });
    });
    return () => { cancelled = true; };
  }, [activeSheetName, file]);

  const columnCount = useMemo(() => rows.reduce((maximum, row) => Math.max(maximum, row.length), 0), [rows]);
  const totalPages = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const visibleRows = rows.slice(page * ROWS_PER_PAGE, (page + 1) * ROWS_PER_PAGE);

  return (
    <div className="original-workbook-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section
        ref={dialogRef}
        className="original-workbook-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="original-workbook-title"
        aria-busy={loading}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header>
          <div><small>SESSION ORIGINAL WORKBOOK</small><h2 id="original-workbook-title">原始表格</h2><p>{file.name} · {(file.size / 1024).toFixed(1)} KiB</p></div>
          <div><button type="button" onClick={() => triggerBrowserDownload(file, file.name)}>下载原文件</button><button type="button" aria-label="关闭原始表格" onClick={onClose}>×</button></div>
        </header>
        <div className="original-workbook-privacy"><b>完整工作簿可用</b><span>AI 可按需查询全部工作表和数据行，预览按页显示。预览显示工作簿存储的单元格值，不运行宏。</span></div>
        <div className="original-workbook-tabs" role="tablist" aria-label="原始工作簿工作表">
          {sheetNames.map((sheetName, index) => (
            <button type="button" role="tab" aria-selected={activeSheetIndex === index} key={sheetName} onClick={() => { setActiveSheetIndex(index); setPage(0); }}>{sheetName}</button>
          ))}
        </div>
        <div className="original-workbook-body">
          {loading ? <div className="original-workbook-status" role="status">正在读取“{activeSheetName}”…</div> : error ? <div className="original-workbook-error" role="alert">{error}</div> : (
            <div className="original-workbook-table-scroll">
              <table aria-label={`原始工作表 ${activeSheetName}`}>
                <thead><tr><th aria-label="行号">#</th>{Array.from({ length: columnCount }, (_, index) => <th key={index}>{originalWorkbookColumnLabel(index)}</th>)}</tr></thead>
                <tbody>
                  {visibleRows.map((row, rowIndex) => (
                    <tr key={page * ROWS_PER_PAGE + rowIndex}>
                      <th scope="row">{page * ROWS_PER_PAGE + rowIndex + 1}</th>
                      {Array.from({ length: columnCount }, (_, columnIndex) => {
                        const value = formatOriginalWorkbookCell(row[columnIndex]);
                        return <td key={columnIndex} title={value}>{value}</td>;
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length === 0 && <div className="original-workbook-status">该工作表没有可显示的单元格。</div>}
            </div>
          )}
        </div>
        <footer>
          <span>{activeSheetName || "未选择工作表"} · {rows.length.toLocaleString("zh-CN")} 行 × {columnCount.toLocaleString("zh-CN")} 列</span>
          <div><button type="button" disabled={loading || page <= 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>上一页</button><b>{page + 1} / {totalPages}</b><button type="button" disabled={loading || page >= totalPages - 1} onClick={() => setPage((current) => Math.min(totalPages - 1, current + 1))}>下一页</button></div>
        </footer>
      </section>
    </div>
  );
}
