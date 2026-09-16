import type { ProjectSession } from "./contracts";
import { parseStudioPersistedState, type StudioPersistedState, type StudioRepository } from "@/core/repository/studio-repository";

export type ProjectSaveStatus = { state: "saved" | "pending" | "saving" | "error"; message: string };
/** The writer must target this repository's handle, not the currently selected tab/project. */
export type ProjectStateWriter = (input: {
  handle: string;
  state: StudioPersistedState;
  stateRevision: number;
}) => Promise<{ stateRevision: number }>;

/**
 * Owns coalescing, revisions and failed/dirty state, but no HTTP or active-project selection.
 * save() accepts a local snapshot; only a successful flush() confirms durable storage.
 */
export class ProjectStateRepository implements StudioRepository {
  private state: StudioPersistedState | null;
  private pending: StudioPersistedState | null = null;
  private saving: Promise<void> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private error: Error | null = null;
  private signature = "";
  revision: number;

  constructor(
    readonly session: ProjectSession,
    private readonly report: (status: ProjectSaveStatus) => void,
    private readonly write: ProjectStateWriter,
  ) {
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
          const result = await this.write({ handle: this.session.handle, state: candidate, stateRevision: this.revision });
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
