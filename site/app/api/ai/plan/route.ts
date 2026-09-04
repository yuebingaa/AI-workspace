import { NextResponse } from "next/server";
import { aiPlanPublicRequestSchema, aiPlanRequestSchema, MAX_AI_REQUEST_BYTES } from "@/core/ai/contracts";
import { AiPlannerError, planChangeSetWithDeepSeek } from "@/core/ai/server/deepseek-planner";
import { aiPlannerRateLimiter } from "@/core/ai/server/rate-limit";
import { DEMO_IDENTITY_RESPONSE_HEADERS, resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { BoundedBodyError, readBoundedUtf8Body } from "@/core/http/server/bounded-body";

export const runtime = "nodejs";
const REQUEST_BODY_TIMEOUT_MS = 15_000;

const noStoreHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "x-content-type-options": "nosniff",
  ...DEMO_IDENTITY_RESPONSE_HEADERS,
};

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
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLocaleLowerCase("en-US");
  if (contentType !== "application/json") {
    return errorResponse(new AiPlannerError("invalid_request", "AI 请求必须使用 application/json。", 415, false));
  }
  if (!aiPlannerRateLimiter.consume(clientKey(request))) {
    return errorResponse(new AiPlannerError("rate_limited", "AI 请求过于频繁，请稍后重试。", 429, true));
  }

  let text: string;
  try {
    text = await readBoundedUtf8Body(request, MAX_AI_REQUEST_BYTES, { signal: request.signal, timeoutMs: REQUEST_BODY_TIMEOUT_MS });
  } catch (error) {
    const tooLarge = error instanceof BoundedBodyError && error.code === "too-large";
    const interrupted = error instanceof BoundedBodyError && (error.code === "timeout" || error.code === "aborted");
    return errorResponse(new AiPlannerError(
      "invalid_request",
      tooLarge ? "AI 请求上下文过大。" : interrupted ? "AI 请求体读取超时或已取消。" : "AI 请求体长度或编码无效。",
      tooLarge ? 413 : interrupted ? 408 : 400,
      interrupted,
    ));
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
