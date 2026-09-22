import type { DataProduct } from "@/core/models/data-product";
import { affectedCells } from "./graph";

export interface NotebookFileReference {
  pageId: string;
  notebookName: string;
  cellId: string;
  cellTitle: string;
  downstreamCount: number;
}

/** Current explicit Python inputs only; each cell's downstream count may overlap another's. */
export function notebookFileReferences(notebooks: DataProduct["notebooks"], fileName: string): NotebookFileReference[] {
  const references: NotebookFileReference[] = [];
  for (const [pageId, notebook] of Object.entries(notebooks ?? {})) {
    for (const cell of notebook.cells) {
      if (cell.kind === "python" && cell.fileNames.includes(fileName)) {
        references.push({ pageId, notebookName: notebook.name, cellId: cell.id, cellTitle: cell.title,
          downstreamCount: affectedCells(notebook.cells, [cell.id]).size - 1 });
      }
    }
  }
  return references;
}
