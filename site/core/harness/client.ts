import {
  HARNESS_CLIENT_TIMEOUT_MS,
  MAX_HARNESS_IMAGE_ATTACHMENTS,
  MAX_HARNESS_IMAGE_BYTES,
  MAX_HARNESS_TOTAL_IMAGE_BYTES,
  harnessResponseSchema,
  type HarnessPublicRequest,
  type HarnessResponse,
  type HarnessTraceEvent,
} from "./contracts";
import { readHarnessStream } from "./stream";
import { projectHeaders } from "@/core/projects/client";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";

export const MAX_HARNESS_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MAX_HARNESS_INVALID_RESPONSE_RETRIES = 1;

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
  stream?: boolean;
  onEvent?: (event: HarnessTraceEvent) => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  rawWorkbook?: File;
  imageAttachments?: File[];
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
    const rawWorkbook = options.rawWorkbook;
    const imageAttachments = options.imageAttachments ?? [];
    if (imageAttachments.length > MAX_HARNESS_IMAGE_ATTACHMENTS
      || imageAttachments.some((file) => file.size < 1
        || file.size > MAX_HARNESS_IMAGE_BYTES
        || !["image/jpeg", "image/png", "image/webp"].includes(file.type))
      || imageAttachments.reduce((total, file) => total + file.size, 0) > MAX_HARNESS_TOTAL_IMAGE_BYTES) {
      throw new HarnessClientError("service_error", "图片须为 JPEG、PNG 或 WebP；最多 3 张，单张不超过 3 MiB、合计不超过 6 MiB。", false);
    }
    let body: FormData | null = null;
    if (rawWorkbook || imageAttachments.length) {
      body = new FormData();
      body.set("payload", JSON.stringify(payload));
      if (rawWorkbook) body.set("rawWorkbook", rawWorkbook);
      imageAttachments.forEach((image) => body!.append("imageAttachment", image));
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const requestBody = body ?? JSON.stringify(payload);
    const headers = projectHeaders(body ? {} : { "content-type": "application/json" });
    for (let responseAttempt = 0; responseAttempt <= MAX_HARNESS_INVALID_RESPONSE_RETRIES; responseAttempt += 1) {
      const response = await fetchImpl(options.stream ? "/api/ai/harness/stream" : "/api/ai/harness", {
        method: "POST",
        headers: Object.keys(headers).length ? headers : undefined,
        body: requestBody,
        cache: "no-store",
        signal: controller.signal,
      });
      if (options.stream && response.ok) {
        try {
          const result = await readHarnessStream(response, controller.signal, (event) => {
            if (event.taskId !== `harness_${payload.idempotencyKey}`) throw new Error("事件不属于当前请求。");
            options.onEvent?.(event);
          });
          if (result.task.idempotencyKey !== payload.idempotencyKey || result.task.pageId !== payload.pageId) throw new Error("最终任务与当前请求不匹配。");
          return result;
        }
        catch (error) {
          if (controller.signal.aborted) throw error;
          throw new HarnessClientError("invalid_response", error instanceof Error ? error.message : "事件流格式无效。", true);
        }
      }
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
      if (parsed.success) return parsed.data;
      if (responseAttempt === MAX_HARNESS_INVALID_RESPONSE_RETRIES) {
        throw new HarnessClientError("invalid_response", "Harness 连续返回无法验证的响应，请刷新页面后重试。", true);
      }
    }
    throw new HarnessClientError("invalid_response", "Harness 返回格式异常。", true);
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
