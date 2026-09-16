import { afterEach, describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { NOTEBOOK_LIMITS, type NotebookDocument, type NotebookTable } from "../contracts";
import type { NotebookConnectionQuery, NotebookExecutionDependencies, NotebookQueryExecutor, NotebookRunInput } from "../execution-contracts";
import { executeNotebook } from "./execution";

function fixture(): NotebookRunInput {
  const { source, rows } = semanticFixture();
  return { document: { name: "端口测试", revision: 2, cells: [
    { id: "data", title: "原始数据", kind: "data", sourceDataSourceId: source.id, outputName: "sales" },
    { id: "sql", title: "查询", kind: "sql", inputCellIds: ["data"], outputName: "totals", sql: "SELECT SUM(amount) AS revenue FROM sales" },
    { id: "chart", title: "图表", kind: "chart", inputCellId: "sql", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
    { id: "text", title: "说明", kind: "text", markdown: "合成数据" },
  ] }, sources: [{ source, rows }], userId: "fixture_user", taskId: "fixture_task" };
}
const table: NotebookTable = { fields: [{ name: "region", label: "地区", type: "string" }, { name: "revenue", label: "收入", type: "number" }],
  rows: [{ region: "total", revenue: 230 }], truncated: false };
const logger = () => vi.fn<NotebookExecutionDependencies["log"]>();

afterEach(() => vi.useRealTimers());

describe("Notebook execution through ports, without engine or persistence mocks", () => {
  it("sends full input to the injected query and preserves display limits and lineage", async () => {
    const input = fixture();
    input.sources[0].rows = Array.from({ length: 1324 }, () => ({ region: "East", amount: 1 }));
    const query = vi.fn<NotebookQueryExecutor>(async (_sql, tables) => ({ ...table, rows: [{ region: "total", revenue: tables[0].rows.length }] }));
    const log = logger();
    const run = await executeNotebook(input, { query, log });
    expect(run.status).toBe("success");
    expect(query).toHaveBeenCalledExactlyOnceWith("SELECT SUM(amount) AS revenue FROM sales", [expect.objectContaining({ name: "sales", rows: input.sources[0].rows })], expect.any(AbortSignal));
    expect(run.cells[0].table?.rows).toHaveLength(100);
    expect(run.cells[0].resultRef).toMatchObject({ complete: true, rowCount: 1324 });
    expect(run.cells[2].table?.rows).toEqual([{ region: "total", revenue: 1324 }]);
    expect(run.cells[2].resultRef).toMatchObject({ revision: 2, accessMode: "user", inputResultIds: [run.cells[1].resultRef?.resultId] });
    expect(log).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId: "fixture_user", taskId: "fixture_task", connectionId: "local-duckdb", returnedRows: 1, status: "success" }));
    expect(log.mock.calls[0][0]).not.toHaveProperty("rows");
  });

  it("keeps failed and blocked steps separate and does not reuse results on the next run", async () => {
    const input = fixture();
    const query = vi.fn<NotebookQueryExecutor>().mockRejectedValueOnce(new Error("synthetic SQL failure")).mockResolvedValue(table);
    const log = logger();
    const failed = await executeNotebook(input, { query, log });
    expect(failed.cells.map((cell) => cell.status)).toEqual(["success", "failure", "blocked", "success"]);
    expect(failed.cells[1].error).toBe("synthetic SQL failure");
    expect(failed.cells[1].resultRef).toBeUndefined();
    expect(failed.cells[2].table).toBeUndefined();
    expect(log.mock.calls[0][0].status).toBe("failure");
    const successful = await executeNotebook(input, { query, log });
    expect(successful.status).toBe("success");
    expect(successful.runId).not.toBe(failed.runId);
    expect(successful.cells[2].table).toEqual(table);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("routes warehouse queries to their scoped port without converting precise values", async () => {
    const precise: NotebookTable = { fields: [{ name: "exact", label: "精度", type: "string" }], rows: [{ exact: "9007199254740993.00001" }], truncated: false };
    const document: NotebookDocument = { name: "远端替身", revision: 0, cells: [
      { id: "remote", title: "远端", kind: "warehouseSql", connectionId: "warehouse", outputName: "remote", sql: "SELECT exact FROM ledger" },
      { id: "show", title: "表格", kind: "table", inputCellId: "remote", columns: ["exact"] },
    ] };
    const query = vi.fn<NotebookQueryExecutor>();
    const connectionQuery = vi.fn<NotebookConnectionQuery>().mockResolvedValue(precise);
    const log = logger();
    const run = await executeNotebook({ document, sources: [], forAi: true, connectionQuery }, { query, log });
    expect(run.status).toBe("success");
    expect(query).not.toHaveBeenCalled();
    expect(connectionQuery).toHaveBeenCalledExactlyOnceWith("warehouse", "SELECT exact FROM ledger", expect.any(AbortSignal));
    expect(run.cells[1].table).toEqual(precise);
    expect(run.cells[0].resultRef).toMatchObject({ accessMode: "ai", connectionId: "warehouse" });
    expect(log.mock.calls[0][0].connectionId).toBe("warehouse");
    const absent = await executeNotebook({ document, sources: [] }, { query, log });
    expect(absent.cells[0]).toMatchObject({ status: "failure", error: "数据库连接运行时未配置" });
    expect(absent.cells[1].status).toBe("blocked");
  });

  it("enforces pending/masked AI access before calling a replacement engine", async () => {
    const input = fixture();
    input.forAi = true;
    input.sources[0].source = { ...input.sources[0].source, aiAccessPolicy: "pending", fields: input.sources[0].source.fields.map((field) => ({ ...field, sensitiveCategories: ["email"] })) };
    const query = vi.fn<NotebookQueryExecutor>().mockResolvedValue(table);
    const log = logger();
    await expect(executeNotebook(input, { query, log })).rejects.toThrow("请先确认");
    expect(query).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    input.sources[0].source.aiAccessPolicy = "masked";
    const run = await executeNotebook(input, { query, log });
    const sent = query.mock.calls[0][1][0].rows;
    expect(sent).toEqual([{ region: "匿名_1", amount: null }, { region: "匿名_1", amount: null }, { region: "匿名_2", amount: null }]);
    expect(input.sources[0].rows[0]).toEqual({ region: "华东", amount: 100 });
    expect(JSON.stringify(run)).not.toContain("华东");
    expect(run.cells[1].resultRef?.accessMode).toBe("ai");
  });

  it("forwards cancellation and rejects late local results without success evidence", async () => {
    const controller = new AbortController();
    const query = vi.fn<NotebookQueryExecutor>(async (_sql, _tables, signal) => {
      controller.abort();
      expect(signal?.aborted).toBe(true);
      return table;
    });
    const log = logger();
    const run = await executeNotebook({ ...fixture(), signal: controller.signal }, { query, log });
    expect(run.status).toBe("failure");
    expect(run.cells[1]).toMatchObject({ status: "failure", error: "Notebook 运行已取消或超时" });
    expect(run.cells[1].table).toBeUndefined();
    expect(run.cells[1].resultRef).toBeUndefined();
    expect(run.cells[2].status).toBe("blocked");
    expect(log.mock.calls[0][0].status).toBe("failure");
  });

  it("preserves the run deadline and clears the timer after abort", async () => {
    vi.useFakeTimers();
    const query = vi.fn<NotebookQueryExecutor>((_sql, _tables, signal) => new Promise((resolve) => {
      signal?.addEventListener("abort", () => resolve(table), { once: true });
    }));
    const pending = executeNotebook(fixture(), { query, log: logger() });
    await vi.advanceTimersByTimeAsync(NOTEBOOK_LIMITS.runTimeoutMs);
    const run = await pending;
    expect(run.cells[1]).toMatchObject({ status: "failure", error: "Notebook 运行已取消或超时" });
    expect(run.cells[2].status).toBe("blocked");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not hide receipt-write failures or leave the run timer behind", async () => {
    vi.useFakeTimers();
    const failure = new Error("synthetic receipt write failure");
    const query = vi.fn<NotebookQueryExecutor>().mockResolvedValue(table);
    await expect(executeNotebook(fixture(), { query, log: () => { throw failure; } })).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
    expect((await executeNotebook(fixture(), { query, log: logger() })).status).toBe("success");
    expect(vi.getTimerCount()).toBe(0);
  });
});
