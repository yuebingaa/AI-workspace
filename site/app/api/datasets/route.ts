import { CSV_UPLOAD_LIMITS } from "@/core/datasets";
import { CsvDatasetError, parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { DEMO_IDENTITY_RESPONSE_HEADERS, resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { StudioValidationError } from "@/core/schemas";

export const runtime = "nodejs";

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  ...DEMO_IDENTITY_RESPONSE_HEADERS,
};

function jsonError(message: string, status: number) {
  return Response.json({ error: { message } }, { status, headers: noStoreHeaders });
}

export async function GET() {
  const identity = resolveDemoRequestIdentity();
  return Response.json({ datasets: await datasetRepository.list(identity) }, { headers: noStoreHeaders });
}

export async function POST(request: Request) {
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > CSV_UPLOAD_LIMITS.maxFileBytes) return jsonError("CSV 文件超过 10 MiB 限制。", 413);
  if (!request.body) return jsonError("CSV 上传内容为空。", 400);
  const originalFileName = request.headers.get("x-file-name") ?? "";
  const mimeType = request.headers.get("content-type") ?? "";
  try {
    const identity = resolveDemoRequestIdentity();
    const parsed = await parseCsvUpload({ stream: request.body, originalFileName, mimeType });
    const stored = await datasetRepository.put(identity, parsed);
    return Response.json({ dataset: stored.descriptor, rows: stored.rows }, { status: 201, headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof CsvDatasetError) return jsonError(error.message, error.status);
    if (error instanceof StudioValidationError) return jsonError(error.message, 409);
    return jsonError("CSV 上传处理失败，请检查文件后重试。", 500);
  }
}
