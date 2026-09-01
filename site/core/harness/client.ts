import {
  harnessResponseSchema,
  type HarnessRequest,
  type HarnessResponse,
} from "./contracts";

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
  payload: HarnessRequest,
  options: HarnessClientOptions = {},
): Promise<HarnessResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const abortOuter = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortOuter, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs ?? 30_000);
  try {
    const response = await (options.fetchImpl ?? fetch)("/api/ai/harness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const raw = await response.json().catch(() => null) as unknown;
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
