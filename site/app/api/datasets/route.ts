import { CSV_UPLOAD_LIMITS } from "@/core/datasets";
import { CsvDatasetError, parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { DatasetResponseTooLargeError, serializeDatasetResponse } from "@/core/datasets/server/dataset-response";
import { DEMO_IDENTITY_RESPONSE_HEADERS, resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { StudioValidationError } from "@/core/schemas";

export const runtime = "nodejs";
const CSV_UPLOAD_TIMEOUT_MS = 15_000;

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  ...DEMO_IDENTITY_RESPONSE_HEADERS,
};

function jsonError(message: string, status: number) {
  return Response.json({ error: { message } }, { status, headers: noStoreHeaders });
}

export async function persistDatasetResponse(
  identity: Parameters<typeof datasetRepository.put>[0],
  parsed: Parameters<typeof datasetRepository.put>[1],
  maxResponseBytes?: number,
): Promise<string> {
  const serialized = serializeDatasetResponse(parsed, maxResponseBytes);
  await datasetRepository.put(identity, parsed);
  return serialized;
}

export async function GET() {
  try {
    const identity = resolveDemoRequestIdentity();
    return Response.json({ datasets: await datasetRepository.list(identity) }, { headers: noStoreHeaders });
  } catch {
    return jsonError("读取上传数据集列表失败。", 500);
  }
}

export async function POST(request: Request) {
  const declaredLengthHeader = request.headers.get("content-length");
  if (declaredLengthHeader !== null && !/^\d+$/u.test(declaredLengthHeader.trim())) {
    return jsonError("Content-Length 请求头无效。", 400);
  }
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength > CSV_UPLOAD_LIMITS.maxFileBytes)) {
    return jsonError("CSV 文件超过 10 MiB 限制。", 413);
  }
  if (!request.body) return jsonError("CSV 上传内容为空。", 400);
  const originalFileName = request.headers.get("x-file-name") ?? "";
  const mimeType = request.headers.get("content-type") ?? "";
  try {
    const identity = resolveDemoRequestIdentity();
    const parsed = await parseCsvUpload({
      stream: request.body,
      originalFileName,
      mimeType,
      signal: request.signal,
      timeoutMs: CSV_UPLOAD_TIMEOUT_MS,
    });
    const serialized = await persistDatasetResponse(identity, parsed);
    return new Response(serialized, {
      status: 201,
      headers: { ...noStoreHeaders, "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    if (error instanceof CsvDatasetError) return jsonError(error.message, error.status);
    if (error instanceof DatasetResponseTooLargeError) return jsonError(error.message, 413);
    if (error instanceof StudioValidationError) return jsonError(error.message, 409);
    return jsonError("CSV 上传处理失败，请检查文件后重试。", 500);
  }
}
