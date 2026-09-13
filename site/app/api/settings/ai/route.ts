import { NextResponse } from "next/server";
import { z } from "zod";
import { discoverDeepSeekModels, DeepSeekModelDiscoveryError } from "@/core/ai/server/deepseek-models";
import {
  clearRuntimeDeepSeekApiKey,
  deepSeekSettingsStatus,
  normalizeDeepSeekApiKey,
  resolveDeepSeekApiKey,
  resolveDeepSeekModel,
  setRuntimeDeepSeekDiscovery,
  setRuntimeDeepSeekModel,
} from "@/core/ai/server/runtime-credentials";
import { BoundedBodyError, readBoundedUtf8Body } from "@/core/http/server/bounded-body";

export const runtime = "nodejs";
const MAX_SETTINGS_BODY_BYTES = 2_048;
const REQUEST_BODY_TIMEOUT_MS = 5_000;
const discoverySchema = z.object({ apiKey: z.string().optional() }).strict();
const modelSelectionSchema = z.object({ model: z.string() }).strict();
const responseHeaders = {
  "cache-control": "private, no-store, max-age=0",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
};

function response(status = 200) {
  return NextResponse.json({
    ...deepSeekSettingsStatus(),
    persistence: "process-memory" as const,
  }, { status, headers: responseHeaders });
}

function error(message: string, status: number) {
  return NextResponse.json({ error: { message } }, { status, headers: responseHeaders });
}

function acceptsSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return false;
  const fetchSite = request.headers.get("sec-fetch-site");
  return !fetchSite || fetchSite === "same-origin" || fetchSite === "none";
}

async function readJson(request: Request): Promise<unknown> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new Response(JSON.stringify({ error: { message: "AI API 配置必须使用 application/json。" } }), {
      status: 415,
      headers: { ...responseHeaders, "content-type": "application/json" },
    });
  }
  const text = await readBoundedUtf8Body(request, MAX_SETTINGS_BODY_BYTES, {
    signal: request.signal,
    timeoutMs: REQUEST_BODY_TIMEOUT_MS,
  });
  try { return JSON.parse(text) as unknown; }
  catch { throw new Error("AI API 配置格式不正确。"); }
}

export async function GET() {
  return response();
}

export async function POST(request: Request) {
  if (!acceptsSameOrigin(request)) return error("只允许当前网站配置 AI API。", 403);
  try {
    const parsed = discoverySchema.safeParse(await readJson(request));
    if (!parsed.success) return error("AI API 配置格式不正确。", 400);
    const apiKey = parsed.data.apiKey === undefined
      ? resolveDeepSeekApiKey()
      : normalizeDeepSeekApiKey(parsed.data.apiKey);
    if (!apiKey) return error("请先填写 DeepSeek API Key。", 400);
    const models = await discoverDeepSeekModels(apiKey, { signal: request.signal });
    setRuntimeDeepSeekDiscovery(models, {
      ...(parsed.data.apiKey === undefined ? {} : { apiKey }),
      preferredModel: resolveDeepSeekModel(),
    });
    return response();
  } catch (caught) {
    if (caught instanceof Response) return caught;
    if (caught instanceof DeepSeekModelDiscoveryError) return error(caught.message, caught.status);
    if (caught instanceof BoundedBodyError) return error("AI API 配置请求过大、无效或已中断。", caught.code === "too-large" ? 413 : 400);
    return error(caught instanceof Error ? caught.message : "无法保存 AI API 配置。", 400);
  }
}

export async function PATCH(request: Request) {
  if (!acceptsSameOrigin(request)) return error("只允许当前网站配置 AI API。", 403);
  try {
    const parsed = modelSelectionSchema.safeParse(await readJson(request));
    if (!parsed.success) return error("模型选择格式不正确。", 400);
    if (!resolveDeepSeekApiKey()) return error("AI 服务尚未配置。", 409);
    setRuntimeDeepSeekModel(parsed.data.model);
    return response();
  } catch (caught) {
    if (caught instanceof Response) return caught;
    if (caught instanceof BoundedBodyError) return error("模型选择请求过大、无效或已中断。", caught.code === "too-large" ? 413 : 400);
    return error(caught instanceof Error ? caught.message : "无法应用所选模型。", 400);
  }
}

export async function DELETE(request: Request) {
  if (!acceptsSameOrigin(request)) return error("只允许当前网站配置 AI API。", 403);
  clearRuntimeDeepSeekApiKey();
  return response();
}
