import type { StudioPersistedState } from "@/core/repository/studio-repository";
import type { ProjectTable } from "./contracts";

/** The project catalog owns dataset metadata, including names and access policy. */
export function normalizeProjectStateForStorage(value: StudioPersistedState, tables: readonly ProjectTable[]): StudioPersistedState {
  const state = structuredClone(value);
  const live = new Map(tables.filter((table) => !table.deletedAt).map((table) => [table.descriptor.datasetId, table.descriptor]));
  state.appSpec.dataSources = state.appSpec.dataSources.map((source) => structuredClone(live.get(source.id)?.source ?? source));
  state.dataProduct.appSpec = state.appSpec;
  state.dataProduct.datasets = state.dataProduct.datasets.map((entry) => {
    const descriptor = live.get(entry.id);
    return descriptor ? { ...entry, name: descriptor.source.name, ephemeral: false, expiresAt: undefined, shared: true } : entry;
  });
  return state;
}
