import { NextResponse } from "next/server";
import { aiPlannerRateLimiter } from "@/core/ai/server/rate-limit";
import {
  DeepSeekHarness,
  HarnessIdempotencyConflictError,
  HarnessIdempotencyStore,
  HarnessRequestError,
} from "@/core/harness/deepseek-harness";
import {
  MAX_HARNESS_REQUEST_BYTES,
  harnessRequestSchema,
} from "@/core/harness/contracts";
import { demoFixtureResult } from "@/fixtures/demo-product";

export const runtime = "nodejs";

const noStoreHeaders = { "cache-control": "no-store" };
const harness = new DeepSeekHarness();
const idempotencyStore = new HarnessIdempotencyStore();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `harness:${(forwarded || request.headers.get("x-real-ip") || "local").slice(0, 110)}`;
}

function error(message: string, status: number) {
  return NextResponse.json({ error: { message } }, { status, headers: noStoreHeaders });
}

export async function POST(request: Request) {
  if (!aiPlannerRateLimiter.consume(clientKey(request))) return error("Harness 请求过于频繁，请稍后重试。", 429);
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_HARNESS_REQUEST_BYTES) return error("Harness 请求上下文过大。", 413);
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_HARNESS_REQUEST_BYTES) return error("Harness 请求上下文过大。", 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    return error("Harness 请求体不是有效 JSON。", 400);
  }
  const parsed = harnessRequestSchema.safeParse(raw);
  if (!parsed.success) return error("Harness 请求格式不正确。", 400);
  if (!demoFixtureResult.success) return error("服务端演示数据不可用。", 500);
  const fixtures = demoFixtureResult.data;
  try {
    const task = await idempotencyStore.execute(parsed.data, () => harness.run(parsed.data, {
      dataRuntime: fixtures.dataRuntime,
      apiKey: process.env.DEEPSEEK_API_KEY,
      model: process.env.DEEPSEEK_MODEL,
      signal: request.signal,
      bounds: {
        maxModelCalls: positiveInteger(process.env.HARNESS_MAX_MODEL_CALLS, 2),
        maxToolCalls: positiveInteger(process.env.HARNESS_MAX_TOOL_CALLS, 6),
      },
    }));
    return NextResponse.json({ task }, { status: 200, headers: noStoreHeaders });
  } catch (caught) {
    if (caught instanceof HarnessIdempotencyConflictError) return error(caught.message, 409);
    if (caught instanceof HarnessRequestError) return error(caught.message, caught.status);
    return error("Harness 服务暂时不可用。", 503);
  }
}
