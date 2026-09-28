import type { NotebookDocument } from "@/core/notebook/contracts";
import type { NotebookArtifact } from "@/core/notebook/definition";

/** Ephemeral completion event. The owner must never recreate this from history. */
export interface AiNotebookRunRequest {
  taskId: string;
  draft: NotebookArtifact;
  baseline: NotebookDocument;
  scopeKey: string;
}

export interface AiNotebookRunEnvironment {
  document: NotebookDocument;
  contextKey: string;
  scopeKey: string;
  enabled: boolean;
  canEdit: boolean;
  hidden: boolean;
  editing: boolean;
  busy: boolean;
  externalBusy: boolean;
  request?: AiNotebookRunRequest | null;
}

export interface AiNotebookRunHandlers {
  /** Validate and publish an isolated preview, without changing the saved definition. */
  prepare: (request: AiNotebookRunRequest) => NotebookDocument;
  /** Start the normal runner, which owns asynchronous errors and cancellation. */
  run: () => void;
  /** Cancel only execution owned by this AI completion workflow. */
  cancel: () => void;
  blocked: (message: string) => void;
  /** Clear this task's event in the owner before preparation, including on refusal. */
  handled: (taskId: string) => void;
}

interface PendingRun {
  previousKey: string;
  expectedKey: string;
  contextKey: string;
  scopeKey: string;
}

function environmentIssue(environment: AiNotebookRunEnvironment, allowBusy = false): string | undefined {
  if (!environment.enabled) return "AI 草稿自动预览已关闭；本次任务不会自动准备或运行预览。";
  if (!environment.canEdit) return "当前没有 Notebook 编辑权限；本次 AI 草稿预览运行已取消。";
  if (environment.hidden) return "Notebook 已隐藏；本次 AI 草稿预览运行已取消。";
  if (environment.editing) return "Notebook 正在编辑；请完成编辑后手动检查 AI 草稿预览。";
  if (environment.externalBusy) return "工作界面正在执行其他 AI 任务；本次草稿不会自动运行预览。";
  if (!allowBusy && environment.busy) return "Notebook 正在运行；本次 AI 草稿不会自动准备或运行预览。";
  return undefined;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Runs only newly completed AI events, never inferred document changes. Preview
 * and execution require separate updates so React must first commit the exact
 * candidate. Failed or cancelled events remain consumed, including effect replay.
 * The event owner clears handled requests to preserve this rule across remounts.
 */
export class NotebookAiRunScheduler {
  private readonly consumed = new Set<string>();
  private environment: AiNotebookRunEnvironment | null = null;
  private handlers: AiNotebookRunHandlers | null = null;
  private pending: PendingRun | null = null;
  private active: PendingRun | null = null;
  private generation = 0;

  update(environment: AiNotebookRunEnvironment, handlers: AiNotebookRunHandlers): void {
    const previous = this.environment;
    const generation = ++this.generation;
    const contextChanged = previous !== null && (previous.contextKey !== environment.contextKey || previous.scopeKey !== environment.scopeKey);
    this.environment = environment;
    this.handlers = handlers;

    // Busy is expected after our runner starts. The remaining guards still
    // revoke execution; a completed run cannot be re-enqueued by becoming idle.
    if (this.active) {
      const active = this.active;
      let changedDocument = true;
      try { changedDocument = JSON.stringify(environment.document) !== active.expectedKey; } catch { /* Cancel an unserializable document. */ }
      if (environmentIssue(environment, true) || active.contextKey !== environment.contextKey
        || active.scopeKey !== environment.scopeKey || changedDocument) {
        this.active = null;
        handlers.cancel();
      } else if (previous?.busy && !environment.busy) this.active = null;
    }

    const request = environment.request;
    if (request && !this.consumed.has(request.taskId)) {
      // Consume before invoking any handler, even when a capability check throws.
      this.consumed.add(request.taskId);
      try { handlers.handled(request.taskId); }
      catch (error) {
        this.reject(errorMessage(error, "无法确认 AI 任务已处理；本次不会自动准备或运行预览。"));
        return;
      }
      if (generation !== this.generation) return;
      if (this.pending || (this.active && environment.busy)) {
        this.reject("已有 AI 草稿正在准备或运行预览；本次自动预览已取消，请手动检查草稿。");
        return;
      }
      const issue = environmentIssue(environment);
      if (issue) { handlers.blocked(issue); return; }
      // The runner owns the synchronous execution lease. An entirely settled
      // run may never have produced a busy render, so our cancellation marker
      // cannot itself prevent a fresh completion event while the runner is idle.
      this.active = null;
      if (contextChanged || request.scopeKey !== environment.scopeKey) {
        handlers.blocked("工作界面或数据来源已变化；本次 AI 草稿不会自动准备或运行预览。");
        return;
      }
      try {
        const previousKey = JSON.stringify(environment.document);
        if (previousKey !== JSON.stringify(request.baseline)) {
          handlers.blocked("Notebook 已在 AI 任务开始后修改；请检查草稿，本次不会自动准备或运行预览。");
          return;
        }
        const candidate = handlers.prepare(request);
        if (generation !== this.generation) return;
        const expectedKey = JSON.stringify(candidate);
        if (!expectedKey || expectedKey === previousKey) {
          handlers.blocked("AI 草稿预览没有新的步骤；本次不会自动运行预览。");
          return;
        }
        this.pending = { previousKey, expectedKey, contextKey: environment.contextKey, scopeKey: environment.scopeKey };
      } catch (error) {
        this.reject(errorMessage(error, "AI 草稿预览准备失败；请检查草稿后手动处理。"));
      }
      return;
    }

    const pending = this.pending;
    if (!pending) return;
    const issue = environmentIssue(environment);
    if (issue) { this.reject(issue); return; }
    if (pending.contextKey !== environment.contextKey || pending.scopeKey !== environment.scopeKey) {
      this.reject("工作界面或数据来源已变化；本次 AI 草稿预览运行已取消。");
      return;
    }
    try {
      const documentKey = JSON.stringify(environment.document);
      if (documentKey === pending.expectedKey) {
        // Clear before run: synchronous failure, re-entry, and effect replay
        // must never launch the same event again.
        this.pending = null;
        this.active = pending;
        handlers.run();
      } else if (documentKey !== pending.previousKey) {
        this.reject("Notebook 已发生变化；本次 AI 草稿预览运行已取消，请检查当前步骤。");
      }
    } catch (error) {
      this.reject(errorMessage(error, "AI 草稿预览运行启动失败；请检查后手动运行。"));
    }
  }

  clearPending(): void {
    if (!this.pending) return;
    this.pending = null;
    this.generation += 1;
    this.handlers?.cancel();
  }

  dispose(): void {
    this.pending = null;
    this.active = null;
    this.environment = null;
    this.generation += 1;
    const handlers = this.handlers;
    this.handlers = null;
    handlers?.cancel();
  }

  private reject(message: string): void {
    const hadWork = this.pending !== null || this.active !== null;
    this.pending = null;
    this.active = null;
    this.generation += 1;
    if (hadWork) this.handlers?.cancel();
    this.handlers?.blocked(message);
  }
}
