import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookDocument } from "@/core/notebook/contracts";
import { updateNotebook } from "@/core/notebook/graph";
import { analyzeNotebookOutputRenames } from "@/core/notebook/output-renames";

/** A pending local edit, never persisted or passed to the execution API. */
export function prepareNotebookCellSave(document: NotebookDocument, cell: NotebookCell) {
  if (!document.cells.some((item) => item.id === cell.id)) throw new Error("此单元已不在当前文档中，请重新打开编辑器。");
  const candidate = updateNotebook(document, document.cells.map((item) => item.id === cell.id ? cell : item));
  return {
    cellId: cell.id,
    baseline: JSON.stringify(document),
    candidate,
    renames: analyzeNotebookOutputRenames(document.cells, candidate.cells),
  };
}

export type NotebookCellSaveReview = ReturnType<typeof prepareNotebookCellSave>;

export function isNotebookCellSaveStale(document: NotebookDocument, review: NotebookCellSaveReview) {
  // Also detect same-revision replacements instead of trusting the revision alone.
  return JSON.stringify(document) !== review.baseline;
}

export function confirmNotebookCellSave(document: NotebookDocument, review: NotebookCellSaveReview): NotebookDocument {
  if (isNotebookCellSaveStale(document, review)) throw new Error("文档已变化，本次待保存内容已过期，不会覆盖当前文档。请重新编辑。");
  return review.candidate;
}
