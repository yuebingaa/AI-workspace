import { BoundedBinaryError, readBoundedBinaryBody } from "@/core/http/bounded-binary";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import {
  EXCEL_EXPORT_MAX_FILE_BYTES,
  encodeExcelDownloadFileName,
  excelExportArtifactSchema,
  type ExcelExportArtifact,
} from "./contracts";

const EXCEL_DOWNLOAD_TIMEOUT_MS = 30_000;
const MAX_DOWNLOAD_ERROR_BYTES = 16 * 1024;
const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export class ExcelDownloadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ExcelDownloadError";
  }
}

async function responseError(response: Response): Promise<string> {
  try {
    const text = await readBoundedUtf8Body(response, MAX_DOWNLOAD_ERROR_BYTES);
    const payload = JSON.parse(text) as { error?: { message?: unknown } };
    return typeof payload.error?.message === "string" ? payload.error.message : "Excel 下载失败。";
  } catch {
    return "Excel 下载失败。";
  }
}

export async function fetchExcelExport(
  input: ExcelExportArtifact,
  signal?: AbortSignal,
): Promise<{ blob: Blob; fileName: string }> {
  const parsed = excelExportArtifactSchema.safeParse(input);
  if (!parsed.success) throw new ExcelDownloadError(400, "Excel 下载元数据无效。");
  const artifact = parsed.data;
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, EXCEL_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(artifact.downloadUrl, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new ExcelDownloadError(response.status, await responseError(response));
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
    if (mimeType !== XLSX_MIME_TYPE) throw new ExcelDownloadError(502, "Excel 下载响应类型无效。");
    const expectedFileName = `filename*=UTF-8''${encodeExcelDownloadFileName(artifact.fileName)}`;
    const dispositionParts = response.headers.get("content-disposition")?.split(";").map((part) => part.trim()) ?? [];
    if (!dispositionParts.includes(expectedFileName)) {
      throw new ExcelDownloadError(502, "Excel 下载响应文件名与生成记录不一致。");
    }
    const bytes = await readBoundedBinaryBody(response, EXCEL_EXPORT_MAX_FILE_BYTES);
    if (bytes.byteLength !== artifact.sizeBytes) throw new ExcelDownloadError(502, "Excel 下载文件大小与生成记录不一致。");
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw new ExcelDownloadError(502, "Excel 下载内容不是有效的 XLSX 文件。");
    const blobBytes = new Uint8Array(bytes.byteLength);
    blobBytes.set(bytes);
    return { blob: new Blob([blobBytes.buffer], { type: XLSX_MIME_TYPE }), fileName: artifact.fileName };
  } catch (error) {
    if (timedOut) throw new ExcelDownloadError(408, "Excel 下载超过 30 秒，已停止等待。");
    if (signal?.aborted) throw error;
    if (error instanceof ExcelDownloadError) throw error;
    if (error instanceof BoundedBinaryError) throw new ExcelDownloadError(502, "Excel 下载响应过大或读取失败。");
    throw new ExcelDownloadError(0, "Excel 下载网络连接失败。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
