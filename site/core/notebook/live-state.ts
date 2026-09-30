import type { NotebookCellRun, NotebookDocument } from "./contracts";
import type { NotebookLiveProgress } from "./live-progress";

export interface NotebookLiveState {
  scopeKey: string; taskId: string; sequence: number; baseline: NotebookDocument;
  document: NotebookDocument; editVersion: number; runId?: string; runFinished?: boolean;
  phase: "working" | "ready" | "failed" | "cancelled";
  statuses: Record<string, "pending" | "stale" | "queued" | "running" | "success" | "failure" | "blocked">;
  results: Record<string, NotebookCellRun>;
}

/** Ephemeral display reducer. It never returns a saved document or reusable result cache. */
export function applyNotebookLiveProgress(current: NotebookLiveState | null, input: {
  scopeKey: string; taskId: string; sequence: number; baseline: NotebookDocument; progress: NotebookLiveProgress;
}): NotebookLiveState | null {
  const { progress, baseline, scopeKey, taskId, sequence } = input;
  if (progress.baseRevision !== baseline.revision) return current;
  const previous = current?.scopeKey === scopeKey && current.taskId === taskId ? current : null;
  if (previous && (previous.phase !== "working" || sequence <= previous.sequence || progress.editVersion < previous.editVersion)) return current;
  const update = progress.update;
  if (update.kind === "draft") {
    if (update.document.revision !== baseline.revision) return current;
    if (previous?.editVersion === progress.editVersion) {
      return JSON.stringify(previous.document) === JSON.stringify(update.document) ? { ...previous, sequence } : current;
    }
    return { scopeKey, taskId, sequence, baseline, document: update.document, editVersion: progress.editVersion, phase: "working",
      statuses: Object.fromEntries(update.document.cells.map(cell => [cell.id, previous?.results[cell.id] ? "stale" : "pending"])), results: {} };
  }
  if (!previous || progress.editVersion !== previous.editVersion || update.revision !== baseline.revision) return current;
  if (update.kind === "run_started") {
    if (update.runId === previous.runId) return current;
    if (update.cellIds.length !== previous.document.cells.length || new Set(update.cellIds).size !== update.cellIds.length
      || update.cellIds.some(id => !previous.document.cells.some(cell => cell.id === id))) return current;
    return { ...previous, sequence, runId: update.runId, runFinished: false, results: {}, statuses: Object.fromEntries(update.cellIds.map(id => [id, "queued"])) };
  }
  if (update.runId !== previous.runId) return current;
  if (previous.runFinished) return current;
  if (update.kind === "run_finished") return { ...previous, sequence, runFinished: true };
  const cellId = update.kind === "cell_started" ? update.cellId : update.result.cellId;
  if (!previous.document.cells.some(cell => cell.id === cellId)) return current;
  if (previous.results[cellId]) return current;
  if (update.kind === "cell_finished" && update.result.resultRef && (update.result.resultRef.runId !== update.runId
    || update.result.resultRef.cellId !== cellId || update.result.resultRef.revision !== baseline.revision || update.result.resultRef.accessMode !== "ai")) return current;
  return { ...previous, sequence, statuses: { ...previous.statuses, [cellId]: update.kind === "cell_started" ? "running" : update.result.status },
    results: update.kind === "cell_finished" ? { ...previous.results, [cellId]: update.result } : previous.results };
}
