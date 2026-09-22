import { readBoundedUtf8Body } from "@/core/http/bounded-body";
import { projectCompatibilityFromError, projectCompatibilityMessage } from "./compatibility";
import { PROJECT_INSPECTION_LIMITS, projectInspectionSchema, type ProjectInspection } from "./inspection";

const unavailable = "项目步骤无法读取，请检查项目文件夹和版本后重试；当前工作区未改变。";

/** Independent read-only transport: no active project handle or save queue is involved. */
export async function requestProjectInspection(path: string, signal?: AbortSignal): Promise<ProjectInspection> {
  const timeout = AbortSignal.timeout(30_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch("/api/projects/inspect", {
    method: "POST", cache: "no-store", headers: { "content-type": "application/json" },
    body: JSON.stringify({ path }), signal: requestSignal,
  });
  let value: unknown;
  try {
    value = JSON.parse(await readBoundedUtf8Body(response,
      response.ok ? PROJECT_INSPECTION_LIMITS.responseBytes : 16 * 1024,
      { signal: requestSignal, timeoutMs: 30_000 }));
  } catch {
    requestSignal.throwIfAborted();
    throw new Error(unavailable);
  }
  requestSignal.throwIfAborted();
  if (!response.ok) {
    const error = typeof value === "object" && value !== null && "error" in value ? value.error : null;
    const compatibility = response.status === 409 ? projectCompatibilityFromError(error) : null;
    const message = typeof error === "object" && error !== null && "message" in error
      && typeof error.message === "string" && error.message.trim() ? error.message : unavailable;
    throw new Error(compatibility ? projectCompatibilityMessage(compatibility) : message);
  }
  const parsed = projectInspectionSchema.safeParse(value);
  if (!parsed.success) throw new Error(unavailable);
  return parsed.data;
}
