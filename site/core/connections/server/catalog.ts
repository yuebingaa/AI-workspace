import { createHash } from "node:crypto";
import { createCatalogService } from "@/core/metadata/catalog-service";
import { CATALOG_LIMITS, type CatalogAccess, type CatalogRepository } from "@/core/metadata/contracts";
import { catalogStoreSchema, createCatalogRepository } from "@/core/metadata/server/catalog-repository";
import { configuredSnapshotAdapter } from "@/core/persistence/server/json-file-snapshot";
import { resolveConnection } from "./config";
import { resolveConnectionCredential } from "./local-config";
import type { ConnectionSchema } from "../contracts";
import type { ConnectionSchemaInput } from "./query-contracts";

const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex");

export function createConnectionCatalog(inspectSource: (input: ConnectionSchemaInput) => Promise<ConnectionSchema>) {
  const memory = createCatalogRepository();
  function repository() {
    const adapter = configuredSnapshotAdapter("connection-catalog.json", catalogStoreSchema, CATALOG_LIMITS.bytes);
    return adapter ? createCatalogRepository(adapter) : memory;
  }
  const persistence: CatalogRepository = {
    get storage() { return repository().storage; },
    get: (key) => repository().get(key), save: (key, snapshot, revision) => repository().save(key, snapshot, revision),
  };
  function authorize(access: CatalogAccess) {
    const config = resolveConnection(access.connectionId, access.project, access.forAi ?? false);
    const credential = resolveConnectionCredential(config) ?? "";
    const identity = config.kind === "postgresql"
      ? [config.kind, config.host, config.port, config.database, config.user, config.ssl]
      : [config.kind, config.host, config.warehouseId, config.catalog, config.schema];
    // Only this irreversible digest is persisted. Names, secrets and connection hosts are not catalog fields.
    return { connectionId: config.id, key: fingerprint(JSON.stringify([
      config.id, access.project, Boolean(access.forAi), identity, fingerprint(credential), process.env.STUDIO_LOCAL_STATE_DIR ?? "",
    ])) };
  }
  return createCatalogService({ authorize, repository: persistence, fingerprint, now: () => new Date(),
    inspect: async (access, signal) => {
      const config = resolveConnection(access.connectionId, access.project, access.forAi ?? false);
      const source = await inspectSource({ ...access, signal });
      return { complete: !source.truncated, columns: source.columns.map((column) => ({
        catalog: column.table_catalog ?? (config.kind === "postgresql" ? config.database : config.catalog),
        schema: column.table_schema, table: column.table_name, name: column.column_name, dataType: column.data_type,
      })) };
    },
  });
}
