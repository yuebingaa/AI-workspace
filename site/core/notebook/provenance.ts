import type { NotebookDatasetProvenance } from "@/core/datasets/provenance";
import { notebookDatasetProvenanceSchema } from "@/core/datasets/provenance";
import type { NotebookDocument, NotebookRun } from "./contracts";
import { cellDependencies, cellsToRun } from "./graph";

/** Persist only the selected result's dependency closure, never unrelated cells or result rows. */
export function notebookDatasetProvenance(document: NotebookDocument, run: NotebookRun, cellId: string): NotebookDatasetProvenance {
  if (document.revision !== run.revision) throw new Error("Notebook 版本已变化，不能保存旧结果来源");
  const cells = cellsToRun(document, cellId);
  const result = run.cells.find((cell) => cell.cellId === cellId);
  if (result?.status !== "success" || !result.resultRef?.complete) throw new Error("结果不完整，不能保存来源记录");
  const steps = cells.map((cell) => {
    const executed = run.cells.find((item) => item.cellId === cell.id);
    if (!executed || executed.status !== "success") throw new Error("来源步骤未成功执行，不能保存来源记录");
    return { cellId: cell.id, title: cell.title, kind: cell.kind, inputCellIds: cellDependencies(cell),
      definition: JSON.stringify(cell),
      ...(executed.queryId ? { queryId: executed.queryId } : {}),
      ...(executed.resultRef ? { resultId: executed.resultRef.resultId, dataSignature: executed.resultRef.dataSignature } : {}),
      ...(executed.resultRef?.catalogRef ? { catalogRef: executed.resultRef.catalogRef } : {}),
    };
  });
  return notebookDatasetProvenanceSchema.parse({ kind: "notebook", runId: run.runId, resultId: result.resultRef.resultId,
    cellId, revision: run.revision,
    connectionIds: [...new Set(cells.flatMap((cell) => cell.kind === "warehouseSql" ? [cell.connectionId] : []))],
    lineage: { version: 1, recordedAt: run.startedAt, accessMode: result.resultRef.accessMode,
      sourceDatasetIds: [...new Set(cells.flatMap((cell) => cell.kind === "data" ? [cell.sourceDataSourceId] : []))],
      ...(result.resultRef.sourceFiles?.length ? { sourceFiles: result.resultRef.sourceFiles } : {}),
      rowCount: result.resultRef.rowCount, complete: result.resultRef.complete, dataSignature: result.resultRef.dataSignature, steps,
    },
  });
}
