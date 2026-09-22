import { projectSessionSchema, type ProjectSession } from "./contracts";
import { parseStudioPersistedState, type StudioPersistedState, type StudioRepository } from "@/core/repository/studio-repository";
import { normalizeProjectStateForStorage } from "./state-normalization";
import { projectCompatibilityFromError, type ProjectCompatibility } from "./compatibility";

export type ProjectSaveStatus = { state: "saved" | "pending" | "saving" | "error"; message: string; compatibility?: ProjectCompatibility };

function failureStatus(error: Error): ProjectSaveStatus {
  const compatibility = projectCompatibilityFromError(error);
  return { state: "error", message: error.message, ...(compatibility ? { compatibility } : {}) };
}
/** The writer must target this repository's handle, not the currently selected tab/project. */
export type ProjectStateWriter = (input: {
  handle: string;
  state: StudioPersistedState;
  stateRevision: number;
}) => Promise<{ stateRevision: number }>;
export type ProjectStateReader = (handle: string) => Promise<ProjectSession>;

function stateSignature(state: StudioPersistedState) {
  return JSON.stringify({ ...parseStudioPersistedState(state), savedAt: "" });
}

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
  private failedWrite: { state: StudioPersistedState; revision: number } | null = null;
  private recovering: Promise<void> | null = null;
  private signature = "";
  revision: number;

  constructor(
    readonly session: ProjectSession,
    private readonly report: (status: ProjectSaveStatus) => void,
    private readonly write: ProjectStateWriter,
    private readonly read?: ProjectStateReader,
  ) {
    this.state = session.manifest.state; this.revision = session.manifest.stateRevision;
    if (this.state) this.signature = stateSignature(this.state);
  }

  load() { return this.state ? structuredClone(this.state) : null; }
  save(value: StudioPersistedState) {
    const state = parseStudioPersistedState(value);
    const signature = stateSignature(state);
    if (signature === this.signature) return;
    this.signature = signature; this.state = state; this.pending = state;
    this.report(this.error ? failureStatus(this.error) : { state: "pending", message: "有更改待写入项目" });
    clearTimeout(this.timer);
    if (!this.error) this.timer = setTimeout(() => { void this.flush().catch(() => undefined); }, 400);
  }
  clear() { throw new Error("项目文件不能通过清空浏览器存储删除"); }
  /** Only called after the user explicitly chooses to discard unsaved definitions. */
  async discardPending(): Promise<void> {
    clearTimeout(this.timer);
    await this.recovering?.catch(() => undefined);
    await this.saving?.catch(() => undefined);
    this.pending = null; this.error = null; this.failedWrite = null;
  }
  get dirty() { return Boolean(this.pending || this.saving || this.recovering || this.error); }

  /** Explicit recovery only: re-read this project before authorizing another write. */
  async retry(): Promise<void> {
    if (this.recovering) return this.recovering;
    if (!this.error) return this.flush();
    const failed = this.failedWrite;
    const read = this.read;
    if (!read || !failed) throw this.error;
    clearTimeout(this.timer);
    this.recovering = (async () => {
      this.report({ state: "saving", message: "正在核对项目版本并重试保存…" });
      try {
        const current = projectSessionSchema.parse(await read(this.session.handle));
        if (current.handle !== this.session.handle || current.manifest.id !== this.session.manifest.id) {
          throw new Error("项目身份已变化，未覆盖磁盘内容；请备份当前修改后重新打开项目。");
        }
        const revision = current.manifest.stateRevision;
        if (revision === failed.revision + 1 && current.manifest.state
          && stateSignature(current.manifest.state) === stateSignature(normalizeProjectStateForStorage(failed.state, current.manifest.tables))) {
          // The write reached disk but its acknowledgement was lost. Never replay it.
          this.revision = revision;
          if (this.pending && stateSignature(this.pending) === stateSignature(failed.state)) this.pending = null;
        } else if (revision !== failed.revision) {
          throw new Error("项目已被另一窗口修改，重试未覆盖磁盘内容；当前修改仍保留，请先备份再重新打开。");
        }
        this.error = null; this.failedWrite = null;
        if (this.pending) await this.flush();
        else this.report({ state: "saved", message: "已确认上次修改保存到本地项目" });
      } catch (error) {
        this.error = error instanceof Error ? error : new Error("项目保存重试失败，当前修改仍保留");
        this.report(failureStatus(this.error));
        throw this.error;
      }
    })();
    try { await this.recovering; } finally { this.recovering = null; }
  }
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
        } catch (error) {
          this.pending ??= candidate;
          this.failedWrite = { state: candidate, revision: this.revision };
          this.error = error instanceof Error ? error : new Error("项目保存失败");
          this.report(failureStatus(this.error));
          throw this.error;
        }
      }
      this.report({ state: "saved", message: "已保存到本地项目" });
    })();
    try { await this.saving; } finally { this.saving = null; }
  }
}
