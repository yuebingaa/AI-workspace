import type { NotebookDocument } from "./contracts";
import { affectedCells, cellsToRun, validateNotebook } from "./graph";

/** Only existing literal values may schedule automatic work. Structural edits,
 * restores, additions and removals remain explicit manual execution actions. */
export function parameterValueChanges(previous: NotebookDocument, next: NotebookDocument): string[] {
  const before = validateNotebook(previous);
  const after = validateNotebook(next);
  if (previous.name !== next.name || previous.lastDraftId !== next.lastDraftId || before.length !== after.length) return [];
  const changed: string[] = [];
  for (let index = 0; index < before.length; index += 1) {
    const oldCell = before[index], newCell = after[index];
    if (JSON.stringify(oldCell) === JSON.stringify(newCell)) continue;
    if (oldCell.id !== newCell.id || oldCell.kind !== "parameter" || newCell.kind !== "parameter") return [];
    const withOldValue = { ...newCell, parameter: { ...newCell.parameter, value: oldCell.parameter.value } };
    if (JSON.stringify(oldCell) !== JSON.stringify(withOldValue)) return [];
    if (!Object.is(oldCell.parameter.value, newCell.parameter.value)) changed.push(newCell.id);
  }
  return changed;
}

export interface NotebookParameterRecompute {
  document: NotebookDocument;
  parameterCellIds: string[];
  affectedCellIds: string[];
  executionCellIds: string[];
}

/** Union descendants first, then their required ancestors. The ordinary run API
 * executes this validated closed subgraph without cached browser rows or a new
 * revision. The returned cells keep display order; execution IDs are topological. */
export function selectParameterRecompute(document: NotebookDocument, parameterIds: readonly string[]): NotebookParameterRecompute {
  const cells = validateNotebook(document);
  const parameters = new Set(parameterIds);
  if (!parameters.size) throw new Error("没有需要重新计算的参数");
  for (const id of parameters) {
    if (!cells.some((cell) => cell.id === id && cell.kind === "parameter")) throw new Error(`需要重新计算的参数不存在：${id}`);
  }
  const affected = affectedCells(cells, [...parameters]);
  const execution = new Set<string>();
  for (const id of affected) for (const cell of cellsToRun(document, id)) execution.add(cell.id);
  const selected = { ...document, cells: cells.filter((cell) => execution.has(cell.id)) };
  return {
    document: selected,
    parameterCellIds: cells.filter((cell) => parameters.has(cell.id)).map((cell) => cell.id),
    affectedCellIds: cells.filter((cell) => affected.has(cell.id)).map((cell) => cell.id),
    executionCellIds: cellsToRun(selected).map((cell) => cell.id),
  };
}
