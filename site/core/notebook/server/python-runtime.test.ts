import { describe, expect, it } from "vitest";
import { createNotebookPythonSession, notebookPythonRuntimeInfo } from "./python-runtime";
import { runNotebook } from "./runtime";
import { semanticFixture } from "@/core/semantic/test-fixture";

describe("隔离的真实 Python Runtime", () => {
  it("离线载入固定 Python / pandas / NumPy / openpyxl，执行 DataFrame 并捕获 stdout", async () => {
    expect(await notebookPythonRuntimeInfo()).toMatchObject({ available: true, pythonVersion: "3.14.2", packages: { pandas: "3.0.2", openpyxl: "3.1.5" } });
    const signal = new AbortController().signal;
    const session = await createNotebookPythonSession(signal);
    try {
      const result = await session.execute({ tables: [], files: [], outputName: "result", code: "import openpyxl\nprint('Python ready')\nresult = pd.DataFrame({'value': np.array([2, 3]) * 10})" }, signal);
      expect(result.table.rows).toEqual([{ value: 20 }, { value: 30 }]);
      expect(result.stdout).toContain("Python ready");
    } finally { await session.close(); }
  }, 30_000);

  it("完整 DataFrame 传给 SQL / 图表；预览截断不会截掉计算输入", async () => {
    const run = await runNotebook({ document: { name: "Python SQL", revision: 3, cells: [
      { id: "python", title: "生成", kind: "python", inputCellIds: [], fileNames: [], outputName: "records",
        code: "hidden = 42\nrecords = pd.DataFrame({'value': np.arange(1200)})" },
      { id: "copy", title: "显式依赖", kind: "python", inputCellIds: ["python"], fileNames: [], outputName: "copied",
        code: "assert 'hidden' not in globals()\ncopied = records.assign(group='all')" },
      { id: "sql", title: "汇总", kind: "sql", inputCellIds: ["copy"], outputName: "totals",
        sql: 'SELECT "group", COUNT(*) AS records, SUM(value) AS total FROM copied GROUP BY "group"' },
      { id: "chart", title: "图表", kind: "chart", inputCellId: "sql", chartType: "bar", categoryField: "group", valueFields: ["total"] },
    ] }, sources: [], log: () => {} });
    expect(run.status, JSON.stringify(run)).toBe("success");
    expect(run.cells[0].timing?.preparationMs).toBeGreaterThan(0);
    expect(run.cells[0].timing?.executionMs).toBeGreaterThan(0);
    expect(run.cells[0].timing?.failurePhase).toBeUndefined();
    expect(run.cells[1].timing?.preparationMs).toBe(0);
    expect(run.cells[1].timing?.executionMs).toBeGreaterThan(0);
    expect(run.cells[0].table?.rows).toHaveLength(1000);
    expect(run.cells[0].resultRef).toMatchObject({ complete: true, rowCount: 1200 });
    expect(run.cells[2].table?.rows).toEqual([{ group: "all", records: 1200, total: 719400 }]);
    expect(run.cells[3].table?.rows).toEqual([{ group: "all", total: 719400 }]);
  }, 30_000);

  it("保留标量类型与高精度整数，报错带诊断且拒绝超限和对象列", async () => {
    const signal = new AbortController().signal;
    const session = await createNotebookPythonSession(signal);
    const execute = (code: string) => session.execute({ code, outputName: "result", tables: [], files: [] }, signal);
    try {
      const { table } = await execute("result = pd.DataFrame({'big': [9007199254740993, None], 'flag': [True, False], 'number': [np.nan, 1], 'date': pd.to_datetime(['2026-01-01', None])})");
      // Object dtype keeps the Python integer exact instead of first casting it to float.
      const exact = await execute("result = pd.DataFrame({'big': pd.Series([9007199254740993, None], dtype=object)})");
      expect(exact.table.rows).toEqual([{ big: "9007199254740993" }, { big: null }]);
      expect(table.rows[1]).toMatchObject({ big: null, flag: false, number: 1, date: null });
      expect(table.fields.map((f) => f.type)).toEqual(["number", "boolean", "number", "date"]);
      expect((await execute("result = pd.DataFrame({'value': pd.Series([], dtype='float64')})")).table).toMatchObject({ rows: [], fields: [{ name: "value", type: "number" }] });
      await expect(execute("print('before failure')\nraise ValueError('synthetic failure')")).rejects.toMatchObject({ message: "ValueError: synthetic failure", stdout: "before failure\n", stderr: expect.stringContaining("ValueError") });
      await expect(execute("result = pd.DataFrame({'nested': [[1, 2]]})")).rejects.toThrow("标量");
      await expect(execute("result = pd.DataFrame({'value': range(50001)})")).rejects.toThrow("50000");
      await expect(execute("result = 1")).rejects.toThrow("DataFrame");
      expect((await execute("result = pd.DataFrame({'recovered': [True]})")).table.rows).toEqual([{ recovered: true }]);
    } finally { await session.close(); }
  }, 30_000);

  it("不向 Python 暴露主机文件、Node 进程或外部网络", async () => {
    const signal = new AbortController().signal;
    const session = await createNotebookPythonSession(signal);
    try {
      const result = await session.execute({ outputName: "result", tables: [], files: [], code: [
        "import os, js", "assert not os.path.exists('C:/Windows/win.ini')", "assert not os.path.exists('/etc/hostname')",
        "assert not hasattr(js, 'process')", "blocked = False", "try:",
        "    request = js.XMLHttpRequest.new()", "    request.open('GET', 'https://example.com/', False)", "    request.send()",
        "except Exception:", "    blocked = True", "assert blocked", "result = pd.DataFrame({'isolated': [True]})",
      ].join("\n") }, signal);
      expect(result.table.rows).toEqual([{ isolated: true }]);
    } finally { await session.close(); }
  }, 30_000);

  it("在 Python 之前执行敏感字段处理，失败后下游阻断", async () => {
    const { source, rows } = semanticFixture();
    const run = await runNotebook({ forAi: true, sources: [{ source: { ...source, aiAccessPolicy: "masked", fields: source.fields.map((f) => ({ ...f, sensitiveCategories: ["email"] })) }, rows }],
      document: { name: "权限", revision: 0, cells: [
        { id: "data", kind: "data", title: "输入", outputName: "sales", sourceDataSourceId: source.id },
        { id: "py", kind: "python", title: "受控输入", inputCellIds: ["data"], fileNames: [], outputName: "safe",
          code: "assert sales['amount'].isna().all()\nassert sales['region'].str.startswith('匿名_').all()\nprint('safe input')\nraise ValueError('expected')" },
        { id: "sql", kind: "sql", title: "下游", inputCellIds: ["py"], outputName: "totals", sql: "SELECT * FROM safe" },
      ] }, log: () => {} });
    expect(run.cells.map((cell) => cell.status)).toEqual(["success", "failure", "blocked"]);
    expect(run.cells[1]).toMatchObject({ stdout: "safe input\n", error: "ValueError: expected" });
    expect(run.cells[1].timing).toMatchObject({ failurePhase: "execution", termination: "error" });
    expect(run.cells[1].resultRef).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain("华东");
  }, 30_000);

  it("终止无限计算，并允许重新建立独立运行", async () => {
    const signal = new AbortController().signal;
    const session = await createNotebookPythonSession(signal);
    try {
      await expect(session.execute({ code: "while True: pass", outputName: "result", tables: [], files: [] }, signal)).rejects.toMatchObject({ name: "TimeoutError", message: expect.stringContaining("超过 10 秒") });
      await expect(session.execute({ code: "pass", outputName: "result", tables: [], files: [] }, signal)).rejects.toThrow("会话已结束");
    } finally { await session.close(); }
    const controller = new AbortController();
    const next = await createNotebookPythonSession(controller.signal);
    try {
      const pending = next.execute({ code: "while True: pass", outputName: "result", tables: [], files: [] }, controller.signal);
      setTimeout(() => controller.abort(), 100);
      await expect(pending).rejects.toThrow();
    } finally { await next.close(); }
  }, 40_000);
});
