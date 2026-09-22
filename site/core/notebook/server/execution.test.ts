import { afterEach, describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { NOTEBOOK_LIMITS, notebookCellRunSchema, type NotebookDocument, type NotebookTable } from "../contracts";
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
  it("preserves presentation field source order, requested row key order, precision and truncation", async () => {
    const input = fixture();
    input.document.cells = [...input.document.cells.slice(0, 2),
      { id: "show", kind: "table", title: "展示顺序", inputCellId: "sql", columns: ["revenue", "region"] }];
    const precise: NotebookTable = { fields: [
      { name: "region", label: "地区", type: "string" }, { name: "revenue", label: "精确收入", type: "string" },
      { name: "extra", label: "不展示", type: "boolean" },
    ], rows: [{ region: null, revenue: "9007199254740993.00001", extra: false }], truncated: true };
    const before = structuredClone(precise);
    const run = await executeNotebook(input, { query: vi.fn().mockResolvedValue(precise), log: logger() });
    expect(run.status).toBe("success");
    expect(run.cells[2].table?.fields.map((field) => field.name)).toEqual(["region", "revenue"]);
    expect(Object.keys(run.cells[2].table!.rows[0])).toEqual(["revenue", "region"]);
    expect(run.cells[2].table?.rows).toEqual([{ revenue: "9007199254740993.00001", region: null }]);
    expect(run.cells[2].table?.truncated).toBe(true);
    expect(run.cells[2].resultRef).toMatchObject({ rowCount: 1, complete: false });
    expect(precise).toEqual(before);
  });

  it.each(["bar", "line", "area", "pie", "donut"] as const)("keeps %s chart negative-value behavior", async (chartType) => {
    const input = fixture();
    input.document.cells[2] = { id: "chart", title: "图表", kind: "chart", inputCellId: "sql",
      chartType, categoryField: "region", valueFields: ["revenue"] };
    const negative = { ...table, rows: [{ region: "adjustment", revenue: -1 }] };
    const run = await executeNotebook(input, { query: vi.fn().mockResolvedValue(negative), log: logger() });
    if (chartType === "pie" || chartType === "donut") {
      expect(run.cells[2]).toMatchObject({ status: "failure", error: "饼图或环形图不能表示负数，请选择柱状图或折线图" });
      expect(run.cells[2].table).toBeUndefined();
      expect(run.cells[2].resultRef).toBeUndefined();
    } else expect(run.cells[2]).toMatchObject({ status: "success", table: negative });
    expect(run.cells[3].status).toBe("success");
  });

  it("preserves presentation validation errors without publishing success evidence", async () => {
    for (const [output, error] of [
      [{ ...table, fields: table.fields.slice(0, 1) }, "上游字段已变化，请重新选择表格或图表字段"],
      [{ fields: table.fields.map((field) => ({ ...field, type: "string" as const })),
        rows: [{ region: "total", revenue: "9007199254740993.00001" }], truncated: false }, "图表数值列必须为数字；高精度字符串请在 SQL 中显式转换后使用"],
    ] as const) {
      const run = await executeNotebook(fixture(), { query: vi.fn().mockResolvedValue(output), log: logger() });
      expect(run.cells[2]).toMatchObject({ status: "failure", error });
      expect(run.cells[2].resultRef).toBeUndefined();
    }
  });

  it("executes text explicitly without a table or any query, Python or logging effect", async () => {
    const query = vi.fn(), python = vi.fn(), log = logger();
    const run = await executeNotebook({ document: { name: "纯说明", revision: 0, cells: [
      { id: "note", kind: "text", title: "说明", markdown: "合成文本" },
    ] }, sources: [] }, { query, python, log });
    expect(run).toMatchObject({ status: "success", cells: [{ cellId: "note", status: "success" }] });
    expect(run.cells[0].table).toBeUndefined();
    expect(run.cells[0].resultRef).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
    expect(python).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("rejects an unknown stored kind before calling any execution port", async () => {
    vi.useFakeTimers();
    const input = fixture();
    // Model an untrusted stored document, without loosening production types.
    Object.assign(input.document.cells[3], { kind: "unsupported_cell" });
    const query = vi.fn(), python = vi.fn(), log = logger(), connectionQuery = vi.fn();
    await expect(executeNotebook({ ...input, connectionQuery }, { query, python, log })).rejects.toThrow();
    expect(query).not.toHaveBeenCalled();
    expect(python).not.toHaveBeenCalled();
    expect(connectionQuery).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  function pythonFixture(): NotebookRunInput {
    return { document: { name: "Python 分段", revision: 0, cells: [
      { id: "py", kind: "python", title: "合成计算", inputCellIds: [], fileNames: [], outputName: "totals", code: "totals = pd.DataFrame({'revenue': [230]})" },
      { id: "show", kind: "table", title: "结果", inputCellId: "py", columns: ["revenue"] },
    ] }, sources: [] };
  }

  it("blocks disabled Python before session creation while independent SQL cells still run", async () => {
    const input = fixture();
    input.document.cells.splice(3, 0,
      { id: "py", kind: "python", title: "Disabled Python", inputCellIds: [], fileNames: [], outputName: "python_result", code: "python_result = pd.DataFrame({'value': [1]})" },
      { id: "py_show", kind: "table", title: "Python result", inputCellId: "py", columns: ["value"] },
    );
    const python = vi.fn(), query = vi.fn<NotebookQueryExecutor>().mockResolvedValue(table);
    const run = await executeNotebook(input, {
      query,
      python,
      log: logger(),
      capabilities: { python: { enabled: false, reason: "Python Notebook 能力已关闭" } },
    });
    expect(run.status).toBe("failure");
    expect(run.cells.find((cell) => cell.cellId === "py")).toMatchObject({
      status: "failure",
      error: "Python Notebook 能力已关闭",
      timing: { preparationMs: 0, executionMs: 0, failurePhase: "preparation", termination: "error" },
    });
    expect(run.cells.find((cell) => cell.cellId === "py_show")).toMatchObject({ status: "blocked" });
    expect(run.cells.find((cell) => cell.cellId === "sql")).toMatchObject({ status: "success" });
    expect(run.cells.find((cell) => cell.cellId === "chart")).toMatchObject({ status: "success" });
    expect(python).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("records preparation and execution independently and accepts old receipts without timings", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const close = vi.fn(async () => {});
    const pending = executeNotebook(pythonFixture(), { query: vi.fn(), log: logger(), python: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return { close, execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 7000));
        return { table, stdout: "", stderr: "" };
      } };
    } });
    await vi.advanceTimersByTimeAsync(12_000);
    const run = await pending;
    expect(run.status).toBe("success");
    expect(run.cells[0].timing).toEqual({ preparationMs: 5000, executionMs: 7000 });
    expect(run.cells[0].durationMs).toBe(12_000);
    expect(run.cells[1].timing).toBeUndefined();
    expect(close).toHaveBeenCalledExactlyOnceWith();
    expect(notebookCellRunSchema.parse({ cellId: "old", status: "success", durationMs: 1 })).toEqual({ cellId: "old", status: "success", durationMs: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["preparation", "execution"] as const)("retains the %s failure phase without publishing successful data", async (phase) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const close = vi.fn(async () => {});
    const fail = async () => { await new Promise((resolve) => setTimeout(resolve, 120)); throw new Error("synthetic phase failure"); };
    const pending = executeNotebook(pythonFixture(), { query: vi.fn(), log: logger(), python: phase === "preparation" ? fail
      : async () => ({ close, execute: fail }) });
    await vi.advanceTimersByTimeAsync(120);
    const run = await pending;
    expect(run.cells[0]).toMatchObject({ status: "failure", error: "synthetic phase failure", timing: {
      failurePhase: phase, termination: "error", preparationMs: phase === "preparation" ? 120 : 0, executionMs: phase === "execution" ? 120 : 0,
    } });
    expect(run.cells[0].table).toBeUndefined();
    expect(run.cells[0].resultRef).toBeUndefined();
    expect(run.cells[1].status).toBe("blocked");
    expect(close).toHaveBeenCalledTimes(phase === "execution" ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["cancelled", "timeout"] as const)("distinguishes %s from browser teardown errors", async (termination) => {
    const controller = new AbortController();
    const run = await executeNotebook({ ...pythonFixture(), signal: controller.signal }, { query: vi.fn(), log: logger(), python: async () => ({
      close: async () => {}, execute: async () => {
        controller.abort(termination === "timeout" ? new DOMException("bounded tool deadline", "TimeoutError") : undefined);
        throw new Error("page.evaluate: Target page has been closed");
      },
    }) });
    expect(run.cells[0]).toMatchObject({ status: "failure", timing: { failurePhase: "execution", termination },
      error: termination === "timeout" ? "Python 运行时间预算已用尽" : "Python 运行已取消" });
    expect(JSON.stringify(run)).not.toContain("page.evaluate");
    expect(run.cells[1].status).toBe("blocked");
  });

  it("keeps the Notebook total deadline during Python preparation and does not enter computation", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const execute = vi.fn(), close = vi.fn(async () => {});
    const pending = executeNotebook(pythonFixture(), { query: vi.fn(), log: logger(), python: (signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ execute, close }), { once: true });
    }) });
    await vi.advanceTimersByTimeAsync(NOTEBOOK_LIMITS.runTimeoutMs);
    const run = await pending;
    expect(run.cells[0]).toMatchObject({ status: "failure", timing: { preparationMs: 30_000, executionMs: 0, failurePhase: "preparation", termination: "timeout" } });
    expect(execute).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledExactlyOnceWith();
    expect(vi.getTimerCount()).toBe(0);
  });

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
