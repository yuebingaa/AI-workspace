import { z } from "zod";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import type { DeepSeekAvailableModel } from "./runtime-credentials";

export const DEEPSEEK_MODELS_URL = "https://api.deepseek.com/models";
const MAX_MODELS_RESPONSE_BYTES = 128 * 1024;
const MODELS_REQUEST_TIMEOUT_MS = 10_000;

const modelsResponseSchema = z.object({
  object: z.literal("list"),
  data: z.array(z.object({
    id: z.string().trim().min(1).max(128),
    object: z.literal("model"),
    owned_by: z.string().trim().min(1).max(120),
  }).strip()).min(1).max(100),
}).strip();

export class DeepSeekModelDiscoveryError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = "DeepSeekModelDiscoveryError";
  }
}

function upstreamError(status: number): DeepSeekModelDiscoveryError {
  if (status === 401) return new DeepSeekModelDiscoveryError("DeepSeek API Key 无效。", 401, false);
  if (status === 403) return new DeepSeekModelDiscoveryError("DeepSeek 拒绝读取当前账号的模型列表。", 403, false);
  if (status === 429) return new DeepSeekModelDiscoveryError("DeepSeek 请求过于频繁，请稍后重新识别模型。", 429, true);
  return new DeepSeekModelDiscoveryError(`DeepSeek 模型列表暂时不可用（HTTP ${status}）。`, 502, true);
}

export async function discoverDeepSeekModels(
  apiKey: string,
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<DeepSeekAvailableModel[]> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? MODELS_REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(DEEPSEEK_MODELS_URL, {
      method: "GET",
      headers: { accept: "application/json", authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw upstreamError(response.status);
    const text = await readBoundedUtf8Body(response, MAX_MODELS_RESPONSE_BYTES, { signal: controller.signal });
    let raw: unknown;
    try { raw = JSON.parse(text) as unknown; }
    catch { throw new DeepSeekModelDiscoveryError("DeepSeek 返回的模型列表格式无效。", 502, true); }
    const parsed = modelsResponseSchema.safeParse(raw);
    if (!parsed.success) throw new DeepSeekModelDiscoveryError("DeepSeek 返回的模型列表格式无效。", 502, true);
    return parsed.data.data.map((model) => ({ id: model.id, ownedBy: model.owned_by }));
  } catch (error) {
    if (error instanceof DeepSeekModelDiscoveryError) throw error;
    if (timedOut) throw new DeepSeekModelDiscoveryError("读取 DeepSeek 模型列表超时。", 504, true);
    if (options.signal?.aborted) throw new DeepSeekModelDiscoveryError("模型识别已取消。", 408, true);
    throw new DeepSeekModelDiscoveryError("无法连接 DeepSeek 模型列表接口。", 502, true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
