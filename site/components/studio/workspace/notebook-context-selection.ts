import type { NotebookDocument } from "@/core/notebook/contracts";
import { MAX_NOTEBOOK_CONTEXT_SELECTION, normalizeNotebookContextSelection } from "@/core/notebook/context-selection";

export interface NotebookContextSelectionState { scopeKey: string; ids: string[] }

/** Selection is window-local focus, never an extra copy of parameter values or results. */
export function reconcileNotebookContextSelection(state: NotebookContextSelectionState, scopeKey: string, document: NotebookDocument): NotebookContextSelectionState {
  if (state.scopeKey !== scopeKey) return { scopeKey, ids: [] };
  const ids = normalizeNotebookContextSelection(document, state.ids);
  return ids.length === state.ids.length && ids.every((id, index) => id === state.ids[index]) ? state : { scopeKey, ids };
}

export function toggleNotebookContextSelection(state: NotebookContextSelectionState, scopeKey: string, document: NotebookDocument, id: string): NotebookContextSelectionState {
  // A callback retained by an old menu must not select into another page/thread.
  if (state.scopeKey !== scopeKey) return state;
  const current = reconcileNotebookContextSelection(state, scopeKey, document);
  if (!document.cells.some((cell) => cell.id === id)) return current;
  if (current.ids.includes(id)) return { scopeKey, ids: current.ids.filter((item) => item !== id) };
  if (current.ids.length >= MAX_NOTEBOOK_CONTEXT_SELECTION) return current;
  return { scopeKey, ids: [...current.ids, id] };
}

export function composerNotebookContext(document: NotebookDocument, sourceIds: string[], selectedCellIds: readonly string[], mode: "agent" | "notebook" | "canvas") {
  const selected = normalizeNotebookContextSelection(document, selectedCellIds);
  // The AI workbench and Notebook are two views of the same current document.
  // Canvas keeps its opt-in focus; this metadata does not grant data access.
  if (mode === "canvas" && !selected.length) return undefined;
  return { document, sourceIds, ...(selected.length ? { selectedCellIds: selected } : {}) };
}
