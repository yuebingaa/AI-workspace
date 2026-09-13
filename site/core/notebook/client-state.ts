import type { DataSourceDefinition } from "@/core/models";
import type { SemanticModel } from "@/core/semantic/contracts";
import type { HarnessNotebookArtifact, HarnessNotebookCell } from "@/core/harness/notebook-contracts";
import type { NotebookDocument } from "./contracts";
import { cellsToRun, updateNotebook } from "./graph";

export function notebookFingerprint(document: NotebookDocument, cellId: string, sources: DataSourceDefinition[], models: SemanticModel[]) {
  const cells = cellsToRun(document, cellId);
  const ids = new Set(cells.flatMap((cell) => cell.kind === "data" ? [cell.sourceDataSourceId] : []));
  const modelIds = new Set(cells.flatMap((cell) => cell.kind === "semanticQuery" ? [cell.modelId] : []));
  // Source IDs are immutable uploads. Include schema/version/policy and missing
  // sources; results from a deleted or rebound source are never fresh.
  return JSON.stringify({ cells, sources: sources.filter((source) => ids.has(source.id)), models: models.filter((model) => modelIds.has(model.id)) });
}
export function notebookDiff(current: NotebookDocument, draft: Pick<HarnessNotebookArtifact, "cells">) {
  return {
    added: draft.cells.filter((cell) => !current.cells.some((item) => item.id === cell.id)).map((cell) => cell.title),
    changed: draft.cells.filter((cell) => current.cells.some((item) => item.id === cell.id && JSON.stringify(item) !== JSON.stringify(cell))).map((cell) => cell.title),
    removed: current.cells.filter((cell) => !draft.cells.some((item) => item.id === cell.id)).map((cell) => cell.title),
  };
}
export function adoptNotebookDraft(current: NotebookDocument, draft: HarnessNotebookArtifact): NotebookDocument {
  if (current.lastDraftId === draft.id) throw new Error("这个草稿已经采用");
  if (draft.baseRevision === undefined ? current.cells.length > 0 : draft.baseRevision !== current.revision) {
    throw new Error("Notebook 已在草稿生成后修改，请让 AI 基于当前版本重新生成；未覆盖已有步骤");
  }
  if (draft.cells.some((cell) => cell.kind === "sql" || cell.kind === "transform" || cell.kind === "warehouseSql") && draft.executionEvidence?.status !== "success") throw new Error("SQL / DataRecipe 草稿缺少成功试运行证据，请重新生成");
  return { ...updateNotebook(current, draft.cells, draft.name), lastDraftId: draft.id };
}
export function moveNotebookCell(document: NotebookDocument, id: string, direction: -1 | 1) {
  const cells = [...document.cells];
  const index = cells.findIndex((cell) => cell.id === id);
  const next = index + direction;
  if (index < 0 || next < 0 || next >= cells.length) return document;
  [cells[index], cells[next]] = [cells[next], cells[index]];
  return updateNotebook(document, cells);
}
export function notebookOutputCells(cells: HarnessNotebookCell[]) {
  return cells.filter((cell): cell is Extract<HarnessNotebookCell, { outputName: string }> => "outputName" in cell);
}
