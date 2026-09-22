import { PROJECT_HEADER, PROJECT_LIMITS, projectSessionSchema, type ProjectSession } from "./contracts";
import { readBoundedUtf8Body } from "@/core/http/bounded-body";
import { ProjectStateRepository, type ProjectSaveStatus, type ProjectStateWriter } from "./state-repository";
import { projectCompatibilityFromError, projectCompatibilityMessage, type ProjectCompatibility } from "./compatibility";

export type { ProjectSaveStatus } from "./state-repository";

/** Transport errors carry validated diagnostics, never a partially decoded project. */
export class ProjectRequestError extends Error {
  constructor(message: string, readonly compatibility?: ProjectCompatibility) {
    super(message);
    this.name = "ProjectRequestError";
  }
}

// Tab-local selection: another tab changing localStorage cannot redirect in-flight data requests.
let activeHandle: string | null = null;
export const LAST_PROJECT_KEY = "agentcanvas:last-local-project:v1";
export function setActiveProjectHandle(handle: string | null) { activeHandle = handle; }
export function activeProjectHandle() { return activeHandle; }
export function projectHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, ...(activeHandle ? { [PROJECT_HEADER]: activeHandle } : {}) };
}
export async function projectRequest(body?: unknown, handle: string | null = activeHandle): Promise<unknown> {
  const response = await fetch("/api/projects", {
    method: body === undefined ? "GET" : "POST", cache: "no-store",
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(handle ? { [PROJECT_HEADER]: handle } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const bodyText = await readBoundedUtf8Body(response, response.ok ? PROJECT_LIMITS.manifestBytes + 64_000 : 16 * 1024);
  let value: unknown;
  try { value = JSON.parse(bodyText); }
  catch { throw new ProjectRequestError("项目响应无法读取，请检查服务后重试；当前项目未被切换。"); }
  if (!response.ok) {
    const error = typeof value === "object" && value !== null && "error" in value ? value.error : null;
    const compatibility = response.status === 409 ? projectCompatibilityFromError(error) : null;
    const message = typeof error === "object" && error !== null && "message" in error
      && typeof error.message === "string" && error.message.trim() ? error.message : "项目操作失败";
    throw new ProjectRequestError(compatibility ? projectCompatibilityMessage(compatibility) : message, compatibility ?? undefined);
  }
  return value;
}
export async function loadProject(handle: string) { return projectSessionSchema.parse(await projectRequest(undefined, handle)); }
export async function setProjectFileArchived(handle: string, fileId: string, archived: boolean) {
  return projectSessionSchema.parse(await projectRequest({ action: archived ? "archiveFile" : "restoreFile", fileId }, handle));
}
export async function saveProjectOriginal(file: File, datasetId: string): Promise<void> {
  if (!activeHandle) return;
  const response = await fetch("/api/projects/files", { method: "POST", body: file, signal: AbortSignal.timeout(45_000),
    headers: projectHeaders({ "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name), "x-dataset-id": datasetId }) });
  if (!response.ok) {
    const value = await response.json() as { error?: { message?: string } };
    throw new Error(`数据表已保存，但原始文件保存失败：${value.error?.message ?? "请重试"}`);
  }
}
export async function downloadProjectFile(id: string, name: string): Promise<void> {
  const response = await fetch(`/api/projects/files?id=${encodeURIComponent(id)}`, { headers: projectHeaders(), cache: "no-store" });
  if (!response.ok) {
    let message = "原始文件读取失败，请检查项目文件夹";
    try {
      const value = JSON.parse(await readBoundedUtf8Body(response, 16 * 1024, { timeoutMs: 30_000 })) as { error?: { message?: unknown } };
      if (typeof value.error?.message === "string" && value.error.message.trim()) message = value.error.message;
    } catch { /* Invalid or unbounded error responses keep the generic download message. */ }
    throw new Error(message);
  }
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const writeProjectState: ProjectStateWriter = async ({ handle, state, stateRevision }) =>
  await projectRequest({ action: "save", state, stateRevision }, handle) as { stateRevision: number };

/** Existing browser entry point; the queue itself is transport-independent. */
export class ProjectStudioRepository extends ProjectStateRepository {
  constructor(session: ProjectSession, report: (status: ProjectSaveStatus) => void) {
    super(session, report, writeProjectState, loadProject);
  }
}
