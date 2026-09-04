"use client";

import { useEffect, useRef, useState } from "react";
import { analyzeEdsFiles, EdsClientError } from "@/core/eds/client";
import {
  EDS_RULE_VERSION,
  EDS_TEMPLATE_VERSION,
  EDS_UPLOAD_LIMITS,
  type EdsAnalysisResponse,
  type EdsChartItem,
} from "@/core/eds";
import { ExcelDownloadButton } from "./ExcelDownloadButton";

interface EdsAnalysisDialogProps {
  onClose: () => void;
  onCreateWorkspace: (result: EdsAnalysisResponse) => void;
}

export function canApplyEdsRequestResult(input: {
  mounted: boolean;
  activeRequestId: number;
  requestId: number;
  aborted: boolean;
}): boolean {
  return input.mounted && input.activeRequestId === input.requestId && !input.aborted;
}

export function canChooseEdsFile(running: boolean, hasActiveRequest: boolean): boolean {
  return !running && !hasActiveRequest;
}

export function shouldHandleEdsDialogEscape(key: string, isComposing: boolean): boolean {
  return key === "Escape" && !isComposing;
}

export function wrappedEdsDialogFocusIndex(currentIndex: number, itemCount: number, backwards: boolean): number | null {
  if (itemCount <= 0) return null;
  if (backwards && currentIndex <= 0) return itemCount - 1;
  if (!backwards && (currentIndex < 0 || currentIndex >= itemCount - 1)) return 0;
  return null;
}

function fileError(file: File): string | null {
  if (!file.name.toLocaleLowerCase("en-US").endsWith(".xlsx")) return "当前仅支持 .xlsx 工作簿。";
  if (file.size > EDS_UPLOAD_LIMITS.maxFileBytes) return "单个 XLSX 文件不能超过 10 MiB。";
  return null;
}

export function validateEdsFileSelection(file: File): { file: File | null; error: string | null } {
  const error = fileError(file);
  return error ? { file: null, error } : { file, error: null };
}

export function EdsWorkbookPicker({
  label,
  description,
  file,
  disabled,
  onSelect,
}: {
  label: string;
  description: string;
  file: File | null;
  disabled: boolean;
  onSelect: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
      type="button"
      className={`eds-file-picker${file ? " selected" : ""}`}
      disabled={disabled}
      aria-label={`${file ? "替换" : "选择"}${label}`}
      onClick={() => { if (!disabled) input.current?.click(); }}
    >
      <span className="eds-file-icon">XLSX</span>
      <span><b>{label}</b><small>{file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KiB` : description}</small></span>
        <i>{file ? "已选择" : "选择文件"}</i>
      </button>
      <input
        ref={input}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        disabled={disabled}
        hidden
        onChange={(event) => {
          const selected = event.target.files?.[0];
          if (selected) onSelect(selected);
          event.target.value = "";
        }}
      />
    </>
  );
}

function ChartRows({ items, unit }: { items: EdsChartItem[]; unit: "count" | "minutes" }) {
  const maximum = Math.max(1, ...items.map((item) => item[unit]));
  return (
    <div className="eds-chart-rows" role="list">
      {items.map((item, index) => {
        const value = item[unit];
        const valueText = unit === "count"
          ? `${item.count.toLocaleString("zh-CN")} 次`
          : `${item.minutes.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} 分钟`;
        return (
        <div className="eds-chart-row" role="listitem" key={`${unit}-${index}-${item.label}`}>
          <span title={item.label}>{item.label}</span>
          <div
            role="meter"
            aria-label={`${item.label}：${valueText}`}
            aria-valuemin={0}
            aria-valuemax={maximum}
            aria-valuenow={value}
            aria-valuetext={valueText}
          ><i style={{ width: `${value === 0 ? 0 : Math.max(1.5, value / maximum * 100)}%` }} /></div>
          <b>{unit === "count" ? item.count.toLocaleString("zh-CN") : `${item.minutes.toLocaleString("zh-CN", { maximumFractionDigits: 2 })} min`}</b>
        </div>
        );
      })}
    </div>
  );
}

export function EdsErrorMessage({ message }: { message: string }) {
  return <div className="eds-error" role="alert" aria-live="assertive" aria-atomic="true">{message}</div>;
}

export function EdsAnalysisResultView({ result }: { result: EdsAnalysisResponse }) {
  const passed = result.comparison?.mismatchCount === 0;
  return (
    <div className="eds-result" aria-label="EDS 自动分析结果">
      <div className="eds-result-banner" role="status" aria-live="polite" aria-atomic="true">
        {result.comparison ? (
          <div><small>{result.summary.date} · {result.summary.shift}</small><h3>{passed ? "验收基准比对全部一致" : "发现验收基准差异"}</h3><p>核心统计 {result.comparison.coreMatched}/{result.comparison.coreTotal}；整表数字 {result.comparison.reportMatched}/{result.comparison.reportTotal}</p></div>
        ) : (
          <div><small>{result.summary.date} · {result.summary.shift}</small><h3>分析与报表已生成</h3><p>已按服务端内置模板和固定统计规则完成</p></div>
        )}
        <span className={result.comparison && !passed ? "fail" : "pass"}>{result.comparison ? (passed ? "通过" : `${result.comparison.mismatchCount} 项差异`) : "已完成"}</span>
      </div>
      <div className="eds-version-strip" aria-label="EDS 处理版本">
        <span><small>报表模板</small><b>{result.configuration.templateVersion}</b></span>
        <span><small>统计规则</small><b>{result.configuration.ruleVersion}</b></span>
        <i>{result.configuration.comparisonMode === "custom_template" ? "高级验收比对" : "标准自动分析"}</i>
      </div>
      <div className="eds-kpis">
        <article><small>输入明细</small><b>{result.summary.inputRows.toLocaleString("zh-CN")}</b><span>行</span></article>
        <article><small>命中记录</small><b>{result.summary.matchedRows.toLocaleString("zh-CN")}</b><span>行</span></article>
        <article><small>异常次数</small><b>{result.summary.totalOccurrences.toLocaleString("zh-CN")}</b><span>次</span></article>
        <article><small>异常时间</small><b>{result.summary.totalMinutes.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}</b><span>分钟</span></article>
      </div>
      <div className="eds-charts">
        <section><header><div><small>LINE VIEW</small><h4>各线体异常次数</h4></div><span>{result.lineSummary.length} 条线体</span></header><ChartRows items={result.lineSummary} unit="count" /></section>
        <section><header><div><small>ISSUE VIEW</small><h4>14 类异常时长</h4></div><span>单位：分钟</span></header><ChartRows items={result.issueSummary} unit="minutes" /></section>
      </div>
      {result.warnings.length > 0 && <ul className="eds-warnings">{result.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      {result.comparison && result.comparison.mismatches.length > 0 && (
        <div className="eds-mismatches"><b>首批差异单元格</b><p>{result.comparison.mismatches.map((item) => `${item.cell}: 目标 ${item.expected ?? "空"} / 生成 ${item.actual}`).join("；")}</p></div>
      )}
      <div className="eds-export-row">
        <div><b>{result.exportArtifact.fileName}</b><small>{(result.exportArtifact.sizeBytes / 1024).toFixed(1)} KiB · 下载链接 10 分钟内有效</small></div>
        <ExcelDownloadButton artifact={result.exportArtifact} label="下载分析结果" />
      </div>
    </div>
  );
}

export function EdsAnalysisDialog({ onClose, onCreateWorkspace }: EdsAnalysisDialogProps) {
  const [source, setSource] = useState<File | null>(null);
  const [template, setTemplate] = useState<File | null>(null);
  const [advancedComparison, setAdvancedComparison] = useState(false);
  const [result, setResult] = useState<EdsAnalysisResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const activeRequestIdRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    dialogRef.current?.focus();
    return () => {
      mountedRef.current = false;
      activeRequestIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  function choose(setter: (file: File | null) => void, file: File) {
    if (!canChooseEdsFile(running, abortRef.current !== null)) return;
    const selection = validateEdsFileSelection(file);
    setError(selection.error);
    setResult(null);
    setter(selection.file);
  }

  async function runAnalysis() {
    if (!source || running || abortRef.current) return;
    if (source.size + (template?.size ?? 0) > EDS_UPLOAD_LIMITS.maxCombinedBytes) {
      setError("上传的工作簿合计不能超过 20 MiB。");
      return;
    }
    setRunning(true);
    setError(null);
    const controller = new AbortController();
    const requestId = activeRequestIdRef.current + 1;
    activeRequestIdRef.current = requestId;
    abortRef.current = controller;
    const isCurrent = () => canApplyEdsRequestResult({
      mounted: mountedRef.current,
      activeRequestId: activeRequestIdRef.current,
      requestId,
      aborted: controller.signal.aborted,
    });
    try {
      const nextResult = await analyzeEdsFiles(source, template, controller.signal);
      if (isCurrent()) setResult(nextResult);
    } catch (caught) {
      if (isCurrent()) setError(caught instanceof EdsClientError ? caught.message : "EDS 工作簿分析失败，请重试。");
    } finally {
      if (isCurrent()) {
        abortRef.current = null;
        setRunning(false);
      }
    }
  }

  function closeOrCancel() {
    if (!abortRef.current) { onClose(); return; }
    activeRequestIdRef.current += 1;
    abortRef.current.abort();
    abortRef.current = null;
    setRunning(false);
    setError("EDS 分析已取消。");
  }

  return (
    <div className="eds-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !running) onClose(); }}>
      <section
        ref={dialogRef}
        className="eds-dialog"
        role="dialog"
        tabIndex={-1}
        aria-modal="true"
        aria-labelledby="eds-dialog-title"
        aria-describedby="eds-dialog-description"
        aria-busy={running}
        onKeyDown={(event) => {
          if (shouldHandleEdsDialogEscape(event.key, event.nativeEvent.isComposing)) {
            event.preventDefault();
            closeOrCancel();
          } else if (event.key === "Tab") {
            const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(
              'button:not([disabled]),a[href],input:not([disabled]):not([hidden]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])',
            ));
            const nextIndex = wrappedEdsDialogFocusIndex(focusable.indexOf(document.activeElement as HTMLElement), focusable.length, event.shiftKey);
            if (focusable.length === 0) {
              event.preventDefault();
              event.currentTarget.focus();
            } else if (nextIndex !== null) {
              event.preventDefault();
              focusable[nextIndex].focus();
            }
          }
        }}
      >
        <header className="eds-dialog-head"><div><small>EDS WORKBOOK</small><h2 id="eds-dialog-title">飞达异常自动分析</h2><p id="eds-dialog-description">只需导入原始明细，服务端使用内置模板与固定规则完成统计、图表汇总和 Excel 导出。</p></div><button type="button" aria-label={running ? "取消分析" : "关闭"} onClick={closeOrCancel}>×</button></header>
        {!result ? (
          <div className="eds-setup">
            <div className={`eds-file-grid${advancedComparison ? "" : " single"}`}>
              <EdsWorkbookPicker label="输入工作簿" description="包含两张原始明细表" file={source} disabled={running} onSelect={(file) => choose(setSource, file)} />
              {advancedComparison && (
                <div id="eds-advanced-comparison" className="eds-advanced-picker">
                  <EdsWorkbookPicker label="验收基准（可选）" description="仅核对生成结果，不改变内置规则" file={template} disabled={running} onSelect={(file) => choose(setTemplate, file)} />
                </div>
              )}
            </div>
            <div className="eds-version-strip" aria-label="当前 EDS 处理版本">
              <span><small>内置报表模板</small><b>{EDS_TEMPLATE_VERSION}</b></span>
              <span><small>固定统计规则</small><b>{EDS_RULE_VERSION}</b></span>
              <button
                type="button"
                aria-expanded={advancedComparison}
                aria-controls="eds-advanced-comparison"
                disabled={running}
                onClick={() => {
                  if (advancedComparison) setTemplate(null);
                  setAdvancedComparison(!advancedComparison);
                  setError(null);
                }}
              >{advancedComparison ? "关闭高级验收" : "高级验收"}</button>
            </div>
            <div className="eds-privacy-note"><b>数据边界</b><span>原始工作簿和逐行明细仅用于本次内存分析，不进入 AI 上下文、localStorage 或审计正文；分析完成后可选择将日期、班次、KPI 与分类汇总生成到工作区。</span></div>
            {error && <EdsErrorMessage message={error} />}
            <button type="button" className="eds-run-button" disabled={!source || running} onClick={() => { void runAnalysis(); }}>{running ? (template ? "正在解析并执行验收比对…" : "正在解析并生成报表…") : "导入并自动分析"}</button>
          </div>
        ) : (
          <>
            <EdsAnalysisResultView result={result} />
            {error && <EdsErrorMessage message={error} />}
            <div className="eds-workspace-actions">
              <div><b>在主界面继续分析</b><small>生成真实数据绑定的 EDS 看板；仅派生汇总会进入 AI 上下文、localStorage 和审计正文。</small></div>
              <button type="button" onClick={() => {
                try {
                  onCreateWorkspace(result);
                } catch (caught) {
                  setError(caught instanceof Error ? caught.message : "EDS 演示看板生成失败。");
                }
              }}>生成 EDS 演示看板</button>
            </div>
            <button type="button" className="eds-reset-button" onClick={() => {
              setSource(null);
              setTemplate(null);
              setAdvancedComparison(false);
              setResult(null);
              setError(null);
            }}>重新选择工作簿</button>
          </>
        )}
      </section>
    </div>
  );
}
