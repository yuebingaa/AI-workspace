import { datasetRepository } from "@/core/datasets/server/dataset-repository";

export const runtime = "nodejs";

const noStoreHeaders = { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff" };
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
  const stored = datasetRepository.get(datasetId);
  if (!stored) return Response.json({ error: { message: "上传数据集不存在或已过期。" } }, { status: 404, headers: noStoreHeaders });
  return Response.json({ dataset: stored.descriptor, rows: stored.rows }, { headers: noStoreHeaders });
}

export async function DELETE(request: Request) {
  const datasetId = datasetIdFrom(request);
  if (!datasetIdPattern.test(datasetId)) return invalidId();
  const deleted = datasetRepository.delete(datasetId);
  return new Response(null, { status: deleted ? 204 : 404, headers: noStoreHeaders });
}
