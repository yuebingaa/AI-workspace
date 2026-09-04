"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ExcelExportArtifact } from "@/core/exports/contracts";
import { ExcelDownloadError, fetchExcelExport } from "@/core/exports/client";

export function remainingExcelExportLifetimeMs(expiresAt: string, nowMs: number): number {
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) ? Math.max(0, expiresAtMs - nowMs) : 0;
}

export function canStartExcelExportDownload(hasActiveRequest: boolean, serverConfirmedExpired: boolean): boolean {
  return !hasActiveRequest && !serverConfirmedExpired;
}

export function isServerConfirmedExcelExportExpiry(error: unknown): boolean {
  return error instanceof ExcelDownloadError && error.status === 404;
}

export function canApplyExcelDownloadResult(input: {
  mounted: boolean;
  activeRequestMatches: boolean;
  aborted: boolean;
  requestArtifactId: string;
  currentArtifactId: string;
}): boolean {
  return input.mounted
    && input.activeRequestMatches
    && !input.aborted
    && input.requestArtifactId === input.currentArtifactId;
}

export function triggerBrowserDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | null = null;
  try {
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function ExcelDownloadButton({ artifact, label }: { artifact: ExcelExportArtifact; label: string }) {
  const [activeRequest, setActiveRequest] = useState<{ artifactId: string; controller: AbortController } | null>(null);
  const [error, setError] = useState<{ artifactId: string; message: string } | null>(null);
  const [expiredArtifactId, setExpiredArtifactId] = useState<string | null>(null);
  const [locallyExpiredArtifactId, setLocallyExpiredArtifactId] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const artifactIdRef = useRef(artifact.id);
  const busy = activeRequest?.artifactId === artifact.id && !activeRequest.controller.signal.aborted;
  const serverExpired = expiredArtifactId === artifact.id;
  const locallyExpired = locallyExpiredArtifactId === artifact.id;
  const displayedError = error?.artifactId === artifact.id ? error.message : null;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);
  useEffect(() => {
    const remainingMs = remainingExcelExportLifetimeMs(artifact.expiresAt, Date.now());
    const timer = setTimeout(() => setLocallyExpiredArtifactId(artifact.id), remainingMs);
    return () => clearTimeout(timer);
  }, [artifact.expiresAt, artifact.id]);
  useLayoutEffect(() => {
    artifactIdRef.current = artifact.id;
    return () => {
      const controller = abortRef.current;
      abortRef.current = null;
      controller?.abort();
    };
  }, [artifact.id]);

  async function download() {
    const hasActiveRequest = abortRef.current !== null;
    if (!canStartExcelExportDownload(hasActiveRequest, serverExpired)) return;
    const controller = new AbortController();
    const requestArtifactId = artifact.id;
    abortRef.current = controller;
    setActiveRequest({ artifactId: requestArtifactId, controller });
    setError(null);
    const isCurrent = () => canApplyExcelDownloadResult({
      mounted: mountedRef.current,
      activeRequestMatches: abortRef.current === controller,
      aborted: controller.signal.aborted,
      requestArtifactId,
      currentArtifactId: artifactIdRef.current,
    });
    try {
      const result = await fetchExcelExport(artifact, controller.signal);
      if (isCurrent()) triggerBrowserDownload(result.blob, result.fileName);
    } catch (caught) {
      if (isCurrent()) {
        if (isServerConfirmedExcelExportExpiry(caught)) setExpiredArtifactId(requestArtifactId);
        setError({ artifactId: requestArtifactId, message: caught instanceof ExcelDownloadError ? caught.message : "Excel 下载失败。" });
      }
    } finally {
      if (mountedRef.current && abortRef.current === controller) {
        abortRef.current = null;
        setActiveRequest((current) => current?.controller === controller ? null : current);
      }
    }
  }

  return (
    <span className="excel-download-control">
      <button
        type="button"
        data-download-url={artifact.downloadUrl}
        disabled={busy || serverExpired}
        aria-busy={busy}
        aria-live="polite"
        onClick={() => { void download(); }}
      >
        {serverExpired ? "下载已过期" : busy ? "正在下载…" : locallyExpired ? "验证并下载" : label}
      </button>
      {displayedError
        ? <small role="alert" aria-live="assertive" aria-atomic="true">{displayedError}</small>
        : serverExpired
          ? <small role="status" aria-live="polite" aria-atomic="true">下载链接已过期，请重新生成。</small>
          : locallyExpired && <small role="status" aria-live="polite" aria-atomic="true">本地时间显示链接可能到期，点击后将由服务端确认。</small>}
    </span>
  );
}
