import { PROJECT_HEADER, PROJECT_LIMITS, projectSessionSchema, type ProjectSession } from "./contracts";
import { readBoundedUtf8Body } from "@/core/http/bounded-body";
import { ProjectStateRepository, type ProjectSaveStatus, type ProjectStateWriter } from "./state-repository";

export type { ProjectSaveStatus } from "./state-repository";

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
  const value = JSON.parse(await readBoundedUtf8Body(response, PROJECT_LIMITS.manifestBytes + 64_000)) as { error?: { message?: string } };
  if (!response.ok) throw new Error(value.error?.message ?? "项目操作失败");
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
  if (!response.ok) throw new Error("原始文件读取失败，请检查项目文件夹");
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const writeProjectState: ProjectStateWriter = async ({ handle, state, stateRevision }) =>
  await projectRequest({ action: "save", state, stateRevision }, handle) as { stateRevision: number };

/** Existing browser entry point; the queue itself is transport-independent. */
export class ProjectStudioRepository extends ProjectStateRepository {
  constructor(session: ProjectSession, report: (status: ProjectSaveStatus) => void) {
    super(session, report, writeProjectState);
  }
}
