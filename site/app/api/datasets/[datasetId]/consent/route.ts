import { datasetConsentRequestSchema } from "@/core/datasets";
import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { StudioValidationError } from "@/core/schemas";

export const runtime = "nodejs";

const noStoreHeaders = { "cache-control": "private, no-store, max-age=0", "x-content-type-options": "nosniff" };
const datasetIdPattern = /^dataset_upload_[A-Za-z0-9_-]{16,160}$/u;

export async function POST(request: Request) {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const datasetId = segments.at(-2) ?? "";
  if (!datasetIdPattern.test(datasetId)) {
    return Response.json({ error: { message: "上传数据集标识无效。" } }, { status: 400, headers: noStoreHeaders });
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > 1_024) return Response.json({ error: { message: "敏感字段确认请求过大。" } }, { status: 413, headers: noStoreHeaders });
  let raw: unknown;
  try { raw = await request.json(); } catch { raw = null; }
  const parsed = datasetConsentRequestSchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: { message: "敏感字段处理方式无效。" } }, { status: 400, headers: noStoreHeaders });
  try {
    const dataset = datasetRepository.setAiAccessPolicy(datasetId, parsed.data.policy);
    return Response.json({ dataset }, { headers: noStoreHeaders });
  } catch (error) {
    const message = error instanceof StudioValidationError ? error.message : "敏感字段处理方式保存失败。";
    return Response.json({ error: { message } }, { status: 404, headers: noStoreHeaders });
  }
}
