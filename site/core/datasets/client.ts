import {
  datasetConsentResponseSchema,
  datasetUploadResponseSchema,
  type DatasetUploadResponse,
  type UploadedDatasetDescriptor,
} from "./contracts";

export type CsvUploadPhase = "uploading" | "parsing" | "validating";

export interface CsvUploadProgress {
  phase: CsvUploadPhase;
  percent: number;
}

export class DatasetClientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "DatasetClientError";
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
  const promise = new Promise<DatasetUploadResponse>((resolve, reject) => {
    xhr.open("POST", "/api/datasets");
    xhr.setRequestHeader("content-type", file.type || "text/csv");
    xhr.setRequestHeader("x-file-name", encodeURIComponent(file.name));
    xhr.responseType = "text";
    xhr.upload.onprogress = (event) => {
      const percent = event.lengthComputable ? Math.min(99, Math.round((event.loaded / event.total) * 100)) : 0;
      onProgress({ phase: "uploading", percent });
    };
    xhr.upload.onload = () => onProgress({ phase: "parsing", percent: 100 });
    xhr.onload = () => {
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
    xhr.onabort = () => reject(new DatasetClientError(0, "CSV 上传已取消。"));
    onProgress({ phase: "uploading", percent: 0 });
    xhr.send(file);
  });
  return { promise, cancel: () => xhr.abort() };
}

async function parsedResponse(response: Response): Promise<DatasetUploadResponse> {
  const text = await response.text();
  if (!response.ok) throw new DatasetClientError(response.status, errorMessage(text, "上传数据集读取失败。"));
  try { return datasetUploadResponseSchema.parse(JSON.parse(text) as unknown); } catch {
    throw new DatasetClientError(502, "服务端返回的上传数据集结构无效。");
  }
}

export async function loadUploadedDataset(datasetId: string, signal?: AbortSignal): Promise<DatasetUploadResponse> {
  return parsedResponse(await fetch(`/api/datasets/${encodeURIComponent(datasetId)}`, { cache: "no-store", signal }));
}

export async function confirmDatasetAiAccess(
  datasetId: string,
  policy: "masked" | "exclude-sensitive-samples",
): Promise<UploadedDatasetDescriptor> {
  const response = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}/consent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ policy }),
  });
  const text = await response.text();
  if (!response.ok) throw new DatasetClientError(response.status, errorMessage(text, "敏感字段处理方式保存失败。"));
  try { return datasetConsentResponseSchema.parse(JSON.parse(text) as unknown).dataset; } catch {
    throw new DatasetClientError(502, "服务端返回的数据集确认状态无效。");
  }
}

export async function deleteUploadedDataset(datasetId: string): Promise<void> {
  const response = await fetch(`/api/datasets/${encodeURIComponent(datasetId)}`, { method: "DELETE" });
  if (response.status === 204 || response.status === 404) return;
  const text = await response.text();
  throw new DatasetClientError(response.status, errorMessage(text, "删除上传数据集失败。"));
}
