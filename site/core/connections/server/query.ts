import { Client, type QueryArrayConfig } from "pg";
import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { NOTEBOOK_LIMITS, notebookTableSchema, type NotebookTable } from "@/core/notebook/contracts";
import { normalizeNotebookSql } from "@/core/notebook/sql";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import { resolveConnection, type ConnectionConfig } from "./config";
import { connectionSchemaSchema, type ConnectionSchema } from "../contracts";

const LIMIT = NOTEBOOK_LIMITS.rows;
const TIMEOUT = 12_000;
let active = 0;
class ConnectionQueryError extends Error {}

function pgType(oid: number): "number" | "boolean" | "date" | "string" {
  if ([21, 23, 26, 700, 701].includes(oid)) return "number";
  if (oid === 16) return "boolean";
  if ([1082, 1114, 1184].includes(oid)) return "date";
  return "string"; // int8, numeric and complex types preserve exact text.
}
function tableFromText(fields: NotebookTable["fields"], raw: unknown[][], truncated: boolean): NotebookTable {
  if (!fields.length || fields.length > 100 || new Set(fields.map((item) => item.name)).size !== fields.length) throw new ConnectionQueryError("查询结果需要 1–100 个不重名的字段，请在 SQL 中指定唯一别名");
  const rows = raw.slice(0, LIMIT).map((row) => Object.fromEntries(fields.map((field, i) => {
    const value = row[i];
    if (value === null) return [field.name, null];
    if (value === undefined) throw new ConnectionQueryError("查询结果列数不一致");
    if (field.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new ConnectionQueryError("查询结果包含 NaN / Infinity");
      return [field.name, number];
    }
    if (field.type === "boolean") {
      if (![true, false, "true", "false", "t", "f"].includes(value as string | boolean)) throw new ConnectionQueryError("无效布尔结果");
      return [field.name, value === true || value === "true" || value === "t"];
    }
    return [field.name, String(value)];
  })));
  const table = notebookTableSchema.parse({ fields, rows, truncated: truncated || raw.length > LIMIT });
  if (Buffer.byteLength(JSON.stringify(table)) > NOTEBOOK_LIMITS.outputBytes) throw new ConnectionQueryError("数据库结果超过 2 MiB，请减少返回列或先聚合");
  return table;
}

async function postgres(config: Extract<ConnectionConfig, { kind: "postgresql" }>, sql: string, signal: AbortSignal) {
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

const statementSchema = z.object({
  statement_id: z.string().regex(/^[A-Za-z0-9_-]+$/u).max(120),
  status: z.object({ state: z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "CLOSED"]) }),
  manifest: z.object({ truncated: z.boolean().optional(), total_chunk_count: z.number().optional(), total_row_count: z.number().int().nonnegative().optional(),
    schema: z.object({ columns: z.array(z.object({ name: z.string(), type_name: z.string() })) }),
  }).optional(),
  result: z.object({ data_array: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).optional(),
    next_chunk_index: z.number().optional(),
  }).optional(),
});
async function databricks(config: Extract<ConnectionConfig, { kind: "databricks" }>, sql: string, signal: AbortSignal) {
  const token = process.env[config.tokenEnv];
  if (!token) throw new ConnectionQueryError("连接的服务端 Token 尚未配置");
  const base = `${config.host.replace(/\/$/u, "")}/api/2.0/sql/statements`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  async function call(url: string, init: RequestInit, requestSignal: AbortSignal) {
    const response = await fetch(url, { ...init, headers, signal: requestSignal, redirect: "error" });
    if (!response.ok) throw new ConnectionQueryError(`Databricks 请求失败（HTTP ${response.status}）`);
    return statementSchema.parse(JSON.parse(await readBoundedUtf8Body(response, 3 * 1024 * 1024, { signal: requestSignal, timeoutMs: TIMEOUT })));
  }
  let id: string | undefined;
  let completed = false;
  try {
    let response = await call(base, { method: "POST", body: JSON.stringify({
      warehouse_id: config.warehouseId, catalog: config.catalog, schema: config.schema,
      statement: `SELECT * FROM (\n${sql}\n) AS agentcanvas_result LIMIT ${LIMIT + 1}`,
      format: "JSON_ARRAY", disposition: "INLINE", wait_timeout: "0s",
      row_limit: LIMIT + 1, byte_limit: NOTEBOOK_LIMITS.outputBytes,
    }) }, signal);
    id = response.statement_id;
    while (["PENDING", "RUNNING"].includes(response.status.state)) {
      await delay(350, undefined, { signal });
      response = await call(`${base}/${id}`, { method: "GET" }, signal);
    }
    if (response.status.state !== "SUCCEEDED") throw new ConnectionQueryError(`Databricks 查询状态：${response.status.state}`);
    completed = true;
    if (!response.manifest) throw new ConnectionQueryError("Databricks 未返回字段结构");
    if (!response.result?.data_array && response.manifest.total_row_count !== 0) throw new ConnectionQueryError("Databricks 未返回完整结果数据");
    // Never silently treat the first result chunk as a complete table.
    const truncated = response.manifest.truncated || (response.manifest.total_chunk_count ?? 1) > 1 || response.result?.next_chunk_index !== undefined
      || (response.manifest.total_row_count ?? 0) > (response.result?.data_array?.length ?? 0);
    return tableFromText(response.manifest.schema.columns.map((column) => ({ name: column.name, label: column.name,
      type: ["BYTE", "SHORT", "INT", "FLOAT", "DOUBLE"].includes(column.type_name) ? "number" : column.type_name === "BOOLEAN" ? "boolean" : ["DATE", "TIMESTAMP"].includes(column.type_name) ? "date" : "string",
    })), response.result?.data_array ?? [], Boolean(truncated));
  } finally {
    if (id && !completed) {
      // Cancellation uses a fresh, bounded signal after the caller aborts.
      await fetch(`${base}/${id}/cancel`, { method: "POST", headers, signal: AbortSignal.timeout(2_000), redirect: "error" }).catch(() => {});
    }
  }
}

export async function executeConnectionSql(input: { connectionId: string; project: string | null; sql: string; forAi?: boolean; signal?: AbortSignal }): Promise<NotebookTable> {
  const config = resolveConnection(input.connectionId, input.project, input.forAi ?? false);
  const sql = normalizeNotebookSql(input.sql);
  const signal = input.signal ? AbortSignal.any([input.signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT);
  signal.throwIfAborted();
  if (active >= 2) throw new ConnectionQueryError("已有两个数据库查询运行中，请稍后重试");
  active++;
  try {
    const table = await (config.kind === "postgresql" ? postgres(config, sql, signal) : databricks(config, sql, signal));
    signal.throwIfAborted();
    // A concurrent configuration revocation invalidates the result too.
    if (JSON.stringify(resolveConnection(input.connectionId, input.project, input.forAi ?? false)) !== JSON.stringify(config)) throw new ConnectionQueryError("连接配置已变化，请重新运行");
    return table;
  } catch (error) {
    if (signal.aborted) throw new ConnectionQueryError("数据库查询已取消或超时");
    // Provider error details may contain credentials, SQL literals or private URLs.
    if (error instanceof ConnectionQueryError) throw error;
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    throw new ConnectionQueryError(`数据库查询失败${/^[A-Z0-9]{5}$/u.test(code) ? `（${code}）` : ""}，请检查连接权限、SQL 字段与类型`);
  } finally { active--; }
}
export async function inspectConnectionSchema(input: { connectionId: string; project: string | null; forAi?: boolean; signal?: AbortSignal }): Promise<ConnectionSchema> {
  const config = resolveConnection(input.connectionId, input.project, input.forAi ?? false);
  const namespace = config.kind === "databricks" ? `\`${config.catalog}\`.information_schema.columns` : "information_schema.columns";
  const table = await executeConnectionSql({ ...input, sql: `SELECT table_schema, table_name, column_name, data_type FROM ${namespace} WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position LIMIT 501` });
  return connectionSchemaSchema.parse({ columns: table.rows.slice(0, 500), truncated: table.truncated || table.rows.length > 500 });
}
