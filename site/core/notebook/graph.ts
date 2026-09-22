import type { NotebookCell } from "@/core/notebook/definition";
import { notebookDocumentSchema, type NotebookDocument } from "./contracts";

export function cellDependencies(cell: NotebookCell): string[] {
  if (cell.kind === "text") return [...new Set(cell.references?.map((reference) => reference.cellId) ?? [])];
  return cell.kind === "sql" || cell.kind === "python" ? cell.inputCellIds : "inputCellId" in cell ? [cell.inputCellId] : [];
}

/** Stable Kahn ordering: a newly ready earlier display cell runs first. */
function dependencyOrder(cells: NotebookCell[]): NotebookCell[] {
  const remaining = new Map<string, number>();
  const consumers = new Map<string, string[]>();
  for (const cell of cells) {
    const dependencies = new Set(cellDependencies(cell));
    remaining.set(cell.id, dependencies.size);
    for (const id of dependencies) consumers.set(id, [...(consumers.get(id) ?? []), cell.id]);
  }
  const ordered: NotebookCell[] = [];
  while (ordered.length < cells.length) {
    // At most 30 cells; scanning in display order makes the tie-break explicit.
    const ready = cells.find((cell) => remaining.get(cell.id) === 0);
    if (!ready) {
      const blocked = cells.filter((cell) => remaining.has(cell.id)).map((cell) => cell.id);
      throw new Error(`Notebook 存在循环依赖，无法调度这些单元：${blocked.join("、")}`);
    }
    remaining.delete(ready.id);
    ordered.push(ready);
    for (const id of consumers.get(ready.id) ?? []) remaining.set(id, remaining.get(id)! - 1);
  }
  return ordered;
}

/** Validate the whole document but retain its presentation order. */
export function validateNotebook(document: NotebookDocument): NotebookCell[] {
  const { cells } = notebookDocumentSchema.parse(document);
  const seen = new Map<string, NotebookCell>();
  const outputs = new Set<string>();
  for (const cell of cells) {
    if (seen.has(cell.id)) throw new Error(`单元 ID 重复：${cell.id}`);
    if ("outputName" in cell) {
      if (outputs.has(cell.outputName)) throw new Error(`输出名称重复：${cell.outputName}`);
      outputs.add(cell.outputName);
    }
    seen.set(cell.id, cell);
  }
  for (const cell of cells) {
    for (const id of cellDependencies(cell)) {
      if (id === cell.id) throw new Error(`单元“${cell.title}”不能依赖自身：${id}`);
      const upstream = seen.get(id);
      if (!upstream) throw new Error(`单元“${cell.title}”引用的依赖不存在：${id}`);
      if (!("outputName" in upstream)) throw new Error(`单元“${cell.title}”的依赖未提供表格输出：${id}`);
    }
  }
  dependencyOrder(cells);
  return cells;
}
export function cellsToRun(document: NotebookDocument, targetId?: string): NotebookCell[] {
  const cells = validateNotebook(document);
  if (!targetId) return dependencyOrder(cells);
  const byId = new Map(cells.map((cell) => [cell.id, cell]));
  if (!byId.has(targetId)) throw new Error("要运行的单元不存在");
  const selected = new Set<string>();
  const pending = [targetId];
  while (pending.length) {
    const id = pending.pop()!;
    if (selected.has(id)) continue;
    selected.add(id);
    pending.push(...cellDependencies(byId.get(id)!));
  }
  return dependencyOrder(cells.filter((cell) => selected.has(cell.id)));
}
export function affectedCells(cells: NotebookCell[], changedIds: string[]): Set<string> {
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

/** Safe structural choices in display order, including forward references. */
export function notebookDependencyCandidates(cells: NotebookCell[], cellId: string) {
  const excluded = affectedCells(cells, [cellId]);
  return cells.filter((cell): cell is Extract<NotebookCell, { outputName: string }> =>
    "outputName" in cell && !excluded.has(cell.id));
}

export function updateNotebook(document: NotebookDocument, cells: NotebookCell[], name = document.name): NotebookDocument {
  const next = notebookDocumentSchema.parse({ ...document, name, revision: document.revision + 1, cells });
  validateNotebook(next);
  return next;
}
