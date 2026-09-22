import type { NotebookCellRun, NotebookResultReference } from "./contracts";
import type { NotebookCell } from "./definition";
import { notebookDashboardSizeIssue } from "./dashboard-policy";

/** Captured from the enclosing run, not inferred from a cell's own reference. */
export type NotebookRunIdentity = Pick<NotebookResultReference, "runId" | "revision" | "accessMode">;

export interface NotebookResultAvailability {
  previewRowCount: number;
  /** Returned row count; only a complete result establishes the full cardinality. */
  knownRowCount: number | null;
  completeness: "complete" | "incomplete" | "unknown" | "inconsistent";
  previewOnly: boolean;
  canSaveDataset: boolean;
  canSnapshot: boolean;
}

/** Presentation/save affordances only. The server independently authorizes and reruns saves. */
export function notebookResultAvailability(
  cell: Pick<NotebookCell, "id" | "kind">,
  result: NotebookCellRun,
  execution?: NotebookRunIdentity,
): NotebookResultAvailability {
  const previewRowCount = result.table?.rows.length ?? 0;
  const unavailable: NotebookResultAvailability = {
    previewRowCount, knownRowCount: null, completeness: "unknown", previewOnly: false,
    canSaveDataset: false, canSnapshot: false,
  };
  if (result.status !== "success" || !result.table) return unavailable;
  const inconsistent: NotebookResultAvailability = { ...unavailable, completeness: "inconsistent" };
  if (cell.id !== result.cellId) return inconsistent;

  const reference = result.resultRef;
  let knownRowCount: number;
  let complete: boolean;
  if (reference) {
    if (!execution || reference.runId !== execution.runId || reference.revision !== execution.revision
      || reference.accessMode !== execution.accessMode || reference.cellId !== cell.id || reference.mode !== "table"
      || !Number.isSafeInteger(reference.rowCount) || reference.rowCount < previewRowCount
      || result.table.truncated !== (!reference.complete || reference.rowCount > previewRowCount)) return inconsistent;
    knownRowCount = reference.rowCount;
    complete = reference.complete;
  } else {
    // Older non-truncated receipts already contain their complete result. A truncated
    // legacy preview provides no trustworthy total and cannot enable save actions.
    if (result.table.truncated) return unavailable;
    knownRowCount = previewRowCount;
    complete = true;
  }
  const canSaveDataset = complete && knownRowCount > 0 && cell.kind !== "data";
  return {
    previewRowCount, knownRowCount, completeness: complete ? "complete" : "incomplete",
    previewOnly: knownRowCount > previewRowCount,
    canSaveDataset, canSnapshot: canSaveDataset && !notebookDashboardSizeIssue(cell.kind, knownRowCount, result.table.fields.length),
  };
}
