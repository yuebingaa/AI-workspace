import { datasetConsentRequestSchema } from "@/core/datasets";
import {
  DatasetAiAccessPolicyConflictError,
  datasetRepository,
} from "@/core/datasets/server/dataset-repository";
import { DEMO_IDENTITY_RESPONSE_HEADERS, resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { BoundedBodyError, readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { StudioValidationError } from "@/core/schemas";

export const runtime = "nodejs";

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  ...DEMO_IDENTITY_RESPONSE_HEADERS,
};
const datasetIdPattern = /^dataset_upload_[A-Za-z0-9_-]{16,160}$/u;
const MAX_CONSENT_BODY_BYTES = 1_024;
const CONSENT_BODY_TIMEOUT_MS = 15_000;

export async function POST(request: Request) {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const datasetId = segments.at(-2) ?? "";
  if (!datasetIdPattern.test(datasetId)) {
    return Response.json({ error: { message: "上传数据集标识无效。" } }, { status: 400, headers: noStoreHeaders });
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
  if (contentType !== "application/json") {
    return Response.json({ error: { message: "敏感字段确认请求必须使用 application/json。" } }, { status: 415, headers: noStoreHeaders });
  }
  const declaredLengthHeader = request.headers.get("content-length");
  if (declaredLengthHeader !== null && !/^\d+$/u.test(declaredLengthHeader.trim())) {
    return Response.json({ error: { message: "Content-Length 请求头无效。" } }, { status: 400, headers: noStoreHeaders });
  }
  const declaredLength = declaredLengthHeader === null ? null : Number(declaredLengthHeader);
  if (declaredLength !== null && (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_CONSENT_BODY_BYTES)) {
    return Response.json({ error: { message: "敏感字段确认请求过大。" } }, { status: 413, headers: noStoreHeaders });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(await readBoundedUtf8Body(request, MAX_CONSENT_BODY_BYTES, {
      signal: request.signal,
      timeoutMs: CONSENT_BODY_TIMEOUT_MS,
    })) as unknown;
  } catch (error) {
    if (error instanceof BoundedBodyError && error.code === "too-large") {
      return Response.json({ error: { message: "敏感字段确认请求过大。" } }, { status: 413, headers: noStoreHeaders });
    }
    if (error instanceof BoundedBodyError && (error.code === "timeout" || error.code === "aborted")) {
      return Response.json({ error: { message: "敏感字段确认请求读取超时或已取消。" } }, { status: 408, headers: noStoreHeaders });
    }
    raw = null;
  }
  const parsed = datasetConsentRequestSchema.safeParse(raw);
  if (!parsed.success) return Response.json({ error: { message: "敏感字段处理方式无效。" } }, { status: 400, headers: noStoreHeaders });
  try {
    const dataset = await datasetRepository.setAiAccessPolicy(resolveDemoRequestIdentity(), datasetId, parsed.data.policy);
    return Response.json({ dataset }, { headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof DatasetAiAccessPolicyConflictError) {
      return Response.json({ error: { message: error.message } }, { status: 409, headers: noStoreHeaders });
    }
    if (error instanceof StudioValidationError) {
      return Response.json({ error: { message: error.message } }, { status: 404, headers: noStoreHeaders });
    }
    return Response.json({ error: { message: "敏感字段处理方式保存失败。" } }, { status: 500, headers: noStoreHeaders });
  }
}
