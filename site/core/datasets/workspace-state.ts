import type { ChangeSetExecutionState } from "@/core/changesets";
import type { AppSpec, DataProduct, LocalDataRuntime } from "@/core/models";
import type { DataRow } from "@/core/models";
import type { UploadedDatasetDescriptor } from "./contracts";

export interface DatasetWorkspaceState {
  execution: ChangeSetExecutionState;
  dataProduct: DataProduct;
  dataRuntime: LocalDataRuntime;
}

function withoutDataSource(appSpec: AppSpec, dataSourceId: string): AppSpec {
  return { ...appSpec, dataSources: appSpec.dataSources.filter((source) => source.id !== dataSourceId) };
}

function withDataSource(appSpec: AppSpec, descriptor: UploadedDatasetDescriptor): AppSpec {
  const exists = appSpec.dataSources.some((source) => source.id === descriptor.datasetId);
  return {
    ...appSpec,
    dataSources: exists
      ? appSpec.dataSources.map((source) => source.id === descriptor.datasetId ? descriptor.source : source)
      : [...appSpec.dataSources, descriptor.source],
  };
}

function datasetReference(descriptor: UploadedDatasetDescriptor) {
  return {
    id: descriptor.datasetId,
    name: descriptor.source.name,
    rowCount: descriptor.source.rowCount,
    columnCount: descriptor.source.columnCount,
    qualityScore: descriptor.source.qualityScore,
    expiresAt: descriptor.expiresAt,
    ephemeral: true,
    sensitiveFieldCount: descriptor.sensitiveFields.length,
    aiAccessPolicy: descriptor.aiAccessPolicy,
  };
}

export function synchronizeUploadedDatasetExecution(
  current: ChangeSetExecutionState,
  descriptor: UploadedDatasetDescriptor,
): ChangeSetExecutionState {
  return {
    ...current,
    present: withDataSource(current.present, descriptor),
    preview: current.preview
      ? { ...current.preview, appSpec: withDataSource(current.preview.appSpec, descriptor) }
      : null,
    history: current.history.map((entry) => ({
      ...entry,
      appSpec: withDataSource(entry.appSpec, descriptor),
    })),
  };
}

export function synchronizeUploadedDatasetProduct(
  current: DataProduct,
  descriptor: UploadedDatasetDescriptor,
): DataProduct {
  const reference = datasetReference(descriptor);
  return {
    ...current,
    datasets: current.datasets.some((item) => item.id === descriptor.datasetId)
      ? current.datasets.map((item) => item.id === descriptor.datasetId ? reference : item)
      : [...current.datasets, reference],
    recipes: [
      ...current.recipes.filter((recipe) => recipe.id !== descriptor.recipe.id && recipe.sourceDatasetId !== descriptor.datasetId),
      descriptor.recipe,
    ],
    appSpec: withDataSource(current.appSpec, descriptor),
  };
}

export function synchronizeUploadedDatasetWorkspace(
  current: DatasetWorkspaceState,
  descriptor: UploadedDatasetDescriptor,
  rows?: DataRow[],
): DatasetWorkspaceState {
  const execution = synchronizeUploadedDatasetExecution(current.execution, descriptor);
  return {
    execution,
    dataProduct: { ...synchronizeUploadedDatasetProduct(current.dataProduct, descriptor), appSpec: execution.present },
    dataRuntime: rows === undefined ? current.dataRuntime : {
      rowsByDataSourceId: {
        ...current.dataRuntime.rowsByDataSourceId,
        [descriptor.datasetId]: structuredClone(rows),
      },
    },
  };
}

function mapExecutionDataSources(state: ChangeSetExecutionState, dataSourceId: string): ChangeSetExecutionState {
  return {
    ...state,
    present: withoutDataSource(state.present, dataSourceId),
    preview: state.preview
      ? { ...state.preview, appSpec: withoutDataSource(state.preview.appSpec, dataSourceId) }
      : null,
    history: state.history.map((entry) => ({
      ...entry,
      appSpec: withoutDataSource(entry.appSpec, dataSourceId),
    })),
  };
}

export function removeUploadedDatasetFromWorkspace(
  current: DatasetWorkspaceState,
  dataSourceId: string,
): DatasetWorkspaceState {
  const execution = mapExecutionDataSources(current.execution, dataSourceId);
  return {
    execution,
    dataProduct: {
      ...current.dataProduct,
      datasets: current.dataProduct.datasets.filter((item) => item.id !== dataSourceId),
      recipes: current.dataProduct.recipes.filter((recipe) => recipe.sourceDatasetId !== dataSourceId),
      appSpec: execution.present,
    },
    dataRuntime: {
      rowsByDataSourceId: Object.fromEntries(
        Object.entries(current.dataRuntime.rowsByDataSourceId).filter(([id]) => id !== dataSourceId),
      ),
    },
  };
}
