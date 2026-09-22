import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listConnections, readConnectionConfigs, resolveConnection } from "./config";
import { executeConnectionSql, inspectConnectionSchema } from "./query";

const pg = vi.hoisted(() => ({ queries: [] as unknown[], rows: [] as unknown[][], fields: [] as Array<{ name: string; dataTypeID: number }>, ended: 0, connections: 0,
  options: [] as unknown[], timeoutCallbacks: 0, callbackError: null as (Error & { code?: string }) | null }));
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");
  class Query extends EventEmitter { constructor(readonly config: { callback?: (error: Error | null) => void }) { super(); } }
  class Client extends EventEmitter {
    constructor(options: unknown) { super(); pg.options.push(options); }
    async connect() { pg.connections++; }
    async end() { pg.ended++; }
    query(value: string | Query) {
      pg.queries.push(typeof value === "string" ? value : value.config);
      if (typeof value === "string") return Promise.resolve({ rows: [] });
      // pg 8 wraps Query.callback whenever Client.query_timeout is set. The old
      // event-only mock missed its undefined callback crash even on success.
      const callback = value.config.callback;
      if (!callback) throw new TypeError("queryCallback is not a function");
      queueMicrotask(() => {
        pg.timeoutCallbacks++;
        if (pg.callbackError) { callback(pg.callbackError); return; }
        pg.rows.forEach((row) => value.emit("row", row)); callback(null);
        value.emit("end", { fields: pg.fields });
      });
      return value;
    }
  }
  return { Client, Query };
});
const postgres = { id: "pg_test", name: "PostgreSQL", kind: "postgresql", projects: ["local"], allowAi: false, host: "127.0.0.1", database: "test", user: "readonly", passwordEnv: "TEST_SQL_PASSWORD", ssl: false };
const databricks = { id: "db_test", name: "Databricks", kind: "databricks", projects: ["local"], allowAi: true, host: "https://warehouse.example", warehouseId: "abc123", tokenEnv: "TEST_SQL_TOKEN", catalog: "main" };
beforeEach(() => {
  vi.stubEnv("STUDIO_SQL_CONNECTIONS", JSON.stringify([postgres, databricks]));
  vi.stubEnv("TEST_SQL_PASSWORD", "private-password"); vi.stubEnv("TEST_SQL_TOKEN", "private-token");
  pg.queries = []; pg.rows = [["7", "9007199254740993", "t"]];
  pg.fields = [{ name: "amount", dataTypeID: 23 }, { name: "exact", dataTypeID: 20 }, { name: "enabled", dataTypeID: 16 }];
  pg.connections = 0; pg.ended = 0; pg.options = []; pg.timeoutCallbacks = 0; pg.callbackError = null;
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("connection authorization and provider adapters", () => {
  it("returns only public descriptors, scopes projects and denies Agent by default", () => {
    expect(listConnections(null)).toHaveLength(2);
    expect(listConnections(null, true).map((item) => item.id)).toEqual(["db_test"]);
    expect(listConnections("00000000-0000-4000-8000-000000000000")).toEqual([]);
    expect(JSON.stringify(listConnections(null))).not.toMatch(/password|token|host|user|projects/iu);
    expect(() => resolveConnection("pg_test", null, true)).toThrow("未授权");
    expect(() => resolveConnection("pg_test", "another-project", false)).toThrow("未授权");
  });
  it("redacts invalid config diagnostics", () => {
    expect(() => readConnectionConfigs({ NODE_ENV: "test", STUDIO_SQL_CONNECTIONS: '{"secret":"private-token"}' })).toThrow("配置无效");
    expect(() => readConnectionConfigs({ NODE_ENV: "test", STUDIO_SQL_CONNECTIONS: JSON.stringify([postgres, postgres]) })).toThrow("配置无效");
  });
  it("executes PostgreSQL in a read-only transaction, bounds rows, and preserves precision", async () => {
    const result = await executeConnectionSql({ connectionId: "pg_test", project: null, sql: "SELECT * FROM sales" });
    expect(pg.queries[0]).toBe("BEGIN READ ONLY");
    expect(pg.queries[1]).toMatchObject({ text: expect.stringContaining("LIMIT 1001"), rowMode: "array" });
    expect(pg.options[0]).toMatchObject({ statement_timeout: 12_000, query_timeout: 12_500,
      connectionTimeoutMillis: 5_000, lock_timeout: 2_000, idle_in_transaction_session_timeout: 12_000 });
    expect(result.rows).toEqual([{ amount: 7, exact: "9007199254740993", enabled: true }]);
    expect(pg.ended).toBeGreaterThan(0);
  });
  it("keeps PostgreSQL decimal, bigint and timestamp values as exact source text", async () => {
    pg.fields = [{ name: "decimal", dataTypeID: 1700 }, { name: "bigint", dataTypeID: 20 },
      { name: "date", dataTypeID: 1082 }, { name: "timestamp", dataTypeID: 1114 }, { name: "zoned", dataTypeID: 1184 }];
    pg.rows = [["123.456789012345678901", "9007199254740993", "2026-09-16", "2026-09-16 12:34:56.123456", "2026-09-16 12:34:56.123456+08"]];
    const result = await executeConnectionSql({ connectionId: "pg_test", project: null, sql: "SELECT * FROM sales" });
    expect(result.fields.map(({ type }) => type)).toEqual(["string", "string", "date", "date", "date"]);
    expect(result.rows).toEqual([Object.fromEntries(pg.fields.map((field, index) => [field.name, pg.rows[0][index]]))]);
  });
  it("denies unauthorized calls and mutation scripts before opening a connection", async () => {
    await expect(executeConnectionSql({ connectionId: "pg_test", project: null, forAi: true, sql: "SELECT 1" })).rejects.toThrow("未授权");
    await expect(executeConnectionSql({ connectionId: "pg_test", project: null, sql: "SELECT 1; DELETE FROM sales" })).rejects.toThrow("一条查询");
    expect(pg.connections).toBe(0);
  });
  it("supplies a streaming query timeout callback on success and handles callback-only provider errors", async () => {
    await expect(executeConnectionSql({ connectionId: "pg_test", project: null, sql: "SELECT 1" })).resolves.toMatchObject({ truncated: false });
    expect(pg.timeoutCallbacks).toBe(1);
    pg.callbackError = Object.assign(new Error("private-password and private SQL literal"), { code: "42P01" });
    await expect(executeConnectionSql({ connectionId: "pg_test", project: null, sql: "SELECT missing FROM sales" }))
      .rejects.toThrow("数据库查询失败（42P01），请检查连接权限、SQL 字段与类型");
    expect(pg.timeoutCallbacks).toBe(2);
    expect(pg.ended).toBe(2);
  });
  it("marks truncation and rejects duplicate fields and oversized results", async () => {
    pg.rows = Array.from({ length: 1001 }, () => ["1", "2", "t"]);
    const result = await executeConnectionSql({ connectionId: "pg_test", project: null, sql: "SELECT * FROM sales" });
    expect(result.rows).toHaveLength(1000); expect(result.truncated).toBe(true);
    pg.fields = [{ name: "same", dataTypeID: 23 }, { name: "same", dataTypeID: 23 }];
    await expect(executeConnectionSql({ connectionId: "pg_test", project: null, sql: "SELECT * FROM sales" })).rejects.toThrow("不重名");
    pg.rows = [["a".repeat(3 * 1024 * 1024)]];
    await expect(executeConnectionSql({ connectionId: "pg_test", project: null, sql: "SELECT * FROM sales" })).rejects.toThrow("2 MiB");
  });
  it("polls Databricks statements, marks multi-chunk results partial, never follows external result URLs", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ statement_id: "stmt_1", status: { state: "RUNNING" } }))
      .mockResolvedValueOnce(Response.json({ statement_id: "stmt_1", status: { state: "SUCCEEDED" }, manifest: { total_chunk_count: 2, schema: { columns: [{ name: "exact", type_name: "DECIMAL" }] } }, result: { data_array: [["123.4567890123456789"]], next_chunk_index: 1 } }));
    vi.stubGlobal("fetch", fetcher);
    const result = await executeConnectionSql({ connectionId: "db_test", project: null, forAi: true, sql: "SELECT exact FROM sales" });
    expect(result.rows).toEqual([{ exact: "123.4567890123456789" }]); expect(result.truncated).toBe(true);
    expect(fetcher.mock.calls[1][0]).toBe("https://warehouse.example/api/2.0/sql/statements/stmt_1");
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ disposition: "INLINE", row_limit: 1001, byte_limit: 2 * 1024 * 1024 });
  });
  it("cancels a Databricks statement and does not return late results", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<(url: string, init: RequestInit) => Promise<Response>>().mockImplementation(async (url) => {
      if (url.endsWith("/cancel")) return Response.json({});
      setTimeout(() => controller.abort(), 20);
      return Response.json({ statement_id: "stmt_2", status: { state: "RUNNING" } });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(executeConnectionSql({ connectionId: "db_test", project: null, sql: "SELECT 1", signal: controller.signal })).rejects.toThrow("取消");
    expect(fetcher.mock.calls.some(([url]) => url.endsWith("/stmt_2/cancel"))).toBe(true);
    const cancel = fetcher.mock.calls.find(([url]) => url.endsWith("/stmt_2/cancel"));
    expect(cancel?.[1]).toMatchObject({ method: "POST", signal: expect.any(AbortSignal), redirect: "error" });
    expect(cancel?.[1].signal).not.toBe(controller.signal);
    expect(cancel?.[1].signal?.aborted).toBe(false);
  });
  it("does not expose remote error text or credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ private: "private-token" }, { status: 401 })));
    await expect(executeConnectionSql({ connectionId: "db_test", project: null, sql: "SELECT 1" })).rejects.toThrow("HTTP 401");
  });
  it("normalizes the table directory through the same authorized execution path", async () => {
    pg.fields = ["table_schema", "table_name", "column_name", "data_type"].map((name) => ({ name, dataTypeID: 25 }));
    pg.rows = [["public", "sales", "amount", "numeric"]];
    const schema = await inspectConnectionSchema({ connectionId: "pg_test", project: null, refresh: true });
    expect(schema).toMatchObject({ columns: [{ table_catalog: "test", table_schema: "public", table_name: "sales", column_name: "amount", data_type: "numeric",
      table_id: expect.stringMatching(/^relation_/u), column_id: expect.stringMatching(/^column_/u) }], truncated: false,
      catalog: { complete: true, freshness: "fresh", tableCount: 1 } });
    const count = pg.connections;
    expect(await inspectConnectionSchema({ connectionId: "pg_test", project: null })).toEqual(schema);
    expect(pg.connections).toBe(count);
    pg.fields = [{ name: "amount", dataTypeID: 23 }]; pg.rows = [["230"]];
    const queried = await executeConnectionSql({ connectionId: "pg_test", project: null, sql: "SELECT amount FROM sales" });
    expect(queried.rows).toEqual([{ amount: 230 }]);
    expect(queried.catalogRef).toMatchObject({ id: schema.catalog!.id, revision: schema.catalog!.revision });
  });
});
