import { connectionSchemaSchema, type ConnectionSchema } from "../contracts";
import type { DataTable } from "@/core/datasets/table-contracts";
import { normalizeReadOnlySql } from "@/core/sql/read-only-query";
import {
  CONNECTION_QUERY_LIMITS, ConnectionQueryError,
  type ConnectionQueryDependencies, type ConnectionQueryInput, type ConnectionSchemaInput, type ConnectionQueryService,
} from "./query-contracts";

const TIMEOUT = CONNECTION_QUERY_LIMITS.timeoutMs;

/** One service per server runtime, not per request: concurrency is shared by all callers. */
export function createConnectionQueryService(dependencies: ConnectionQueryDependencies): ConnectionQueryService {
  let active = 0;
  async function executeConnectionSql(input: ConnectionQueryInput): Promise<DataTable> {
    const config = dependencies.resolveConnection(input.connectionId, input.project, input.forAi ?? false);
    const credentialIdentity = dependencies.credentialIdentity?.(config);
    const sql = normalizeReadOnlySql(input.sql);
    const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT);
    signal.throwIfAborted();
    if (active >= CONNECTION_QUERY_LIMITS.maxConcurrent) throw new ConnectionQueryError("已有两个数据库查询运行中，请稍后重试");
    active++;
    try {
      const table = await dependencies.driverFor(config).execute(sql, signal);
      signal.throwIfAborted();
      // A concurrent configuration revocation invalidates the result too.
      if (JSON.stringify(dependencies.resolveConnection(input.connectionId, input.project, input.forAi ?? false)) !== JSON.stringify(config)) throw new ConnectionQueryError("连接配置已变化，请重新运行");
      if (dependencies.credentialIdentity?.(config) !== credentialIdentity) throw new ConnectionQueryError("连接凭据已变化，请重新运行");
      return table;
    } catch (error) {
      if (signal.aborted) throw new ConnectionQueryError("数据库查询已取消或超时");
      // Provider error details may contain credentials, SQL literals or private URLs.
      if (error instanceof ConnectionQueryError) throw error;
      const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
      throw new ConnectionQueryError(`数据库查询失败${/^[A-Z0-9]{5}$/u.test(code) ? `（${code}）` : ""}，请检查连接权限、SQL 字段与类型`);
    } finally { active--; }
  }
  async function inspectConnectionSchema(input: ConnectionSchemaInput): Promise<ConnectionSchema> {
    const config = dependencies.resolveConnection(input.connectionId, input.project, input.forAi ?? false);
    const table = await executeConnectionSql({ ...input, sql: dependencies.driverFor(config).schemaSql() });
    return connectionSchemaSchema.parse({ columns: table.rows.slice(0, 500), truncated: table.truncated || table.rows.length > 500 });
  }
  return { executeConnectionSql, inspectConnectionSchema };
}
