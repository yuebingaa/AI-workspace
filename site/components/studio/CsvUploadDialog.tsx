"use client";

import { useRef, useState } from "react";
import { CSV_UPLOAD_LIMITS, type DatasetUploadResponse } from "@/core/datasets";
import { DatasetClientError, uploadCsvDataset, type CsvUploadProgress } from "@/core/datasets/client";

interface CsvUploadDialogProps {
  onUploaded: (result: DatasetUploadResponse) => void;
  onClose: () => void;
}

const phaseLabels = {
  uploading: "正在上传",
  parsing: "服务端流式解析中",
  validating: "正在校验字段与数据质量",
} as const;

export function CsvUploadDialog({ onUploaded, onClose }: CsvUploadDialogProps) {
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState<CsvUploadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function start(file: File) {
    if (progress) return;
    setError(null);
    if (!file.name.toLocaleLowerCase("en-US").endsWith(".csv")) {
      setError("当前仅支持 .csv 文件。");
      return;
    }
    if (file.size > CSV_UPLOAD_LIMITS.maxFileBytes) {
      setError("CSV 文件不能超过 10 MiB。");
      return;
    }
    const request = uploadCsvDataset(file, setProgress);
    cancelRef.current = request.cancel;
    try {
      const result = await request.promise;
      setProgress({ phase: "validating", percent: 100 });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      onUploaded(result);
    } catch (caught) {
      setError(caught instanceof DatasetClientError ? caught.message : "CSV 上传失败，请重试。");
    } finally {
      cancelRef.current = null;
      setProgress(null);
    }
  }

  function cancelOrClose() {
    if (cancelRef.current) cancelRef.current();
    else onClose();
  }

  return (
    <div className="csv-upload-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !progress) onClose(); }}>
      <section className="csv-upload-dialog" role="dialog" aria-modal="true" aria-label="上传 CSV 数据源">
        <header><div><small>临时数据源</small><h2>上传 CSV</h2></div><button type="button" aria-label={progress ? "取消上传" : "关闭"} onClick={cancelOrClose}>×</button></header>
        <div
          className={`csv-drop-zone${dragging ? " dragging" : ""}${progress ? " busy" : ""}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void start(file);
          }}
        >
          <span className="csv-upload-icon">CSV</span>
          <h3>{progress ? phaseLabels[progress.phase] : "拖拽 CSV 文件到这里"}</h3>
          <p>{progress ? `${progress.percent}%` : "支持 UTF-8 与 UTF-8 BOM，或通过文件选择器上传"}</p>
          {progress ? (
            <div className="csv-progress" aria-label={`${phaseLabels[progress.phase]} ${progress.percent}%`}><i style={{ width: `${progress.percent}%` }} /></div>
          ) : (
            <button type="button" className="primary" onClick={() => inputRef.current?.click()}>选择 CSV 文件</button>
          )}
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            hidden
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void start(file); event.target.value = ""; }}
          />
        </div>
        {error && <div className="csv-upload-error" role="alert">{error}</div>}
        <ul className="csv-upload-limits">
          <li>最大 10 MiB、50,000 行、100 列</li>
          <li>单元格文本最多 20,000 字符</li>
          <li>最多保留 30 分钟；未启用本地持久化时重启失效</li>
        </ul>
      </section>
    </div>
  );
}
