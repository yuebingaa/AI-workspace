import { MAX_DATASET_RESPONSE_BYTES, type DatasetUploadResponse } from "../contracts";

export class DatasetResponseTooLargeError extends Error {
  constructor() {
    super("上传数据集响应超过 32 MiB 限制，请减少行数、列数或字段名长度。");
    this.name = "DatasetResponseTooLargeError";
  }
}

export function serializeDatasetResponse(
  dataset: DatasetUploadResponse,
  maxBytes = MAX_DATASET_RESPONSE_BYTES,
): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_DATASET_RESPONSE_BYTES) {
    throw new Error("数据集响应大小限制必须是有效且不可放宽的正整数");
  }
  const serialized = JSON.stringify({ dataset: dataset.dataset, rows: dataset.rows });
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new DatasetResponseTooLargeError();
  return serialized;
}
