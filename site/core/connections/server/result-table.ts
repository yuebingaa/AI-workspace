import { dataTableSchema, type DataTable } from "@/core/datasets/table-contracts";
import { CONNECTION_QUERY_LIMITS, ConnectionQueryError } from "./query-contracts";

const LIMIT = CONNECTION_QUERY_LIMITS.rows;
const connectionResultTableSchema = dataTableSchema.extend({ rows: dataTableSchema.shape.rows.max(LIMIT) });

export function tableFromText(fields: DataTable["fields"], raw: unknown[][], truncated: boolean): DataTable {
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
  const table = connectionResultTableSchema.parse({ fields, rows, truncated: truncated || raw.length > LIMIT });
  if (Buffer.byteLength(JSON.stringify(table)) > CONNECTION_QUERY_LIMITS.outputBytes) throw new ConnectionQueryError("数据库结果超过 2 MiB，请减少返回列或先聚合");
  return table;
}
