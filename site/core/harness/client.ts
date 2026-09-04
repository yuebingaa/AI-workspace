import {
  HARNESS_CLIENT_TIMEOUT_MS,
  harnessResponseSchema,
  type HarnessPublicRequest,
  type HarnessResponse,
} from "./contracts";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";

export const MAX_HARNESS_RESPONSE_BYTES = 4 * 1024 * 1024;

export class HarnessClientError extends Error {
  constructor(
    readonly code: "cancelled" | "timeout" | "invalid_response" | "service_error",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "HarnessClientError";
  }
}

export interface HarnessClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function requestHarnessTask(
  payload: HarnessPublicRequest,
  options: HarnessClientOptions = {},
): Promise<HarnessResponse> {
  if (options.signal?.aborted) {
    throw new HarnessClientError("cancelled", "Harness 任务已取消。", true);
  }
  const timeoutMs = options.timeoutMs ?? HARNESS_CLIENT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > HARNESS_CLIENT_TIMEOUT_MS) {
    throw new HarnessClientError("service_error", "Harness 请求超时配置无效。", false);
  }
  const controller = new AbortController();
  let timedOut = false;
  const abortOuter = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortOuter, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)("/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let raw: unknown = null;
    try {
      raw = JSON.parse(await readBoundedUtf8Body(response, MAX_HARNESS_RESPONSE_BYTES)) as unknown;
    } catch (error) {
      if (controller.signal.aborted) throw error;
    }
    if (!response.ok) {
      const message = raw && typeof raw === "object" && "error" in raw && raw.error && typeof raw.error === "object" && "message" in raw.error && typeof raw.error.message === "string"
        ? raw.error.message
        : "Harness 服务暂时不可用。";
      throw new HarnessClientError("service_error", message, response.status >= 500 || response.status === 429);
    }
    const parsed = harnessResponseSchema.safeParse(raw);
    if (!parsed.success) throw new HarnessClientError("invalid_response", "Harness 返回格式异常。", true);
    return parsed.data;
  } catch (error) {
    if (error instanceof HarnessClientError) throw error;
    if (timedOut) throw new HarnessClientError("timeout", "Harness 请求超时，请重试。", true);
    if (options.signal?.aborted || controller.signal.aborted) throw new HarnessClientError("cancelled", "Harness 任务已取消。", true);
    throw new HarnessClientError("service_error", "无法连接 Harness 服务。", true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortOuter);
  }
}
