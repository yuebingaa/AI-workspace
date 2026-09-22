import type { DataSourceDefinition } from "@/core/models";
import type { SemanticModel } from "@/core/semantic/contracts";
import type { NotebookArtifact, NotebookCell } from "@/core/notebook/definition";
import type { NotebookDocument } from "./contracts";
import { cellsToRun, updateNotebook } from "./graph";
import { requiresSuccessfulNotebookTrial } from "./cell-catalog";

export function notebookFingerprint(document: NotebookDocument, cellId: string, sources: DataSourceDefinition[], models: SemanticModel[]) {
  const cells = cellsToRun(document, cellId);
  const ids = new Set(cells.flatMap((cell) => cell.kind === "data" ? [cell.sourceDataSourceId] : []));
  const modelIds = new Set(cells.flatMap((cell) => cell.kind === "semanticQuery" ? [cell.modelId] : []));
  // Source IDs are immutable uploads. Include schema/version/policy and missing
  // sources; results from a deleted or rebound source are never fresh.
  return JSON.stringify({ cells, sources: sources.filter((source) => ids.has(source.id)), models: models.filter((model) => modelIds.has(model.id)) });
}
export function notebookDiff(current: NotebookDocument, draft: Pick<NotebookArtifact, "cells">) {
  return {
    added: draft.cells.filter((cell) => !current.cells.some((item) => item.id === cell.id)).map((cell) => cell.title),
    changed: draft.cells.filter((cell) => current.cells.some((item) => item.id === cell.id && JSON.stringify(item) !== JSON.stringify(cell))).map((cell) => cell.title),
    removed: current.cells.filter((cell) => !draft.cells.some((item) => item.id === cell.id)).map((cell) => cell.title),
  };
}
/** Adoption preflight only; runtime still validates version, source, members and access. */
export function notebookSemanticModelIssue(cells: readonly NotebookCell[], models: readonly SemanticModel[]): string | undefined {
  const ids = new Set(models.map((model) => model.id));
  const missing = cells.filter((cell) => cell.kind === "semanticQuery" && !ids.has(cell.modelId));
  if (!missing.length) return undefined;
  return `草稿引用的语义模型已删除或不在当前工作界面，暂不能采用：${missing.slice(0, 3).map((cell) => `${cell.title} (${cell.id})`).join("；")}${missing.length > 3 ? `；另有 ${missing.length - 3} 个单元` : ""}。请基于当前模型重新生成草稿；现有 Notebook 未改动。`;
}
export function adoptNotebookDraft(current: NotebookDocument, draft: NotebookArtifact): NotebookDocument {
  if (current.lastDraftId === draft.id) throw new Error("这个草稿已经采用");
  if (draft.baseRevision === undefined ? current.cells.length > 0 : draft.baseRevision !== current.revision) {
    throw new Error("Notebook 已在草稿生成后修改，请让 AI 基于当前版本重新生成；未覆盖已有步骤");
  }
  if (draft.cells.some(requiresSuccessfulNotebookTrial) && draft.executionEvidence?.status !== "success") throw new Error(
    draft.cells.some((cell) => cell.kind === "text" && cell.references?.length) ? "文本引用草稿缺少成功试运行证据，请重新生成"
      : draft.cells.some((cell) => cell.kind === "parameter") ? "计算 / 参数草稿缺少成功试运行证据，请重新生成" : "SQL / Python / DataRecipe 草稿缺少成功试运行证据，请重新生成",
  );
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
export function notebookOutputCells(cells: NotebookCell[]) {
  return cells.filter((cell): cell is Extract<NotebookCell, { outputName: string }> => "outputName" in cell);
}
