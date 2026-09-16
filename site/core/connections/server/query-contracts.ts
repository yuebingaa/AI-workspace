import type { ConnectionConfig } from "../configuration";
import type { ConnectionSchema } from "../contracts";
import { NOTEBOOK_LIMITS, type NotebookTable } from "@/core/notebook/contracts";

export const CONNECTION_QUERY_LIMITS = { rows: NOTEBOOK_LIMITS.rows, timeoutMs: 12_000, maxConcurrent: 2 } as const;

/** Only safe, deliberately authored messages may cross the query boundary. */
export class ConnectionQueryError extends Error {}

export interface ConnectionQueryInput {
  connectionId: string;
  project: string | null;
  sql: string;
  forAi?: boolean;
  signal?: AbortSignal;
}
export type ConnectionSchemaInput = Omit<ConnectionQueryInput, "sql">;

/** A backend bound to one validated configuration; dialect and cancellation stay here. */
export interface ConnectionDriver {
  execute(sql: string, signal: AbortSignal): Promise<NotebookTable>;
  schemaSql(): string;
}

export interface ConnectionQueryDependencies {
  resolveConnection(id: string, project: string | null, forAi: boolean): ConnectionConfig;
  driverFor(config: ConnectionConfig): ConnectionDriver;
}
export interface ConnectionQueryService {
  executeConnectionSql(input: ConnectionQueryInput): Promise<NotebookTable>;
  inspectConnectionSchema(input: ConnectionSchemaInput): Promise<ConnectionSchema>;
}
