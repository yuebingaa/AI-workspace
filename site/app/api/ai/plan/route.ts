import { NextResponse } from "next/server";
import { aiPlanPublicRequestSchema, aiPlanRequestSchema, MAX_AI_REQUEST_BYTES } from "@/core/ai/contracts";
import { AiPlannerError, planChangeSetWithDeepSeek } from "@/core/ai/server/deepseek-planner";
import { aiPlannerRateLimiter } from "@/core/ai/server/rate-limit";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";

export const runtime = "nodejs";

const noStoreHeaders = { "cache-control": "no-store" };

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (forwarded || request.headers.get("x-real-ip") || "local").slice(0, 120);
}

function errorResponse(error: AiPlannerError) {
  return NextResponse.json({
    error: { code: error.code, message: error.message, retryable: error.retryable },
    ...(error.metadata ? { metadata: error.metadata } : {}),
  }, { status: error.status, headers: noStoreHeaders });
}

export async function POST(request: Request) {
  if (!aiPlannerRateLimiter.consume(clientKey(request))) {
    return errorResponse(new AiPlannerError("rate_limited", "AI 请求过于频繁，请稍后重试。", 429, true));
  }

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_AI_REQUEST_BYTES) {
    return errorResponse(new AiPlannerError("invalid_request", "AI 请求上下文过大。", 413, false));
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_AI_REQUEST_BYTES) {
    return errorResponse(new AiPlannerError("invalid_request", "AI 请求上下文过大。", 413, false));
  }

  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return errorResponse(new AiPlannerError("invalid_request", "AI 请求体不是有效 JSON。", 400, false));
  }

  try {
    const publicRequest = aiPlanPublicRequestSchema.safeParse(body);
    if (!publicRequest.success) {
      return errorResponse(new AiPlannerError("invalid_request", "AI 请求格式不正确。", 400, false));
    }
    const identity = resolveDemoRequestIdentity();
    const serverRequest = aiPlanRequestSchema.parse({ ...publicRequest.data, role: identity.role });
    const result = await planChangeSetWithDeepSeek(serverRequest, {
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL,
      signal: request.signal,
    });
    return NextResponse.json(result, { status: 200, headers: noStoreHeaders });
  } catch (error) {
    if (error instanceof AiPlannerError) return errorResponse(error);
    return errorResponse(new AiPlannerError("service_unavailable", "AI 服务暂时不可用，请稍后重试。", 503, true));
  }
}
