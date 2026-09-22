import { describe, expect, it, vi } from "vitest";
import { connectionConfigSchema } from "../configuration";
import type { DataTable } from "@/core/datasets/table-contracts";
import { createConnectionQueryService } from "./query-service";
import { ConnectionQueryError, type ConnectionDriver } from "./query-contracts";

// No pg, network, environment or provider mock: exercise the application through its port.
const config = connectionConfigSchema.parse([{ id: "test", name: "Test", kind: "postgresql", projects: ["local"], allowAi: true,
  host: "127.0.0.1", database: "test", user: "readonly", passwordEnv: "TEST_ONLY_PASSWORD" }])[0];
const table: DataTable = { fields: [{ name: "exact", label: "exact", type: "string" }], rows: [{ exact: "9007199254740993" }], truncated: false };
const input = { connectionId: "test", project: null, forAi: true, sql: "SELECT exact FROM sample;" };

function setup(execute: ConnectionDriver["execute"] = async () => table) {
  const driver: ConnectionDriver = { execute: vi.fn(execute), schemaSql: vi.fn(() => "SELECT * FROM custom_catalog") };
  const resolveConnection = vi.fn(() => config);
  const driverFor = vi.fn(() => driver);
  return { service: createConnectionQueryService({ resolveConnection, driverFor }), driver, resolveConnection, driverFor };
}

function gate() {
  let release!: (value: DataTable) => void;
  const promise = new Promise<DataTable>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("connection query application boundary", () => {
  it("normalizes SQL, propagates scope, and rechecks configuration before returning the unchanged result", async () => {
    const { service, driver, resolveConnection, driverFor } = setup();
    expect(await service.executeConnectionSql(input)).toBe(table);
    expect(driver.execute).toHaveBeenCalledWith("SELECT exact FROM sample", expect.any(AbortSignal));
    expect(resolveConnection.mock.calls).toEqual([["test", null, true], ["test", null, true]]);
    expect(driverFor).toHaveBeenCalledWith(config);
  });

  it("keeps dialect-specific schema SQL inside the driver and uses the same authorized query path", async () => {
    const columns = { fields: ["table_schema", "table_name", "column_name", "data_type"].map((name) => ({ name, label: name, type: "string" as const })),
      rows: [{ table_schema: "public", table_name: "sample", column_name: "exact", data_type: "numeric" }], truncated: false };
    const { service, driver, resolveConnection } = setup(async () => columns);
    expect(await service.inspectConnectionSchema(input)).toEqual({ columns: columns.rows, truncated: false });
    expect(driver.schemaSql).toHaveBeenCalledTimes(1);
    expect(driver.execute).toHaveBeenCalledWith("SELECT * FROM custom_catalog", expect.any(AbortSignal));
    expect(resolveConnection).toHaveBeenCalledTimes(3);
  });

  it("rejects unauthorized scope and invalid statements before constructing a driver", async () => {
    const { service, resolveConnection, driverFor } = setup();
    resolveConnection.mockImplementationOnce(() => { throw new Error("未授权"); });
    await expect(service.executeConnectionSql(input)).rejects.toThrow("未授权");
    await expect(service.executeConnectionSql({ ...input, sql: "SELECT 1; DELETE FROM sample" })).rejects.toThrow("一条查询");
    expect(driverFor).not.toHaveBeenCalled();
  });

  it("shares two concurrency slots and releases them after successful or failed calls", async () => {
    const pending = gate();
    const { service, driver } = setup(() => pending.promise);
    const first = service.executeConnectionSql(input);
    const second = service.executeConnectionSql(input);
    await expect(service.executeConnectionSql(input)).rejects.toThrow("两个数据库查询");
    expect(driver.execute).toHaveBeenCalledTimes(2);
    pending.release(table);
    await expect(Promise.all([first, second])).resolves.toEqual([table, table]);
    await expect(service.executeConnectionSql(input)).resolves.toBe(table);
    const failing = setup(async () => { throw new Error("private backend details"); });
    for (let attempt = 0; attempt < 3; attempt++) await expect(failing.service.executeConnectionSql(input)).rejects.toThrow("数据库查询失败");
    expect(failing.driver.execute).toHaveBeenCalledTimes(3);
  });

  it("does not start cancelled queries, propagates aborts, and rejects late results", async () => {
    const pending = gate();
    const { service, driver } = setup(() => pending.promise);
    await expect(service.executeConnectionSql({ ...input, signal: AbortSignal.abort() })).rejects.toThrow();
    expect(driver.execute).not.toHaveBeenCalled();
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const delayed = setup((_sql, signal) => { received = signal; return pending.promise; });
    const promise = delayed.service.executeConnectionSql({ ...input, signal: controller.signal });
    controller.abort();
    expect(received?.aborted).toBe(true);
    pending.release(table);
    await expect(promise).rejects.toThrow("取消或超时");
    await expect(delayed.service.executeConnectionSql(input)).resolves.toBe(table);
  });

  it("discards results when permission/configuration changes during a query", async () => {
    const { service, resolveConnection } = setup();
    resolveConnection.mockReturnValueOnce(config).mockReturnValueOnce({ ...config, allowAi: false });
    await expect(service.executeConnectionSql(input)).rejects.toThrow("连接配置已变化");
  });

  it("uses the connection's 12-second deadline and rejects a result returned after it", async () => {
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    try {
      const pending = gate();
      const { service, driver } = setup(() => pending.promise);
      const running = service.executeConnectionSql(input);
      expect(timeout).toHaveBeenCalledWith(12_000);
      expect(driver.execute).toHaveBeenCalledWith("SELECT exact FROM sample", timeoutController.signal);
      timeoutController.abort(new DOMException("Synthetic timeout", "TimeoutError"));
      pending.release(table);
      await expect(running).rejects.toThrow("数据库查询已取消或超时");
    } finally { timeout.mockRestore(); }
  });

  it("discards a late result after the injected credential identity changes", async () => {
    const pending = gate();
    let identity = "first-opaque-identity";
    const service = createConnectionQueryService({ resolveConnection: () => config,
      driverFor: () => ({ execute: () => pending.promise, schemaSql: () => "SELECT 1" }),
      credentialIdentity: () => identity });
    const running = service.executeConnectionSql(input);
    identity = "changed-opaque-identity";
    pending.release(table);
    await expect(running).rejects.toThrow("连接凭据已变化");
    await expect(service.executeConnectionSql(input)).resolves.toBe(table);
  });

  it("redacts provider exceptions while preserving deliberately safe errors and SQLSTATE", async () => {
    const secretError = Object.assign(new Error("private password and SQL literals"), { code: "42501" });
    await expect(setup(async () => { throw secretError; }).service.executeConnectionSql(input))
      .rejects.toThrow("数据库查询失败（42501），请检查连接权限、SQL 字段与类型");
    const safeError = new ConnectionQueryError("查询结果需要唯一别名");
    await expect(setup(async () => { throw safeError; }).service.executeConnectionSql(input)).rejects.toBe(safeError);
  });
});
