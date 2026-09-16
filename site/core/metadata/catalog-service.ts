import {
  CATALOG_LIMITS, catalogColumnInputSchema, catalogSnapshotSchema,
  type CatalogAccess, type CatalogBinding, type CatalogColumnInput, type CatalogRepository, type CatalogSnapshot, type CatalogSummary,
} from "./contracts";

export interface CatalogDependencies {
  authorize(access: CatalogAccess): CatalogBinding;
  inspect(access: CatalogAccess, signal?: AbortSignal): Promise<{ columns: CatalogColumnInput[]; complete: boolean }>;
  repository: CatalogRepository;
  fingerprint(value: string): string;
  now(): Date;
}

/** Catalog use cases have no dependency on drivers, credentials, filesystem or UI. */
export function createCatalogService(deps: CatalogDependencies) {
  function read(access: CatalogAccess): CatalogSnapshot | null {
    const binding = deps.authorize(access);
    const snapshot = deps.repository.get(binding.key);
    if (deps.authorize(access).key !== binding.key) throw new Error("连接配置已变化，请重新读取目录");
    return snapshot;
  }
  function summary(snapshot: CatalogSnapshot): CatalogSummary {
    const age = deps.now().getTime() - Date.parse(snapshot.reference.syncedAt);
    return { ...snapshot.reference, freshness: age >= 0 && age < CATALOG_LIMITS.freshMs ? "fresh" : "stale",
      storage: deps.repository.storage, tableCount: new Set(snapshot.columns.map((column) => column.tableId)).size };
  }
  async function refresh(access: CatalogAccess, signal?: AbortSignal): Promise<CatalogSnapshot> {
    signal?.throwIfAborted();
    const binding = deps.authorize(access);
    const previous = deps.repository.get(binding.key);
    const source = await deps.inspect(access, signal);
    signal?.throwIfAborted();
    if (deps.authorize(access).key !== binding.key) throw new Error("连接配置已变化，本次目录未保存");
    if (source.columns.length > CATALOG_LIMITS.columns) throw new Error("目录超出字段数量限制");
    const columns = source.columns.map((column) => catalogColumnInputSchema.parse(column))
      .sort((a, b) => JSON.stringify([a.catalog, a.schema, a.table, a.name]).localeCompare(JSON.stringify([b.catalog, b.schema, b.table, b.name]), "en"));
    const identities = columns.map((column) => JSON.stringify([column.catalog, column.schema, column.table, column.name]));
    if (new Set(identities).size !== identities.length) throw new Error("目录存在重复字段，未覆盖上次同步结果");
    const snapshot = catalogSnapshotSchema.parse({
      reference: { id: `catalog_${deps.fingerprint(binding.key).slice(0, 32)}`, connectionId: binding.connectionId,
        revision: (previous?.reference.revision ?? 0) + 1, syncedAt: deps.now().toISOString(), complete: source.complete,
        schemaFingerprint: deps.fingerprint(JSON.stringify({ columns, complete: source.complete })) },
      columns: columns.map((column) => ({ ...column,
        tableId: `relation_${deps.fingerprint(JSON.stringify([binding.key, column.catalog, column.schema, column.table])).slice(0, 32)}`,
        columnId: `column_${deps.fingerprint(JSON.stringify([binding.key, column.catalog, column.schema, column.table, column.name])).slice(0, 32)}`,
      })),
    });
    deps.repository.save(binding.key, snapshot, previous?.reference.revision ?? null);
    return snapshot;
  }
  async function inspect(access: CatalogAccess, options: { refresh?: boolean; signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    const snapshot = read(access);
    return snapshot && !options.refresh && summary(snapshot).freshness === "fresh" ? snapshot : refresh(access, options.signal);
  }
  return { read, summary, refresh, inspect };
}
