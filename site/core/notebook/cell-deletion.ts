import type { NotebookCell } from "./definition";
import type { NotebookDocument } from "./contracts";
import { affectedCells, cellDependencies, updateNotebook } from "./graph";

export interface NotebookCellDeletionReview {
  targetId: string;
  baseline: string;
  cells: Array<{
    cellId: string;
    title: string;
    kind: NotebookCell["kind"];
    outputName?: string;
    relation: "target" | "direct" | "transitive";
  }>;
  retainedCount: number;
}

/** A local review of explicit cascade deletion, not a persisted execution or resource change. */
export function prepareNotebookCellDeletion(document: NotebookDocument, targetId: string): NotebookCellDeletionReview {
  if (!document.cells.some((cell) => cell.id === targetId)) throw new Error("要删除的单元已不在当前文档中，请重新选择。");
  const removed = affectedCells(document.cells, [targetId]);
  return {
    targetId,
    baseline: JSON.stringify(document),
    cells: document.cells.filter((cell) => removed.has(cell.id)).map((cell) => ({
      cellId: cell.id, title: cell.title, kind: cell.kind,
      ...("outputName" in cell ? { outputName: cell.outputName } : {}),
      relation: cell.id === targetId ? "target" : cellDependencies(cell).includes(targetId) ? "direct" : "transitive",
    })),
    retainedCount: document.cells.filter((cell) => !removed.has(cell.id)).length,
  };
}

export function isNotebookCellDeletionStale(document: NotebookDocument, review: NotebookCellDeletionReview): boolean {
  return JSON.stringify(document) !== review.baseline;
}

export function confirmNotebookCellDeletion(document: NotebookDocument, review: NotebookCellDeletionReview): NotebookDocument {
  if (isNotebookCellDeletionStale(document, review)) throw new Error("Notebook 已变化，本次删除确认已过期，未删除任何单元。请关闭后重新查看删除影响。");
  if (!document.cells.some((cell) => cell.id === review.targetId)) throw new Error("要删除的单元已不在当前文档中，请重新选择。");
  // Recompute from the unchanged definition, never from mutable display entries.
  // Validate only the remainder so deletion can still repair an invalid draft.
  const removed = affectedCells(document.cells, [review.targetId]);
  return updateNotebook(document, document.cells.filter((cell) => !removed.has(cell.id)));
}
