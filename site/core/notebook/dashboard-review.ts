import type { UploadedDatasetDescriptor } from "@/core/datasets/contracts";
import { notebookCellSchema, type NotebookCell } from "./definition";
import type { NotebookDocument } from "./contracts";

/** Window-owned review metadata. The authoritative result and lineage remain in Dataset. */
export interface NotebookDashboardReview {
  changeSetId: string;
  pageId: string;
  datasetId: string;
  cellId: string;
  title: string;
  rowCount: number;
  columnCount: number;
  createdAt: string;
  storageMode: "project" | "temporary";
  runId?: string;
  revision?: number;
  definitions?: Array<{ cellId: string; definition: string }>;
}

export function createNotebookDashboardReview(
  changeSetId: string, pageId: string, cell: NotebookCell, dataset: UploadedDatasetDescriptor,
): NotebookDashboardReview {
  const provenance = dataset.provenance;
  if (provenance && provenance.cellId !== cell.id) throw new Error("快照来源与当前单元不一致，请重新生成预览");
  return {
    changeSetId, pageId, datasetId: dataset.datasetId, cellId: cell.id, title: cell.title,
    rowCount: dataset.source.rowCount, columnCount: dataset.source.fields.length,
    createdAt: dataset.createdAt, storageMode: dataset.storageMode ?? "temporary",
    ...(provenance ? { runId: provenance.runId, revision: provenance.revision } : {}),
    ...(provenance?.lineage ? { definitions: provenance.lineage.steps.map(({ cellId, definition }) => ({ cellId, definition })) } : {}),
  };
}

/** Definition comparison only: this never claims live source data is unchanged. */
export function notebookSnapshotDefinitionStatus(
  review: NotebookDashboardReview, document?: NotebookDocument,
): "matching" | "changed" | "unknown" {
  if (!review.definitions?.length || !review.definitions.some((step) => step.cellId === review.cellId)) return "unknown";
  if (!document) return "changed";
  for (const step of review.definitions) {
    const current = document.cells.find((cell) => cell.id === step.cellId);
    if (!current) return "changed";
    try {
      const saved = notebookCellSchema.parse(JSON.parse(step.definition));
      if (saved.id !== step.cellId) return "unknown";
      if (JSON.stringify(saved) !== JSON.stringify(notebookCellSchema.parse(current))) return "changed";
    } catch { return "unknown"; }
  }
  return "matching";
}
