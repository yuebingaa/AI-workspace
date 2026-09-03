import {
  aiPlanErrorPayloadSchema,
  aiPlanSuccessSchema,
  type AiPlanPublicRequest,
  type AiPlanSuccess,
} from "./contracts";

export type AiPlanClientErrorCode = "cancelled" | "timeout" | "invalid_response" | "service_error";

export class AiPlanClientError extends Error {
  constructor(
    readonly code: AiPlanClientErrorCode,
    message: string,
    readonly retryable: boolean,
    readonly metadata?: AiPlanSuccess["metadata"],
  ) {
    super(message);
    this.name = "AiPlanClientError";
  }
}

export interface AiPlanClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export async function requestAiPlan(
  payload: AiPlanPublicRequest,
  options: AiPlanClientOptions = {},
): Promise<AiPlanSuccess> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.timeoutMs ?? 30_000);

  try {
    const response = await fetchImpl("/api/ai/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const parsedError = aiPlanErrorPayloadSchema.safeParse(body);
      throw new AiPlanClientError(
        "service_error",
        parsedError.success ? parsedError.data.error.message : "AI 服务暂时不可用，请稍后重试。",
        parsedError.success ? parsedError.data.error.retryable : response.status >= 500,
        parsedError.success ? parsedError.data.metadata : undefined,
      );
    }
    const parsed = aiPlanSuccessSchema.safeParse(body);
    if (!parsed.success) {
      throw new AiPlanClientError("invalid_response", "AI 服务返回格式异常，未生成可预览变更。", true);
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof AiPlanClientError) throw error;
    if (timedOut) throw new AiPlanClientError("timeout", "AI 请求超时，请重试。", true);
    if (options.signal?.aborted || controller.signal.aborted) {
      throw new AiPlanClientError("cancelled", "已取消本次 AI 请求。", true);
    }
    throw new AiPlanClientError("service_error", "无法连接 AI 服务，请检查网络后重试。", true);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}
