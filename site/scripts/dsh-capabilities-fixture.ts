import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import writeXlsxFile from "write-excel-file/node";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { readEdsXlsx } from "@/core/eds/server/workbook";
import { runNotebook } from "@/core/notebook/server/runtime";
import { notebookPythonRuntimeInfo } from "@/core/notebook/server/python-runtime";
import type { NotebookCell } from "@/core/notebook/definition";
import type { NotebookRun } from "@/core/notebook/contracts";
import type { DataTable } from "@/core/datasets/table-contracts";
import { harnessRequestSchema, type HarnessRequest, type HarnessTraceEvent } from "@/core/harness/contracts";
import { createHarnessStreamResponse, readHarnessStream } from "@/core/harness/stream";
import { createAgentExecutor } from "@/core/agent-engines/server/executor";
import { createOfficialDshDriver } from "@/core/agent-engines/server/dsh-driver";
import type { CoordinatedHarnessOptions } from "@/core/harness/agents/coordinator";

function request(name: string): HarnessRequest {
  if (!demoFixtureResult.success) throw new Error("Synthetic app unavailable");
  return harnessRequestSchema.parse({ idempotencyKey: `dsh_capabilities_${name.replaceAll(" ", "_")}`, instruction: "分析本次授权输入，生成并运行 Notebook 表格与图表草稿，等待采用。",
    role: "editor", pageId: "page_home", recipes: [],
    appSpec: { ...structuredClone(demoFixtureResult.data.dataProduct.appSpec), dataSources: [] },
    notebookContext: { sourceIds: [], document: { name, revision: 2, cells: [] } } });
}

async function execute(input: HarnessRequest, actions: Array<{ name: string; args: Record<string, unknown> }>, options: CoordinatedHarnessOptions) {
  const before = structuredClone(input), events: HarnessTraceEvent[] = [];
  const driver = createOfficialDshDriver(() => ({ mode: "fixture", actions, finalText: "UNTRUSTED_FINISHED_CLAIM" }));
  const engine = createAgentExecutor(async value => {
    assert.ok(!JSON.stringify(value.context).includes('"seconds":60'));
    assert.ok(!JSON.stringify(value.context).includes('"amount":100'));
    return driver(value);
  });
  const controller = new AbortController();
  const response = createHarnessStreamResponse(controller.signal, (signal, onEvent) => engine("dsh", input, {
    ...options, signal, onEvent, modelClient: { next() { throw new Error("Old Harness execution prohibited"); } },
  }));
  const { task } = await readHarnessStream(response, controller.signal, event => events.push(event));
  assert.equal(task.state, "awaitingConfirmation", task.error);
  assert.equal(task.notebookArtifact?.executionEvidence?.status, "success");
  assert.equal(task.counters.toolCallCount, actions.length);
  assert.equal(task.counters.modelCallCount, actions.length + 1);
  assert.equal(events.filter(event => event.type === "completed").length, 1);
  assert.deepEqual(events.filter(event => event.type === "tool_completed").map(event => event.toolCall?.name), actions.map(action => action.name));
  assert.equal(task.pendingChangeSet, undefined);
  assert.equal(task.usage, undefined);
  assert.ok(!JSON.stringify(task).includes("UNTRUSTED_FINISHED_CLAIM"));
  assert.deepEqual(input, before);
  return { tools: actions.map(action => action.name), taskState: task.state, completedCells: task.notebookArtifact?.executionEvidence?.completedCellIds,
    sourceIds: task.notebookArtifact?.sourceDataSourceIds, connectionIds: task.notebookArtifact?.connectionIds,
    formalDocumentUnchanged: true, sdkReturnedAfterReaping: true, completedEvents: 1 };
}

/** Official SDK child/loop/broker + real Pyodide and DuckDB. Database I/O is an explicit fixture. */
export async function verifyDshCapabilities() {
  const bytes = await writeXlsxFile([{ sheet: "alarms", data: [[{ value: "seconds", type: String }],
    [{ value: 60, type: Number }], [{ value: 120, type: Number }]] }]).toBuffer();
  const fileName = "dsh-sdk-synthetic.xlsx", contentHash = createHash("sha256").update(bytes).digest("hex");
  const sheets = await readEdsXlsx({ buffer: bytes, originalFileName: fileName });
  const excelRequest = request("DSH XLSX Python");
  excelRequest.rawWorkbookManifest = { fileName, contentHash, sheets: sheets.map(sheet => ({ name: sheet.sheet,
    rowCount: sheet.data.length, columnCount: Math.max(0, ...sheet.data.map(row => row.length)) })) };
  const excelCells: NotebookCell[] = [
    { id: "python", kind: "python", title: "Read attached XLSX", inputCellIds: [], fileNames: [fileName], outputName: "raw_minutes",
      code: `raw = pd.read_excel(files['${fileName}'])\nraw_minutes = pd.DataFrame({'category': ['total'], 'minutes': [raw.seconds.sum() / 60]})` },
    { id: "sql", kind: "sql", title: "Validate minutes", inputCellIds: ["python"], outputName: "totals",
      sql: "SELECT category, SUM(minutes)::DOUBLE AS minutes FROM raw_minutes GROUP BY category" },
    { id: "table", kind: "table", title: "Table", inputCellId: "sql", columns: ["category", "minutes"] },
    { id: "chart", kind: "chart", title: "Chart", inputCellId: "sql", chartType: "bar", categoryField: "category", valueFields: ["minutes"] },
  ];
  let excelRun: NotebookRun | undefined;
  const excel = await execute(excelRequest, [
    { name: "inspectEdsRawWorkbook", args: {} },
    { name: "readEdsRawRows", args: { sheetName: "alarms", startRow: 2, rowCount: 2, columnCount: 1 } },
    { name: "getKernelPackagesInfo", args: {} },
    { name: "editNotebookCells", args: { editVersion: 0, cells: excelCells } },
    { name: "runNotebookCells", args: { editVersion: 1 } }, { name: "submitNotebookDraft", args: { editVersion: 1 } },
  ], { dataRuntime: { rowsByDataSourceId: {} }, authorizeModelCall() {},
    rawWorkbook: { fileName, contentHash, sheets },
    notebookCapabilities: { python: { enabled: true } }, pythonRuntimeInfo: notebookPythonRuntimeInfo,
    notebookRunner: async (artifact, context) => {
      excelRun = await runNotebook({ document: { name: artifact.name, revision: 2, cells: artifact.cells }, sources: [],
        pythonFiles: [{ name: fileName, bytes }], signal: context.signal, forAi: true, log() {} });
      assert.equal(excelRun.status, "success");
      for (const id of ["python", "sql", "table", "chart"]) assert.deepEqual(excelRun.cells.find(cell => cell.cellId === id)?.table?.rows,
        [{ category: "total", minutes: 3 }]);
      assert.equal(excelRun.cells[0].resultRef?.sourceFiles?.[0].sha256, contentHash);
      return excelRun;
    },
  });
  assert.ok(excelRun);

  const databaseRequest = request("DSH database adapter fixture");
  databaseRequest.notebookContext!.connections = [{ id: "test_db", name: "Synthetic reader", kind: "postgresql", allowAi: true }];
  const databaseCells: NotebookCell[] = [
    { id: "remote", kind: "warehouseSql", title: "Read database", connectionId: "test_db", outputName: "remote_rows", sql: "SELECT region, amount FROM sales" },
    { id: "sql", kind: "sql", title: "Aggregate", inputCellIds: ["remote"], outputName: "totals",
      sql: "SELECT region, SUM(amount)::DOUBLE AS revenue FROM remote_rows GROUP BY region ORDER BY region" },
    { id: "table", kind: "table", title: "Table", inputCellId: "sql", columns: ["region", "revenue"] },
    { id: "chart", kind: "chart", title: "Chart", inputCellId: "sql", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
  ];
  const source: DataTable = { fields: [{ name: "region", label: "region", type: "string" }, { name: "amount", label: "amount", type: "number" }],
    rows: [{ region: "East", amount: 100 }, { region: "East", amount: 50 }, { region: "South", amount: 80 }], truncated: false };
  let queries = 0;
  const database = await execute(databaseRequest, [
    { name: "inspectConnectionSchema", args: { connectionId: "test_db" } },
    { name: "editNotebookCells", args: { editVersion: 0, cells: databaseCells } },
    { name: "runNotebookCells", args: { editVersion: 1 } }, { name: "submitNotebookDraft", args: { editVersion: 1 } },
  ], { dataRuntime: { rowsByDataSourceId: {} }, authorizeModelCall() {},
    connectionInspector: async id => {
      assert.equal(id, "test_db");
      return { columns: [{ table_schema: "public", table_name: "sales", column_name: "region", data_type: "text" }], truncated: false };
    },
    notebookRunner: async (artifact, context) => {
      const run = await runNotebook({ document: { name: artifact.name, revision: 2, cells: artifact.cells }, sources: [],
        signal: context.signal, forAi: true, log() {}, connectionQuery: async (id, sql, signal) => {
          signal?.throwIfAborted(); assert.equal(id, "test_db"); assert.equal(sql, "SELECT region, amount FROM sales");
          queries++; return structuredClone(source);
        } });
      assert.equal(run.status, "success");
      for (const id of ["sql", "table", "chart"]) assert.deepEqual(run.cells.find(cell => cell.cellId === id)?.table?.rows,
        [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }]);
      assert.equal(run.cells[0].resultRef?.accessMode, "ai");
      return run;
    },
  });
  assert.equal(queries, 1);
  return { passed: true, officialSdk: true, scriptedModel: true, realPaidModel: false, excel: { ...excel, minutes: 3,
    execution: "Actual official SDK / business bridge / Pyodide pandas+openpyxl / DuckDB", sha256: contentHash },
    database: { ...database, queries, execution: "Actual official SDK / business bridge / Notebook / DuckDB; database Schema and query port are explicit fixtures", realPostgres: false } };
}
