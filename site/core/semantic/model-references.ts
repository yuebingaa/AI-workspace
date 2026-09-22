import type { DataProduct } from "@/core/models/data-product";

export interface SemanticModelReference {
  pageId: string;
  notebookName: string;
  cellId: string;
  cellTitle: string;
}

// Only saved Notebook definitions establish references; selections and code text do not.
export function semanticModelReferences(product: Pick<DataProduct, "notebooks">, modelId: string): SemanticModelReference[] {
  const references: SemanticModelReference[] = [];
  for (const [pageId, notebook] of Object.entries(product.notebooks ?? {})) {
    for (const cell of notebook.cells) {
      if (cell.kind === "semanticQuery" && cell.modelId === modelId) {
        references.push({ pageId, notebookName: notebook.name, cellId: cell.id, cellTitle: cell.title });
      }
    }
  }
  return references;
}
