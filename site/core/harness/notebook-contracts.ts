/**
 * Compatibility exports for existing Harness callers.
 * Notebook owns the shared definitions; keep these aliases until old consumers migrate.
 */
export {
  MAX_NOTEBOOK_CELLS as MAX_HARNESS_NOTEBOOK_CELLS,
  notebookCellSchema as harnessNotebookCellSchema,
  notebookDraftSchema as harnessNotebookDraftSchema,
  notebookArtifactSchema as harnessNotebookArtifactSchema,
} from "@/core/notebook/definition";
export type {
  NotebookCell as HarnessNotebookCell,
  NotebookDraft as HarnessNotebookDraft,
  NotebookArtifact as HarnessNotebookArtifact,
} from "@/core/notebook/definition";
