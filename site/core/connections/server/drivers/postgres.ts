import { Client, type QueryArrayConfig } from "pg";
import type { ConnectionConfig } from "../../configuration";
import { NOTEBOOK_LIMITS } from "@/core/notebook/contracts";
import { CONNECTION_QUERY_LIMITS, ConnectionQueryError, type ConnectionDriver } from "../query-contracts";
import { tableFromText } from "../result-table";

const LIMIT = CONNECTION_QUERY_LIMITS.rows;
const TIMEOUT = CONNECTION_QUERY_LIMITS.timeoutMs;

function pgType(oid: number): "number" | "boolean" | "date" | "string" {
  if ([21, 23, 26, 700, 701].includes(oid)) return "number";
  if (oid === 16) return "boolean";
  if ([1082, 1114, 1184].includes(oid)) return "date";
  return "string"; // int8, numeric and complex types preserve exact text.
}
export class PostgresDriver implements ConnectionDriver {
  constructor(private readonly config: Extract<ConnectionConfig, { kind: "postgresql" }>) {}

  schemaSql(): string {
    return "SELECT table_schema, table_name, column_name, data_type FROM information_schema.columns WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position LIMIT 501";
  }

  async execute(sql: string, signal: AbortSignal) {
    const config = this.config;
    const password = process.env[config.passwordEnv];
    if (!password) throw new ConnectionQueryError("连接的服务端密码尚未配置");
    const client = new Client({ host: config.host, port: config.port, database: config.database, user: config.user, password,
      ssl: config.ssl ? { rejectUnauthorized: true } : false, connectionTimeoutMillis: 5_000,
      statement_timeout: TIMEOUT, query_timeout: TIMEOUT + 500, lock_timeout: 2_000,
      idle_in_transaction_session_timeout: TIMEOUT, application_name: "AgentCanvasNotebook",
    });
    client.on("error", () => {}); // Query/connect promises report errors without leaking connection details.
    const stop = () => { void client.end().catch(() => {}); };
    signal.throwIfAborted(); signal.addEventListener("abort", stop, { once: true });
    try {
      await client.connect(); signal.throwIfAborted();
      await client.query("BEGIN READ ONLY");
      // Bound bytes as rows arrive, not after building an unbounded result object.
      const { Query } = await import("pg");
      const raw: unknown[][] = [];
      let bytes = 0;
      const result = await new Promise<{ fields: Array<{ name: string; dataTypeID: number }> }>((resolve, reject) => {
        const queryConfig: QueryArrayConfig = { text: `SELECT * FROM (\n${sql}\n) AS agentcanvas_result LIMIT ${LIMIT + 1}`,
          rowMode: "array", types: { getTypeParser: () => (value: string) => value } };
        const query = new Query(queryConfig);
        query.on("row", (row: unknown[]) => {
          bytes += Buffer.byteLength(JSON.stringify(row));
          if (bytes > NOTEBOOK_LIMITS.outputBytes) { reject(new ConnectionQueryError("数据库结果超过 2 MiB")); stop(); return; }
          raw.push(row);
        });
        query.on("error", reject); query.on("end", resolve);
        client.query(query);
      });
      signal.throwIfAborted();
      return tableFromText(result.fields.map((field) => ({ name: field.name, label: field.name, type: pgType(field.dataTypeID) })), raw, false);
    } finally { signal.removeEventListener("abort", stop); await client.end().catch(() => {}); }
  }
}
