"use client";

import { useEffect, useRef, useState } from "react";
import readXlsxFile, { type Sheet, type SheetData } from "read-excel-file/browser";
import { CSV_UPLOAD_LIMITS, type DatasetUploadResponse } from "@/core/datasets";
import { uploadCsvDataset, type CsvUploadProgress } from "@/core/datasets/client";
import { activeProjectHandle, saveProjectOriginal } from "@/core/projects/client";

export interface ImportedWorkbookAttachment {
  file: File;
  sheetNames: string[];
  aiRawAccess: boolean;
}

export interface SpreadsheetWorkspaceOption {
  id: string;
  label: string;
}

interface CsvUploadDialogProps {
  initialFiles?: File[];
  onUploaded: (
    result: DatasetUploadResponse,
    workbook: ImportedWorkbookAttachment | undefined,
    targetWorkspaceId: string,
  ) => void;
  onClose: () => void;
  workspaceOptions?: SpreadsheetWorkspaceOption[];
  activeWorkspaceId?: string;
  onOpenEdsImport?: () => void;
}

interface PreparedSpreadsheet {
  id: string;
  file: File;
  kind: "csv" | "xlsx";
  sheets: Sheet[];
  selectedSheet: string;
  targetWorkspaceId: string;
}

const MAX_BATCH_FILES = CSV_UPLOAD_LIMITS.maxDatasets;
const phaseLabels = {
  uploading: "正在上传",
  parsing: "服务端流式解析中",
  validating: "正在校验字段与数据质量",
} as const;

function fileKind(file: File): PreparedSpreadsheet["kind"] | null {
  const name = file.name.toLocaleLowerCase("en-US");
  if (name.endsWith(".csv")) return "csv";
  if (name.endsWith(".xlsx")) return "xlsx";
  return null;
}

function csvCell(value: SheetData[number][number]): string {
  if (value === null || value === undefined) return "";
  const text = value instanceof Date
    ? Number.isNaN(value.getTime()) ? "" : value.toISOString()
    : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function sheetDataToCsv(rows: SheetData): string {
  return `\ufeff${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}

function xlsxSheetAsCsv(item: PreparedSpreadsheet): File {
  const sheet = item.sheets.find((candidate) => candidate.sheet === item.selectedSheet);
  if (!sheet) throw new Error(`“${item.file.name}”没有可导入的工作表。`);
  const baseName = item.file.name.replace(/\.xlsx$/iu, "");
  return new File([sheetDataToCsv(sheet.data)], `${baseName}-${sheet.sheet}.csv`, { type: "text/csv;charset=utf-8" });
}

export function CsvUploadDialog({
  initialFiles = [],
  onUploaded,
  onClose,
  workspaceOptions = [],
  activeWorkspaceId = "",
  onOpenEdsImport,
}: CsvUploadDialogProps) {
  const projectMode = Boolean(activeProjectHandle());
  const [dragging, setDragging] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [prepared, setPrepared] = useState<PreparedSpreadsheet[]>([]);
  const [progress, setProgress] = useState<CsvUploadProgress | null>(null);
  const [uploadIndex, setUploadIndex] = useState(0);
  const [aiRawAccess, setAiRawAccess] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = preparing || progress !== null;
  const fallbackWorkspaceId = workspaceOptions.some((item) => item.id === activeWorkspaceId)
    ? activeWorkspaceId
    : workspaceOptions[0]?.id ?? "";
  const initialFilesRef = useRef(initialFiles);
  const prepareInitialFilesRef = useRef(addFiles);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled && initialFilesRef.current.length) void prepareInitialFilesRef.current(initialFilesRef.current);
    });
    return () => { cancelled = true; };
  }, []);

  async function addFiles(files: File[]) {
    if (busy || files.length === 0) return;
    setError(null);
    const remaining = MAX_BATCH_FILES - prepared.length;
    if (remaining <= 0) {
      setError(`一次最多导入 ${MAX_BATCH_FILES} 份文件。`);
      return;
    }
    if (files.length > remaining) {
      setError(`一次最多导入 ${MAX_BATCH_FILES} 份文件；请减少选择数量。`);
      return;
    }
    setPreparing(true);
    try {
      const additions: PreparedSpreadsheet[] = [];
      for (const file of files) {
        const kind = fileKind(file);
        if (!kind) throw new Error(`“${file.name}”不是受支持的 CSV 或 XLSX 文件。`);
        if (file.size < 1) throw new Error(`“${file.name}”是空文件。`);
        if (file.size > CSV_UPLOAD_LIMITS.maxFileBytes) throw new Error(`“${file.name}”不能超过 10 MiB。`);
        const sheets = kind === "xlsx" ? await readXlsxFile(file, { trim: false }) : [];
        if (kind === "xlsx" && sheets.length === 0) throw new Error(`“${file.name}”没有可导入的工作表。`);
        additions.push({
          id: `${file.name}:${file.size}:${file.lastModified}:${crypto.randomUUID()}`,
          file,
          kind,
          sheets,
          selectedSheet: sheets[0]?.sheet ?? "",
          targetWorkspaceId: fallbackWorkspaceId,
        });
      }
      setPrepared((current) => [...current, ...additions]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "无法读取所选表格，请检查文件后重试。");
    } finally {
      setPreparing(false);
    }
  }

  function updatePrepared(id: string, patch: Partial<Pick<PreparedSpreadsheet, "selectedSheet" | "targetWorkspaceId">>) {
    setPrepared((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  }

  async function uploadAll() {
    if (busy || prepared.length === 0) return;
    if (workspaceOptions.length > 0 && prepared.some((item) => !item.targetWorkspaceId)) {
      setError("请为每份文件选择目标工作界面。");
      return;
    }
    setError(null);
    for (let index = 0; index < prepared.length; index += 1) {
      const item = prepared[index];
      setUploadIndex(index);
      let uploadFile: File;
      try {
        uploadFile = item.kind === "xlsx" ? xlsxSheetAsCsv(item) : item.file;
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : `“${item.file.name}”转换失败。`);
        setProgress(null);
        return;
      }
      if (uploadFile.size > CSV_UPLOAD_LIMITS.maxFileBytes) {
        setError(`“${item.file.name}”转换后超过 10 MiB，无法导入。`);
        setProgress(null);
        return;
      }
      const request = uploadCsvDataset(uploadFile, setProgress);
      cancelRef.current = request.cancel;
      try {
        const result = await request.promise;
        onUploaded(
          result,
          item.kind === "xlsx" ? {
            file: item.file,
            sheetNames: item.sheets.map((sheet) => sheet.sheet),
            aiRawAccess,
          } : undefined,
          item.targetWorkspaceId,
        );
        await saveProjectOriginal(item.file, result.dataset.datasetId);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : `“${item.file.name}”上传失败，请重试。`);
        setProgress(null);
        cancelRef.current = null;
        return;
      }
    }
    cancelRef.current = null;
    setProgress(null);
    onClose();
  }

  function cancelOrClose() {
    if (cancelRef.current) cancelRef.current();
    else if (!preparing) onClose();
  }

  return (
    <div className="csv-upload-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
      <section className="csv-upload-dialog multi-spreadsheet-dialog" role="dialog" aria-modal="true" aria-label="导入本机表格">
        <header><div><small>GENERAL SPREADSHEET IMPORT</small><h2>导入本机表格</h2></div><button type="button" aria-label={busy ? "取消导入" : "关闭"} onClick={cancelOrClose}>×</button></header>
        {prepared.length === 0 ? (
          <div
            className={`csv-drop-zone${dragging ? " dragging" : ""}${busy ? " busy" : ""}`}
            onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void addFiles(Array.from(event.dataTransfer.files));
            }}
          >
            <span className="csv-upload-icon">XLSX</span>
            <h3>{preparing ? "正在读取文件结构" : "拖拽 CSV 或 XLSX 到这里"}</h3>
            <p>{preparing ? "请稍候…" : `支持一次多选，最多 ${MAX_BATCH_FILES} 份；XLSX 可分别选择工作表`}</p>
            {!preparing && <div className="spreadsheet-upload-entry-actions"><button type="button" className="primary" onClick={() => inputRef.current?.click()}>选择多份文件</button>{onOpenEdsImport && <button type="button" onClick={() => { onClose(); onOpenEdsImport(); }}>EDS 模板导入</button>}</div>}
          </div>
        ) : (
          <div className="spreadsheet-upload-queue">
            <div className="spreadsheet-upload-queue-head"><div><b>待导入 {prepared.length} 份文件</b><span>每份文件可放入不同的工作界面</span></div><button type="button" onClick={() => inputRef.current?.click()} disabled={busy || prepared.length >= MAX_BATCH_FILES}>继续添加</button></div>
            <div className="spreadsheet-upload-file-list">
              {prepared.map((item, index) => (
                <article className={`spreadsheet-upload-file${progress && uploadIndex === index ? " active" : ""}`} key={item.id}>
                  <span className="spreadsheet-upload-file-icon">{item.kind.toUpperCase()}</span>
                  <div className="spreadsheet-upload-file-name"><b title={item.file.name}>{item.file.name}</b><small>{(item.file.size / 1024).toFixed(1)} KiB</small></div>
                  {item.kind === "xlsx" && (
                    <label>工作表<select value={item.selectedSheet} disabled={busy} onChange={(event) => updatePrepared(item.id, { selectedSheet: event.target.value })}>{item.sheets.map((sheet) => <option key={sheet.sheet} value={sheet.sheet}>{sheet.sheet}</option>)}</select></label>
                  )}
                  {workspaceOptions.length > 0 && (
                    <label>放入界面<select value={item.targetWorkspaceId} disabled={busy} onChange={(event) => updatePrepared(item.id, { targetWorkspaceId: event.target.value })}>{workspaceOptions.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.label}</option>)}</select></label>
                  )}
                  <button type="button" className="spreadsheet-upload-remove" disabled={busy} aria-label={`移除 ${item.file.name}`} onClick={() => setPrepared((current) => current.filter((candidate) => candidate.id !== item.id))}>×</button>
                </article>
              ))}
            </div>
            {prepared.some((item) => item.kind === "xlsx") && (
              <label className="spreadsheet-upload-ai-access"><input type="checkbox" checked={aiRawAccess} disabled={busy} onChange={(event) => setAiRawAccess(event.target.checked)} /><span><b>允许 Harness 按需读取完整 XLSX</b><small>仅当前浏览器会话；不会写入 localStorage、备份或审计正文。</small></span></label>
            )}
            {progress && <div className="spreadsheet-upload-progress"><span>{uploadIndex + 1}/{prepared.length} · {prepared[uploadIndex]?.file.name} · {phaseLabels[progress.phase]} {progress.percent}%</span><div className="csv-progress" aria-label={`${phaseLabels[progress.phase]} ${progress.percent}%`}><i style={{ width: `${progress.percent}%` }} /></div></div>}
            <footer className="spreadsheet-upload-actions"><button type="button" onClick={cancelOrClose}>{progress ? "取消" : "返回"}</button><button type="button" className="primary" disabled={busy} onClick={() => void uploadAll()}>导入 {prepared.length} 份文件</button></footer>
          </div>
        )}
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          multiple
          hidden
          onChange={(event) => { void addFiles(Array.from(event.target.files ?? [])); event.target.value = ""; }}
        />
        {error && <div className="csv-upload-error" role="alert">{error}</div>}
        <ul className="csv-upload-limits">
          <li>单份最大 10 MiB、50,000 行、100 列；一批最多 {MAX_BATCH_FILES} 份</li>
          <li>XLSX 每份选择一个工作表生成独立数据源，原工作簿仍可会话内查看</li>
          <li>{projectMode ? "原始文件和数据表保存到当前本地项目，不按临时保留期过期" : "注册数据源最多保留 30 分钟；未启用本地持久化时重启失效"}</li>
        </ul>
      </section>
    </div>
  );
}
