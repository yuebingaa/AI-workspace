import {
  datasetConsentResponseSchema,
  datasetUploadResponseSchema,
  MAX_DATASET_RESPONSE_BYTES,
  type DatasetUploadResponse,
  type UploadedDatasetDescriptor,
} from "./contracts";
import { BoundedBodyError, readBoundedUtf8Body } from "@/core/http/server/bounded-body";

export type CsvUploadPhase = "uploading" | "parsing" | "validating";

export interface CsvUploadProgress {
  phase: CsvUploadPhase;
  percent: number;
}

const CSV_UPLOAD_TIMEOUT_MS = 60_000;
const DATASET_REQUEST_TIMEOUT_MS = 30_000;
export { MAX_DATASET_RESPONSE_BYTES } from "./contracts";

export class DatasetClientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DatasetClientError";
  }
}

async function fetchDatasetText(
  input: RequestInfo | URL,
  init: RequestInit,
  messages: { timeout: string; network: string; response: string },
  signal?: AbortSignal,
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, DATASET_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    const text = await readBoundedUtf8Body(response, MAX_DATASET_RESPONSE_BYTES);
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    if (timedOut) throw new DatasetClientError(408, messages.timeout);
    if (signal?.aborted) throw error;
    if (error instanceof BoundedBodyError) throw new DatasetClientError(502, messages.response);
    throw new DatasetClientError(0, messages.network);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export class DatasetAiAccessConflictError extends DatasetClientError {
  constructor(message: string, readonly currentDataset: UploadedDatasetDescriptor) {
    super(409, message);
    this.name = "DatasetAiAccessConflictError";
  }
}

function errorMessage(responseText: string, fallback: string): string {
  try {
    const parsed = JSON.parse(responseText) as { error?: { message?: unknown } };
    return typeof parsed.error?.message === "string" ? parsed.error.message : fallback;
  } catch {
    return fallback;
  }
}

export function uploadCsvDataset(
  file: File,
  onProgress: (progress: CsvUploadProgress) => void,
): { promise: Promise<DatasetUploadResponse>; cancel(): void } {
  const xhr = new XMLHttpRequest();
  let responseTooLarge = false;
  const promise = new Promise<DatasetUploadResponse>((resolve, reject) => {
    xhr.open("POST", "/api/datasets");
    xhr.setRequestHeader("content-type", file.type || "text/csv");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.responseType = "text";
    xhr.timeout = CSV_UPLOAD_TIMEOUT_MS;
    xhr.upload.onprogress = (event) => {
      const percent = event.lengthComputable ? Math.min(99, Math.round((event.loaded / event.total) * 100)) : 0;
      onProgress({ phase: "uploading", percent });
    };
    xhr.upload.onload = () => onProgress({ phase: "parsing", percent: 100 });
    xhr.onprogress = (event) => {
      if (event.loaded > MAX_DATASET_RESPONSE_BYTES) {
        responseTooLarge = true;
        xhr.abort();
      }
    };
    xhr.onload = () => {
      const declaredLength = xhr.getResponseHeader("content-length");
      if (
        responseTooLarge
        || xhr.responseText.length > MAX_DATASET_RESPONSE_BYTES
        || (declaredLength !== null && /^\d+$/u.test(declaredLength) && Number(declaredLength) > MAX_DATASET_RESPONSE_BYTES)
      ) {
        reject(new DatasetClientError(502, "CSV 上传响应超过 32 MiB 限制。"));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new DatasetClientError(xhr.status, errorMessage(xhr.responseText, "CSV 上传失败。")));
        return;
      }
      onProgress({ phase: "validating", percent: 100 });
      try {
        resolve(datasetUploadResponseSchema.parse(JSON.parse(xhr.responseText) as unknown));
      } catch {
        reject(new DatasetClientError(502, "服务端返回的 CSV 数据集结构无效。"));
      }
    };
    xhr.onerror = () => reject(new DatasetClientError(0, "CSV 上传网络连接失败。"));
    xhr.onabort = () => reject(responseTooLarge
      ? new DatasetClientError(502, "CSV 上传响应超过 32 MiB 限制。")
      : new DatasetClientError(0, "CSV 上传已取消。"));
    xhr.ontimeout = () => reject(new DatasetClientError(408, "CSV 上传超过 60 秒，已停止等待。"));
    onProgress({ phase: "uploading", percent: 0 });
    xhr.send(file);
  });
  return { promise, cancel: () => xhr.abort() };
}

async function parsedResponse(response: { ok: boolean; status: number; text: string }): Promise<DatasetUploadResponse> {
  if (!response.ok) throw new DatasetClientError(response.status, errorMessage(response.text, "上传数据集读取失败。"));
  try { return datasetUploadResponseSchema.parse(JSON.parse(response.text) as unknown); } catch {
    throw new DatasetClientError(502, "服务端返回的上传数据集结构无效。");
  }
}

export async function loadUploadedDataset(datasetId: string, signal?: AbortSignal): Promise<DatasetUploadResponse> {
  return parsedResponse(await fetchDatasetText(
    `/api/datasets/${encodeURIComponent(datasetId)}`,
    { cache: "no-store" },
    {
      timeout: "读取上传数据集超过 30 秒，已停止等待。",
      network: "读取上传数据集时网络连接失败。",
      response: "读取上传数据集的服务端响应过大或无效。",
    },
    signal,
  ));
}

export async function confirmDatasetAiAccess(
  datasetId: string,
  policy: "masked" | "exclude-sensitive-samples",
): Promise<UploadedDatasetDescriptor> {
  const response = await fetchDatasetText(`/api/datasets/${encodeURIComponent(datasetId)}/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ policy }),
  }, {
    timeout: "保存敏感字段处理方式超过 30 秒，已停止等待。",
    network: "保存敏感字段处理方式时网络连接失败。",
    response: "保存敏感字段处理方式的服务端响应过大或无效。",
  });
  if (!response.ok) {
    const message = errorMessage(response.text, "敏感字段处理方式保存失败。");
    if (response.status === 409) {
      try {
        const current = await loadUploadedDataset(datasetId);
        throw new DatasetAiAccessConflictError(message, current.dataset);
      } catch (error) {
        if (error instanceof DatasetAiAccessConflictError) throw error;
      }
    }
    throw new DatasetClientError(response.status, message);
  }
  try { return datasetConsentResponseSchema.parse(JSON.parse(response.text) as unknown).dataset; } catch {
    throw new DatasetClientError(502, "服务端返回的数据集确认状态无效。");
  }
}

export async function deleteUploadedDataset(datasetId: string): Promise<void> {
  const response = await fetchDatasetText(`/api/datasets/${encodeURIComponent(datasetId)}`, { method: "DELETE" }, {
    timeout: "删除上传数据集超过 30 秒，已停止等待。",
    network: "删除上传数据集时网络连接失败。",
    response: "删除上传数据集的服务端响应过大或无效。",
  });
  if (response.status === 204 || response.status === 404) return;
  throw new DatasetClientError(response.status, errorMessage(response.text, "删除上传数据集失败。"));
}
