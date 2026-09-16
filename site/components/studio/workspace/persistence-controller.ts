import type { QueryExecutionRecord } from "@/core/models";
import { saveStudioStateSafely, type StudioPersistedState, type StudioRepository, type StudioSaveResult } from "@/core/repository";

interface AutomaticSave {
  repository: StudioRepository | null;
  mode: "project" | "temporary";
  queryRecords: QueryExecutionRecord[];
  conversationState?: object;
  snapshot(): StudioPersistedState;
}

/** Owns scheduling only, not another copy of the workspace document or its repository. */
export class StudioPersistenceController {
  private pending: object | null = null;
  private lastQueries: { repository: StudioRepository | null; records: QueryExecutionRecord[]; conversationState?: object } | null = null;

  /** enqueue must defer execution; callers can supply a deterministic scheduler in tests. */
  constructor(private readonly enqueue: (job: () => void) => void = (job) => queueMicrotask(job)) {}

  scheduleAutomatic(input: AutomaticSave, onFailure: (notice: string | null) => void): () => void {
    this.cancel();
    // Temporary workspaces save changed queries or conversations (including drafts).
    // Project workspaces save every document change; the repository coalesces writes.
    if (input.mode === "temporary" && this.lastQueries?.repository === input.repository
      && this.lastQueries.records === input.queryRecords && this.lastQueries.conversationState === input.conversationState) return () => {};

    const ticket = {};
    this.pending = ticket;
    this.enqueue(() => {
      if (this.pending !== ticket) return;
      this.pending = null;
      // Mark only executed jobs: StrictMode cleanup/replay must not suppress saving.
      if (input.mode === "temporary") this.lastQueries = { repository: input.repository, records: input.queryRecords, conversationState: input.conversationState };
      let result: StudioSaveResult;
      try {
        result = saveStudioStateSafely(input.repository, input.snapshot());
      } catch {
        // Snapshot validation must not become an unhandled deferred exception.
        result = { persisted: false, notice: "工作区保存快照无效，当前页面仍可继续使用，但刷新后可能丢失本次更改。" };
      }
      if (!result.persisted) onFailure(result.notice);
    });
    // An older Effect cleanup must not cancel a newer request.
    return () => { if (this.pending === ticket) this.pending = null; };
  }

  saveExplicitly(repository: StudioRepository | null, snapshot: StudioPersistedState): StudioSaveResult {
    this.cancel();
    return saveStudioStateSafely(repository, snapshot);
  }

  markQueriesRestored(repository: StudioRepository | null, queryRecords: QueryExecutionRecord[]): void {
    this.cancel();
    this.lastQueries = { repository, records: queryRecords };
  }

  private cancel(): void { this.pending = null; }
}
