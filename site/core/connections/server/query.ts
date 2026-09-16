import { resolveConnection } from "./config";
import { createConnectionQueryService } from "./query-service";
import { PostgresDriver } from "./drivers/postgres";
import { DatabricksDriver } from "./drivers/databricks";
import { createConnectionCatalog } from "./catalog";
import type { ConnectionQueryInput, ConnectionSchemaInput } from "./query-contracts";
import type { NotebookTable } from "@/core/notebook/contracts";
import type { CatalogReference } from "@/core/metadata/contracts";
import type { ConnectionSchema } from "../contracts";

// Shared by the connection API, Notebook and Harness. Do not instantiate per request.
const service = createConnectionQueryService({
  resolveConnection,
  driverFor: (config) => config.kind === "postgresql" ? new PostgresDriver(config) : new DatabricksDriver(config),
});

const catalog = createConnectionCatalog(service.inspectConnectionSchema);

export async function executeConnectionSql(input: ConnectionQueryInput): Promise<NotebookTable & { catalogRef?: CatalogReference }> {
  // This records discovery context only; it is not a claim that SQL dependencies were parsed or source data was versioned.
  const snapshot = catalog.read(input);
  const table = await service.executeConnectionSql(input);
  if (snapshot && catalog.read(input)?.reference.id !== snapshot.reference.id) throw new Error("连接身份已变化，请重新运行查询");
  return snapshot ? { ...table, catalogRef: snapshot.reference } : table;
}
export async function inspectConnectionSchema(input: ConnectionSchemaInput & { refresh?: boolean }): Promise<ConnectionSchema> {
  const snapshot = await catalog.inspect(input, { signal: input.signal, refresh: input.refresh });
  return { columns: snapshot.columns.map((column) => ({ table_catalog: column.catalog,
    table_schema: column.schema, table_name: column.table, column_name: column.name, data_type: column.dataType,
    table_id: column.tableId, column_id: column.columnId,
  })), truncated: !snapshot.reference.complete, catalog: catalog.summary(snapshot) };
}
