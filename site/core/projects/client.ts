import { PROJECT_HEADER, PROJECT_LIMITS, projectSessionSchema, type ProjectSession } from "./contracts";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { parseStudioPersistedState, type StudioPersistedState, type StudioRepository } from "@/core/repository/studio-repository";

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

export type ProjectSaveStatus = { state: "saved" | "pending" | "saving" | "error"; message: string };
/** Synchronous workspace adapter with a serialized, observable async disk-save queue. */
export class ProjectStudioRepository implements StudioRepository {
  private state: StudioPersistedState | null;
  private pending: StudioPersistedState | null = null;
  private saving: Promise<void> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private error: Error | null = null;
  private signature = "";
  revision: number;
  constructor(readonly session: ProjectSession, private readonly report: (status: ProjectSaveStatus) => void) {
    this.state = session.manifest.state; this.revision = session.manifest.stateRevision;
    if (this.state) this.signature = JSON.stringify({ ...this.state, savedAt: "" });
  }
  load() { return this.state ? structuredClone(this.state) : null; }
  save(value: StudioPersistedState) {
    const state = parseStudioPersistedState(value);
    const signature = JSON.stringify({ ...state, savedAt: "" });
    if (signature === this.signature) return;
    this.signature = signature; this.state = state; this.pending = state;
    this.report(this.error ? { state: "error", message: this.error.message } : { state: "pending", message: "有更改待写入项目" });
    clearTimeout(this.timer);
    if (!this.error) this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, 400);
  }
  clear() { throw new Error("项目文件不能通过清空浏览器存储删除"); }
  /** Only called after the user explicitly chooses to discard unsaved definitions. */
  async discardPending(): Promise<void> {
    clearTimeout(this.timer);
    await this.saving?.catch(() => undefined);
    this.pending = null; this.error = null;
  }
  get dirty() { return Boolean(this.pending || this.saving || this.error); }
  async flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.error) throw this.error;
    if (this.saving) { await this.saving; return this.flush(); }
    if (!this.pending) return;
    this.saving = (async () => {
      while (this.pending) {
        const candidate = this.pending; this.pending = null;
        this.report({ state: "saving", message: "正在写入本地项目…" });
        try {
          const result = await projectRequest({ action: "save", state: candidate, stateRevision: this.revision }, this.session.handle) as { stateRevision: number };
          if (result.stateRevision !== this.revision + 1) throw new Error("项目保存响应无效");
          this.revision = result.stateRevision;
          this.report({ state: "saved", message: "已保存到本地项目" });
        } catch (error) {
          this.pending ??= candidate;
          this.error = error instanceof Error ? error : new Error("项目保存失败");
          this.report({ state: "error", message: this.error.message });
          throw this.error;
        }
      }
    })();
    try { await this.saving; } finally { this.saving = null; }
  }
}
