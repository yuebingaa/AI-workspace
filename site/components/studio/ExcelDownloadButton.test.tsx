// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExcelExportArtifact } from "@/core/exports/contracts";
import { canApplyExcelDownloadResult, canStartExcelExportDownload, ExcelDownloadButton, isServerConfirmedExcelExportExpiry, remainingExcelExportLifetimeMs, triggerBrowserDownload } from "./ExcelDownloadButton";
import { ExcelDownloadError, fetchExcelExport } from "@/core/exports/client";

vi.mock("@/core/exports/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/core/exports/client")>();
  return { ...actual, fetchExcelExport: vi.fn() };
});

const mountedRoots: Root[] = [];
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const artifact: ExcelExportArtifact = {
  id: "download_button_test_001",
  status: "ready",
  fileName: "下载按钮.xlsx",
  downloadUrl: "/api/exports/download_button_test_001",
  rowCount: 1,
  fieldCount: 1,
  sizeBytes: 4,
  createdAt: "2026-09-04T00:00:00.000Z",
  expiresAt: "2026-09-04T00:10:00.000Z",
};

afterEach(() => {
  while (mountedRoots.length) act(() => mountedRoots.pop()!.unmount());
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("ExcelDownloadButton", () => {
  it("按工件到期时间计算单调非负的剩余时长", () => {
    expect(remainingExcelExportLifetimeMs("2026-09-04T00:10:00.000Z", Date.parse("2026-09-04T00:00:00.000Z"))).toBe(600_000);
    expect(remainingExcelExportLifetimeMs("2026-09-04T00:10:00.000Z", Date.parse("2026-09-04T00:10:01.000Z"))).toBe(0);
    expect(remainingExcelExportLifetimeMs("invalid", 0)).toBe(0);
  });

  it("本地墙钟不阻断下载，只有活动请求或服务端确认过期才阻断", () => {
    expect(canStartExcelExportDownload(false, false)).toBe(true);
    expect(canStartExcelExportDownload(true, false)).toBe(false);
    expect(canStartExcelExportDownload(false, true)).toBe(false);
    expect(isServerConfirmedExcelExportExpiry(new ExcelDownloadError(404, "已过期"))).toBe(true);
    expect(isServerConfirmedExcelExportExpiry(new ExcelDownloadError(408, "超时"))).toBe(false);
    expect(isServerConfirmedExcelExportExpiry(new Error("网络失败"))).toBe(false);
  });

  it("旧工件、旧控制器、取消或卸载后的结果都不能写回", () => {
    const baseline = {
      mounted: true,
      activeRequestMatches: true,
      aborted: false,
      requestArtifactId: "artifact-a",
      currentArtifactId: "artifact-a",
    };
    expect(canApplyExcelDownloadResult(baseline)).toBe(true);
    expect(canApplyExcelDownloadResult({ ...baseline, mounted: false })).toBe(false);
    expect(canApplyExcelDownloadResult({ ...baseline, activeRequestMatches: false })).toBe(false);
    expect(canApplyExcelDownloadResult({ ...baseline, aborted: true })).toBe(false);
    expect(canApplyExcelDownloadResult({ ...baseline, currentArtifactId: "artifact-b" })).toBe(false);
  });

  it("服务端渲染保留按钮文案与可追踪下载地址", () => {
    const html = renderToStaticMarkup(<ExcelDownloadButton artifact={artifact} label="下载 Excel" />);
    expect(html).toContain("下载 Excel");
    expect(html).toContain('data-download-url="/api/exports/download_button_test_001"');
    expect(html).toContain('aria-busy="false"');
    expect(html).toContain('aria-live="polite"');
  });

  it("切换工件会隔离忽略取消的旧请求并立即允许新下载", async () => {
    vi.mocked(fetchExcelExport).mockImplementation(async () => new Promise<never>(() => undefined));
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    mountedRoots.push(root);
    act(() => root.render(<ExcelDownloadButton artifact={artifact} label="下载 Excel" />));
    const button = container.querySelector("button")!;

    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(fetchExcelExport).toHaveBeenCalledTimes(1);
    const firstSignal = vi.mocked(fetchExcelExport).mock.calls[0][1];
    if (!firstSignal) throw new Error("first download signal missing");
    expect(firstSignal.aborted).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("true");

    const nextArtifact: ExcelExportArtifact = {
      ...artifact,
      id: "download_button_test_002",
      downloadUrl: "/api/exports/download_button_test_002",
    };
    act(() => root.render(<ExcelDownloadButton artifact={nextArtifact} label="下载新 Excel" />));
    expect(firstSignal.aborted).toBe(true);
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-busy")).toBe("false");

    await act(async () => {
      button.click();
      await Promise.resolve();
    });
    expect(fetchExcelExport).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetchExcelExport).mock.calls[1][0].id).toBe(nextArtifact.id);
    const secondSignal = vi.mocked(fetchExcelExport).mock.calls[1][1];
    if (!secondSignal) throw new Error("second download signal missing");
    expect(secondSignal.aborted).toBe(false);
  });

  it("浏览器锚点点击抛错时仍移除节点并释放 Blob URL", () => {
    vi.useFakeTimers();
    const remove = vi.fn();
    const click = vi.fn(() => { throw new Error("synthetic click failure"); });
    const appendChild = vi.fn();
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("document", {
      createElement: () => ({ href: "", download: "", click, remove }),
      body: { appendChild },
    });
    vi.stubGlobal("URL", { createObjectURL: () => "blob:synthetic", revokeObjectURL });

    expect(() => triggerBrowserDownload(new Blob(["PK"]), "测试.xlsx")).toThrow(/click failure/);
    expect(appendChild).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:synthetic");
  });
});
