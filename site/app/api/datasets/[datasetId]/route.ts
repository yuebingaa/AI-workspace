import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { DatasetResponseTooLargeError, serializeDatasetResponse } from "@/core/datasets/server/dataset-response";
import { DEMO_IDENTITY_RESPONSE_HEADERS, resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";

export const runtime = "nodejs";

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  ...DEMO_IDENTITY_RESPONSE_HEADERS,
};
const datasetIdPattern = /^dataset_upload_[A-Za-z0-9_-]{16,160}$/u;

function datasetIdFrom(request: Request): string {
  return new URL(request.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
}

function invalidId() {
  return Response.json({ error: { message: "上传数据集标识无效。" } }, { status: 400, headers: noStoreHeaders });
}

export async function GET(request: Request) {
  const datasetId = datasetIdFrom(request);
  if (!datasetIdPattern.test(datasetId)) return invalidId();
  try {
    const stored = await datasetRepository.get(resolveDemoRequestIdentity(), datasetId);
    if (!stored) return Response.json({ error: { message: "上传数据集不存在或已过期。" } }, { status: 404, headers: noStoreHeaders });
    return new Response(serializeDatasetResponse({ dataset: stored.descriptor, rows: stored.rows }), {
      headers: { ...noStoreHeaders, "content-type": "application/json; charset=utf-8" },
    });
  } catch (error) {
    if (error instanceof DatasetResponseTooLargeError) {
      return Response.json({ error: { message: error.message } }, { status: 413, headers: noStoreHeaders });
    }
    return Response.json({ error: { message: "读取上传数据集失败。" } }, { status: 500, headers: noStoreHeaders });
  }
}

export async function DELETE(request: Request) {
  const datasetId = datasetIdFrom(request);
  if (!datasetIdPattern.test(datasetId)) return invalidId();
  try {
    const deleted = await datasetRepository.delete(resolveDemoRequestIdentity(), datasetId);
    return new Response(null, { status: deleted ? 204 : 404, headers: noStoreHeaders });
  } catch {
    return Response.json({ error: { message: "删除上传数据集失败。" } }, { status: 500, headers: noStoreHeaders });
  }
}
