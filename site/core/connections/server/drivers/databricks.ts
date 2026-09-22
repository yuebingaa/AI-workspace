import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { readBoundedUtf8Body } from "@/core/http/server/bounded-body";
import type { ConnectionConfig } from "../../configuration";
import { CONNECTION_QUERY_LIMITS, ConnectionQueryError, type ConnectionDriver } from "../query-contracts";
import { tableFromText } from "../result-table";
import { resolveConnectionCredential } from "../local-config";

const LIMIT = CONNECTION_QUERY_LIMITS.rows;
const TIMEOUT = CONNECTION_QUERY_LIMITS.timeoutMs;

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
export class DatabricksDriver implements ConnectionDriver {
  constructor(private readonly config: Extract<ConnectionConfig, { kind: "databricks" }>) {}

  schemaSql(): string {
    const namespace = `\`${this.config.catalog}\`.information_schema.columns`;
    return `SELECT table_schema, table_name, column_name, data_type FROM ${namespace} WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_schema, table_name, ordinal_position LIMIT 501`;
  }

  async execute(sql: string, signal: AbortSignal) {
    const config = this.config;
    const token = resolveConnectionCredential(config);
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
        row_limit: LIMIT + 1, byte_limit: CONNECTION_QUERY_LIMITS.outputBytes,
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
}
