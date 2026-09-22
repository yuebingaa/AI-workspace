import { notebookRunSchema, type NotebookDocument, type NotebookRun } from "./contracts";
import { cellsToRun } from "./graph";

export interface NotebookRunExpectation {
  readonly revision: number;
  readonly accessMode: "user" | "ai";
  readonly cellIds: readonly string[];
  readonly textCellIds?: readonly string[];
}

/** Capture before invoking a runner; neither its artifact nor its receipt owns this expectation. */
export function captureNotebookRunExpectation(
  document: NotebookDocument,
  accessMode: "user" | "ai",
  targetCellId?: string,
): NotebookRunExpectation {
  const cells = cellsToRun(document, targetCellId);
  const cellIds = Object.freeze(cells.map((cell) => cell.id));
  const textCellIds = Object.freeze(cells.filter((cell) => cell.kind === "text" && cell.references?.length).map((cell) => cell.id));
  return Object.freeze({ revision: document.revision, accessMode, cellIds, ...(textCellIds.length ? { textCellIds } : {}) });
}

const mismatch = () => new Error("执行回执与本次草稿不一致，不能作为验证证据。");

/** Consistency at a live runner boundary, not authorization or proof of result authenticity.
 * Optional legacy references stay optional. Actual execution truncation can still be
 * a successful trial; a bounded display preview is not an incomplete computation.
 */
export function parseNotebookRunReceipt(raw: unknown, expected: NotebookRunExpectation): NotebookRun {
  const parsed = notebookRunSchema.safeParse(raw);
  if (!parsed.success) throw mismatch();
  const run = parsed.data;
  if (run.revision !== expected.revision || run.cells.length !== expected.cellIds.length
    || run.cells.some((cell, index) => cell.cellId !== expected.cellIds[index])
    || (run.status === "success") !== run.cells.every((cell) => cell.status === "success")) throw mismatch();
  for (const cell of run.cells) {
    const expectsText = expected.textCellIds?.includes(cell.cellId) ?? false;
    if (cell.status === "success" && expectsText && typeof cell.text !== "string") throw mismatch();
    if (cell.text !== undefined && (!expectsText || cell.status !== "success" || cell.table || cell.resultRef)) throw mismatch();
    const reference = cell.resultRef;
    if (!reference) continue;
    if (reference.runId !== run.runId || reference.cellId !== cell.cellId || reference.revision !== expected.revision
      || reference.accessMode !== expected.accessMode) throw mismatch();
    if (cell.table && (reference.rowCount < cell.table.rows.length
      || cell.table.truncated !== (!reference.complete || reference.rowCount > cell.table.rows.length))) throw mismatch();
  }
  return run;
}
