import { afterEach, describe, expect, it, vi } from "vitest";
import { EXCEL_EXPORT_MAX_FILE_BYTES, encodeExcelDownloadFileName, type ExcelExportArtifact } from "./contracts";
import { ExcelDownloadError, fetchExcelExport } from "./client";

const xlsxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

function artifact(): ExcelExportArtifact {
  return {
    id: "download_client_test_001",
    status: "ready",
    fileName: "测试下载.xlsx",
    downloadUrl: "/api/exports/download_client_test_001",
    rowCount: 1,
    fieldCount: 1,
    sizeBytes: xlsxBytes.byteLength,
    createdAt: "2026-09-04T00:00:00.000Z",
    expiresAt: "2026-09-04T00:10:00.000Z",
  };
}

function xlsxResponse(bytes = xlsxBytes, headers: Record<string, string> = {}) {
  return new Response(bytes, {
    headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-length": String(bytes.byteLength),
      "content-disposition": `attachment; filename="analysis.xlsx"; filename*=UTF-8''${encodeExcelDownloadFileName(artifact().fileName)}`,
      ...headers,
    },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Excel 下载客户端", () => {
  it("成功下载前核对 MIME、大小、XLSX 文件头和文件名", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(xlsxResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchExcelExport(artifact());
    expect(result.fileName).toBe("测试下载.xlsx");
    expect(result.blob.size).toBe(xlsxBytes.byteLength);
    expect(result.blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("显示服务端过期消息且不把 JSON 当作工作簿", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
      error: { message: "Excel 文件不存在或下载链接已过期，请重新生成。" },
    }, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchExcelExport(artifact())).rejects.toEqual(new ExcelDownloadError(
      404,
      "Excel 文件不存在或下载链接已过期，请重新生成。",
    ));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("拒绝超限、MIME、文件名、记录大小或文件头不一致", async () => {
    const oversized = xlsxResponse(xlsxBytes, { "content-length": String(EXCEL_EXPORT_MAX_FILE_BYTES + 1) });
    const wrongMime = xlsxResponse(xlsxBytes, { "content-type": "application/json" });
    const wrongFileName = xlsxResponse(xlsxBytes, { "content-disposition": "attachment; filename*=UTF-8''other.xlsx" });
    const wrongSize = xlsxResponse(new Uint8Array([...xlsxBytes, 0]));
    const wrongHeader = xlsxResponse(new Uint8Array([1, 2, 3, 4]));
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(wrongMime)
      .mockResolvedValueOnce(wrongFileName)
      .mockResolvedValueOnce(wrongSize)
      .mockResolvedValueOnce(wrongHeader);
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchExcelExport(artifact())).rejects.toThrow(/过大或读取失败/);
    await expect(fetchExcelExport(artifact())).rejects.toThrow(/响应类型无效/);
    await expect(fetchExcelExport(artifact())).rejects.toThrow(/文件名与生成记录不一致/);
    await expect(fetchExcelExport(artifact())).rejects.toThrow(/大小与生成记录不一致/);
    await expect(fetchExcelExport(artifact())).rejects.toThrow(/不是有效的 XLSX/);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("30 秒超时覆盖收到响应头后的正文读取且不自动重试", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")), { once: true });
      },
    }), { headers: {
      "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename*=UTF-8''${encodeExcelDownloadFileName(artifact().fileName)}`,
    } }));
    vi.stubGlobal("fetch", fetchMock);

    const assertion = expect(fetchExcelExport(artifact()))
      .rejects.toEqual(new ExcelDownloadError(408, "Excel 下载超过 30 秒，已停止等待。"));
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
