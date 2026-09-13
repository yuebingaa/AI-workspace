import type { HarnessNotebookCell } from "@/core/harness/notebook-contracts";
import { notebookDocumentSchema, type NotebookDocument } from "./contracts";

export function cellDependencies(cell: HarnessNotebookCell): string[] {
  return cell.kind === "sql" ? cell.inputCellIds : "inputCellId" in cell ? [cell.inputCellId] : [];
}
export function validateNotebook(document: NotebookDocument): HarnessNotebookCell[] {
  const { cells } = notebookDocumentSchema.parse(document);
  const seen = new Map<string, HarnessNotebookCell>();
  const outputs = new Set<string>();
  for (const cell of cells) {
    if (seen.has(cell.id)) throw new Error(`单元 ID 重复：${cell.id}`);
    if ("outputName" in cell) {
      if (outputs.has(cell.outputName)) throw new Error(`输出名称重复：${cell.outputName}`);
      outputs.add(cell.outputName);
    }
    for (const id of cellDependencies(cell)) {
      const upstream = seen.get(id);
      if (!upstream || !("outputName" in upstream)) throw new Error(`“${cell.title}”必须引用排在它之前的数据、SQL 或语义查询单元：${id}`);
    }
    seen.set(cell.id, cell);
  }
  return cells;
}
export function cellsToRun(document: NotebookDocument, targetId?: string): HarnessNotebookCell[] {
  const cells = validateNotebook(document);
  if (!targetId) return cells;
  if (!cells.some((cell) => cell.id === targetId)) throw new Error("要运行的单元不存在");
  const selected = new Set([targetId]);
  for (const cell of [...cells].reverse()) if (selected.has(cell.id)) cellDependencies(cell).forEach((id) => selected.add(id));
  return cells.filter((cell) => selected.has(cell.id));
}
export function affectedCells(cells: HarnessNotebookCell[], changedIds: string[]): Set<string> {
  const affected = new Set(changedIds);
  // Also used to explain deletions in invalid/in-progress drafts.
  for (let pass = 0; pass < cells.length; pass += 1) {
    let changed = false;
    for (const cell of cells) if (!affected.has(cell.id) && cellDependencies(cell).some((id) => affected.has(id))) {
      affected.add(cell.id); changed = true;
    }
    if (!changed) break;
  }
  return affected;
}
export function updateNotebook(document: NotebookDocument, cells: HarnessNotebookCell[], name = document.name): NotebookDocument {
  const next = notebookDocumentSchema.parse({ ...document, name, revision: document.revision + 1, cells });
  validateNotebook(next);
  return next;
}
