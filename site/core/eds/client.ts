import { BoundedBodyError, readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { EDS_MAX_RESPONSE_BYTES, edsAnalysisResponseSchema, type EdsAnalysisResponse } from "./contracts";

export class EdsClientError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "EdsClientError";
  }
}

const EDS_CLIENT_TIMEOUT_MS = 60_000;

function responseError(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } };
    return typeof parsed.error?.message === "string" ? parsed.error.message : "EDS 工作簿分析失败。";
  } catch {
    return "EDS 工作簿分析失败。";
  }
}

export async function analyzeEdsFiles(
  source: File,
  template: File | null = null,
  signal?: AbortSignal,
): Promise<EdsAnalysisResponse> {
  const body = new FormData();
  body.set("source", source);
  if (template) body.set("template", template);
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, EDS_CLIENT_TIMEOUT_MS);
  try {
    const response = await fetch("/api/eds/analyze", { method: "POST", body, cache: "no-store", signal: controller.signal });
    const text = await readBoundedUtf8Body(response, EDS_MAX_RESPONSE_BYTES);
    if (!response.ok) throw new EdsClientError(response.status, responseError(text));
    try {
      return edsAnalysisResponseSchema.parse(JSON.parse(text) as unknown);
    } catch {
      throw new EdsClientError(502, "服务端返回的 EDS 分析结果结构无效。");
    }
  } catch (error) {
    if (timedOut) throw new EdsClientError(408, "EDS 分析超过 60 秒，已停止等待。");
    if (signal?.aborted) throw error;
    if (error instanceof EdsClientError) throw error;
    if (error instanceof BoundedBodyError) throw new EdsClientError(502, "EDS 分析响应过大、编码无效或读取失败。");
    throw new EdsClientError(0, "EDS 分析网络连接失败。");
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
