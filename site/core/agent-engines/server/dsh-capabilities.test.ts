import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { harnessRequestSchema } from "@/core/harness/contracts";
import { HarnessRuntime } from "@/core/harness/runtime";
import { runNotebook } from "@/core/notebook/server/runtime";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookRun } from "@/core/notebook/contracts";
import type { DataTable } from "@/core/datasets/table-contracts";
import { createConnectionQueryService } from "@/core/connections/server/query-service";
import type { ConnectionConfig } from "@/core/connections/configuration";
import type { ConnectionDriver } from "@/core/connections/server/query-contracts";
import { runDshEngine, type DshDriverInput, type DshEngineOptions } from "./dsh-engine";

const sourceTable: DataTable = { fields: [
  { name: "region", label: "region", type: "string" }, { name: "amount", label: "amount", type: "number" },
  { name: "exact", label: "exact", type: "string" },
], rows: [{ region: "East", amount: 100, exact: "9007199254740993" },
  { region: "East", amount: 50, exact: null }, { region: "South", amount: 80, exact: "0.12345678901234567890" }], truncated: false };
const queryCells: NotebookCell[] = [
  { id: "remote", kind: "warehouseSql", title: "Authorized database", connectionId: "allowed_db", outputName: "remote_sales", sql: "SELECT region, amount, exact FROM sales" },
  { id: "totals", kind: "sql", title: "Local aggregate", inputCellIds: ["remote"], outputName: "region_totals",
    sql: "SELECT region, SUM(amount)::DOUBLE AS revenue FROM remote_sales GROUP BY region ORDER BY region" },
  { id: "table", kind: "table", title: "Table", inputCellId: "totals", columns: ["region", "revenue"] },
  { id: "chart", kind: "chart", title: "Chart", inputCellId: "totals", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
];
const expectedRows = [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }];
const catalogRef = { id: "catalog_dsh_test", connectionId: "allowed_db", revision: 1, schemaFingerprint: "a".repeat(64),
  syncedAt: "2026-09-22T00:00:00.000Z", complete: true };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("External network/model calls prohibited"); }));
  vi.spyOn(HarnessRuntime.prototype, "run").mockImplementation(async () => { throw new Error("DSH must not invoke the old engine"); });
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); expect(HarnessRuntime.prototype.run).not.toHaveBeenCalled(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture() {
  if (!demoFixtureResult.success) throw new Error("Synthetic app fixture unavailable");
  const request = harnessRequestSchema.parse({ idempotencyKey: `dsh_cap_${crypto.randomUUID().replaceAll("-", "")}`,
    instruction: "查询授权数据库结构并创建数据库 SQL、本地汇总、表格和图表，试运行后提交草稿。", role: "editor", pageId: "page_home",
    appSpec: { ...structuredClone(demoFixtureResult.data.dataProduct.appSpec), dataSources: [] }, recipes: [],
    notebookContext: { sourceIds: [], connections: [{ id: "allowed_db", name: "Synthetic readonly", kind: "postgresql", allowAi: true }],
      document: { name: "DSH database", revision: 4, cells: [] } } });
  const config: ConnectionConfig = { id: "allowed_db", name: "Synthetic readonly", kind: "postgresql", projects: ["isolated_project"],
    host: "127.0.0.1", port: 55432, database: "synthetic", user: "readonly", passwordEnv: "SYNTHETIC_PASSWORD", ssl: false, allowAi: true };
  const authorize = vi.fn(() => {});
  const driverExecute = vi.fn<ConnectionDriver["execute"]>(async () => structuredClone(sourceTable));
  const resolveConnection = vi.fn((id: string, project: string | null, forAi: boolean) => {
    if (id !== config.id || project !== "isolated_project" || !forAi || !config.allowAi) throw new Error("not authorized");
    return structuredClone(config);
  });
  const service = createConnectionQueryService({ resolveConnection,
    driverFor: () => ({ execute: driverExecute, schemaSql: () => "SELECT * FROM schema_catalog" }) });
  const inspector = vi.fn(async () => ({ columns: [{ table_schema: "public", table_name: "sales", column_name: "region", data_type: "text" }],
    truncated: false, catalog: { ...catalogRef, freshness: "fresh" as const, storage: "memory" as const, tableCount: 1 } }));
  const runs: NotebookRun[] = [];
  const connectionQuery = vi.fn(async (connectionId: string, sql: string, signal?: AbortSignal) => ({
    ...await service.executeConnectionSql({ connectionId, sql, signal, project: "isolated_project", forAi: true }), catalogRef,
  }));
  const options: Omit<DshEngineOptions, "driver"> = { dataRuntime: { rowsByDataSourceId: {} }, authorizeCurrentAccess: authorize,
    connectionInspector: inspector,
    notebookRunner: async (artifact, context) => {
      const run = await runNotebook({ document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
        sources: [], connectionQuery, forAi: true, signal: context.signal, log: () => {} });
      runs.push(run); return run;
    },
  };
  return { request, options, runs, inspector, connectionQuery, driverExecute, resolveConnection, config, authorize };
}

async function call(input: DshDriverInput, name: string, args: unknown, signal = input.signal) {
  const tool = input.tools.find(item => item.name === name);
  expect(tool, `Missing tool ${name}`).toBeDefined();
  input.onModelCall();
  return tool!.execute(args, signal);
}
async function complete(input: DshDriverInput) {
  const schema = await call(input, "inspectConnectionSchema", { connectionId: "allowed_db", search: "sales" });
  expect(schema.data).toMatchObject({ connectionId: "allowed_db", truncated: false, catalog: catalogRef });
  await call(input, "editNotebookCells", { editVersion: 0, cells: queryCells });
  const run = await call(input, "runNotebookCells", { editVersion: 1 });
  expect(run.data).toMatchObject({ status: "success", results: expect.arrayContaining([
    expect.objectContaining({ cellId: "totals", rows: expectedRows }), expect.objectContaining({ cellId: "chart", rows: expectedRows }),
  ]) });
  await call(input, "submitNotebookDraft", { editVersion: 1 });
  return { finalResponse: "UNTRUSTED_CLAIM" };
}

describe("DSH database capability boundary", () => {
  it("discovers authorized schema and runs database→real DuckDB→table/chart with lineage and no formal mutation", async () => {
    const f = fixture(), before = structuredClone(f.request);
    const task = await runDshEngine(f.request, { ...f.options, driver: complete });
    expect(task.state, task.error).toBe("awaitingConfirmation");
    expect(task.notebookArtifact).toMatchObject({ baseRevision: 4, sourceDataSourceIds: [], connectionIds: ["allowed_db"],
      executionEvidence: { status: "success", completedCellIds: ["remote", "totals", "table", "chart"] } });
    expect(f.runs[0].cells[0]).toMatchObject({ table: sourceTable, resultRef: { accessMode: "ai", complete: true, catalogRef } });
    expect(f.runs[0].cells[1].resultRef?.inputResultIds).toEqual([f.runs[0].cells[0].resultRef?.resultId]);
    expect(f.runs[0].cells[1].table?.rows).toEqual(expectedRows);
    expect(f.resolveConnection).toHaveBeenCalledWith("allowed_db", "isolated_project", true);
    expect(f.request).toEqual(before);
  }, 20_000);

  it.each(["unlisted", "disabled"])("rejects %s connection before inspecting or querying", async variant => {
    const f = fixture();
    if (variant === "disabled") f.request.notebookContext!.connections![0].allowAi = false;
    const task = await runDshEngine(f.request, { ...f.options, driver: async input => {
      await call(input, "inspectConnectionSchema", { connectionId: variant === "unlisted" ? "foreign" : "allowed_db" });
      return {};
    } });
    expect(["failed", "blocked"]).toContain(task.state);
    expect(task.notebookArtifact).toBeUndefined();
    expect(f.inspector).not.toHaveBeenCalled(); expect(f.connectionQuery).not.toHaveBeenCalled();
  });

  it.each(["foreign", "mutating", "multistatement"])("rejects %s SQL edit without invoking the database driver", async variant => {
    const f = fixture();
    const cell = { ...queryCells[0], ...(variant === "foreign" ? { connectionId: "foreign" }
      : { sql: variant === "mutating" ? "DELETE FROM sales" : "SELECT 1; DELETE FROM sales" }) };
    const task = await runDshEngine(f.request, { ...f.options, driver: async input => {
      await call(input, "editNotebookCells", { editVersion: 0, cells: [cell] }); return {};
    } });
    expect(task.state).toBe("failed"); expect(task.notebookArtifact).toBeUndefined();
    expect(f.driverExecute).not.toHaveBeenCalled();
  });

  it("incomplete database rows cannot feed a local aggregate or become a submitted draft", async () => {
    const f = fixture(); f.driverExecute.mockResolvedValue({ ...sourceTable, truncated: true });
    const task = await runDshEngine(f.request, { ...f.options, driver: async input => {
      await call(input, "editNotebookCells", { editVersion: 0, cells: queryCells });
      const run = await call(input, "runNotebookCells", { editVersion: 1 });
      expect(run.data).toMatchObject({ status: "failure" });
      await expect(call(input, "submitNotebookDraft", { editVersion: 1 })).rejects.toThrow(); return {};
    } });
    expect(task.state).toBe("failed"); expect(task.notebookArtifact).toBeUndefined();
    expect(f.runs[0].cells.map(item => item.status)).toEqual(["success", "failure", "blocked", "blocked"]);
    expect(f.runs[0].cells[0].resultRef?.complete).toBe(false);
  });

  it("revocation after a successful run and submission still discards the draft", async () => {
    const f = fixture(); let revoked = false;
    f.authorize.mockImplementation(() => { if (revoked) throw new Error("synthetic revoked permission"); });
    const task = await runDshEngine(f.request, { ...f.options, driver: async input => { await complete(input); revoked = true; return {}; } });
    expect(task.state).toBe("failed"); expect(task.resultMessage).toContain("授权已变化");
    expect(task.notebookArtifact).toBeUndefined();
  }, 20_000);

  it("database in-flight cancellation reaches its query signal and prevents a late draft", async () => {
    const f = fixture(), controller = new AbortController();
    let entered: (signal: AbortSignal) => void = () => {};
    const started = new Promise<AbortSignal>(resolve => { entered = resolve; });
    f.driverExecute.mockImplementation((_sql, signal) => {
      entered(signal);
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const pending = runDshEngine(f.request, { ...f.options, signal: controller.signal, driver: async input => {
      await call(input, "editNotebookCells", { editVersion: 0, cells: queryCells });
      await call(input, "runNotebookCells", { editVersion: 1 }); return {};
    } });
    const signal = await started; controller.abort();
    const task = await pending;
    expect(signal.aborted).toBe(true); expect(task.state).toBe("cancelled"); expect(task.notebookArtifact).toBeUndefined();
  });
});
