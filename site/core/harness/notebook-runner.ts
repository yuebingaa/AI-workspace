import type { NotebookArtifact } from "@/core/notebook/definition";
import type { NotebookDraftExecutionContext } from "@/core/notebook/execution-contracts";
import type { LocalDataRuntime } from "@/core/models";
import type { HarnessRequest } from "./contracts";

/** Project only the reviewed draft's execution data, without sharing mutable tool state. */
export function notebookDraftExecutionContext(
  artifact: NotebookArtifact,
  context: {
    request: Pick<HarnessRequest, "appSpec" | "notebookContext" | "semanticModel" | "idempotencyKey">;
    dataRuntime: LocalDataRuntime;
    signal?: AbortSignal;
  },
): NotebookDraftExecutionContext {
  const sources = artifact.sourceDataSourceIds.map((id) => {
    const source = context.request.appSpec.dataSources.find((item) => item.id === id);
    const rows = context.dataRuntime.rowsByDataSourceId[id];
    if (!source || !rows) throw new Error("Notebook 源数据不可用");
    return { source, rows };
  });
  return {
    ...structuredClone({
      revision: context.request.notebookContext?.document.revision ?? 0,
      sources,
      semanticModels: context.request.semanticModel ? [context.request.semanticModel] : [],
      taskId: `harness_${context.request.idempotencyKey}`,
    }),
    signal: context.signal,
  };
}
