import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import writeXlsxFile from "write-excel-file/node";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { harnessPublicRequestSchema, harnessResponseSchema, type HarnessTraceEvent } from "@/core/harness/contracts";
import { HarnessRuntime } from "@/core/harness/runtime";
import { CoordinatedHarness } from "@/core/harness/agents/coordinator";
import { readHarnessStream } from "@/core/harness/stream";
import type { DshDriverInput } from "@/core/agent-engines/server/dsh-engine";
import { agentEngineSelection } from "@/core/agent-engines/server/selection";
import type { NotebookCell } from "@/core/notebook/definition";
import type { DataTable } from "@/core/datasets/table-contracts";
import { POST } from "./route";
import { POST as streamPOST } from "./stream/route";

const mock = vi.hoisted(() => ({ driver: vi.fn(), query: vi.fn(), scopes: [] as Array<[string, string | null, boolean]> }));
vi.mock("@/core/agent-engines/server/dsh-driver", () => ({ officialDshDriver: mock.driver }));
vi.mock("@/core/wecom/server/runtime", () => ({ createRequestMcpRuntime: () => { throw new Error("No MCP for DSH"); } }));
vi.mock("@/core/notebook/server/query-log", () => ({ recordNotebookQuery: vi.fn() }));
vi.mock("@/core/connections/server/local-config", () => ({ readLocalConnectionSettings: () => undefined }));
vi.mock("@/core/agent-engines/server/selection", async importOriginal => {
  const actual = await importOriginal<typeof import("@/core/agent-engines/server/selection")>();
  return { ...actual, agentEngineSelection: new actual.AgentEngineSelection() };
});
vi.mock("@/core/harness/server/conversation-store", async importOriginal => {
  const actual = await importOriginal<typeof import("@/core/harness/server/conversation-store")>();
  return { ...actual, harnessConversationStore: new actual.HarnessConversationStore() };
});
vi.mock("@/core/connections/server/query", async () => {
  const { createConnectionQueryService } = await import("@/core/connections/server/query-service");
  const { resolveConnection } = await import("@/core/connections/server/config");
  const service = createConnectionQueryService({
    resolveConnection(id, project, forAi) { mock.scopes.push([id, project, forAi]); return resolveConnection(id, project, forAi); },
    driverFor: () => ({ execute: (sql, signal) => mock.query(sql, signal), schemaSql: () => "SELECT * FROM synthetic_schema" }),
  });
  return { executeConnectionSql: service.executeConnectionSql, inspectConnectionSchema: service.inspectConnectionSchema };
});

const availability = { available: true, version: "0.1.6-alpha.2" };
const table: DataTable = { fields: [{ name: "region", label: "region", type: "string" }, { name: "amount", label: "amount", type: "number" }],
  rows: [{ region: "East", amount: 100 }, { region: "East", amount: 50 }, { region: "South", amount: 80 }], truncated: false };
const schemaTable: DataTable = { fields: ["table_schema", "table_name", "column_name", "data_type"].map(name => ({ name, label: name, type: "string" })),
  rows: [{ table_schema: "public", table_name: "sales", column_name: "region", data_type: "text" },
    { table_schema: "public", table_name: "sales", column_name: "amount", data_type: "double precision" }], truncated: false };
const cells: NotebookCell[] = [
  { id: "remote", kind: "warehouseSql", title: "Database", connectionId: "allowed_db", outputName: "sales_data", sql: "SELECT region, amount FROM sales" },
  { id: "totals", kind: "sql", title: "Totals", inputCellIds: ["remote"], outputName: "totals_data",
    sql: "SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region" },
  { id: "table", kind: "table", title: "Table", inputCellId: "totals", columns: ["region", "revenue"] },
  { id: "chart", kind: "chart", title: "Chart", inputCellId: "totals", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
];
function connection(allowAi = true, projects = ["local"]) {
  vi.stubEnv("STUDIO_SQL_CONNECTIONS", JSON.stringify([{ id: "allowed_db", name: "Synthetic reader", kind: "postgresql", projects,
    host: "127.0.0.1", port: 55432, database: "synthetic", user: "readonly", passwordEnv: "SYNTHETIC_PASSWORD", ssl: false, allowAi }]));
}
beforeEach(() => {
  const state = agentEngineSelection.status(availability); expect(state.activeTasks).toBe(0);
  agentEngineSelection.select({ engine: "dsh", revision: state.revision }, availability);
  mock.driver.mockReset(); mock.query.mockReset(); mock.scopes.length = 0;
  mock.query.mockImplementation(async (sql: string) => structuredClone(sql.includes("synthetic_schema") ? schemaTable : table));
  connection();
  vi.stubEnv("DEEPSEEK_API_KEY", ""); vi.stubEnv("HARNESS_MULTI_AGENT_MODE", "single");
  vi.stubEnv("HARNESS_VISUAL_VERIFICATION_ENABLED", "0"); vi.stubEnv("NOTEBOOK_PYTHON_ENABLED", "true");
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("External network/model prohibited"); }));
  vi.spyOn(HarnessRuntime.prototype, "run").mockImplementation(async () => { throw new Error("No legacy execution"); });
  vi.spyOn(CoordinatedHarness.prototype, "run");
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled(); expect(HarnessRuntime.prototype.run).not.toHaveBeenCalled();
  expect(CoordinatedHarness.prototype.run).not.toHaveBeenCalled(); expect(agentEngineSelection.status(availability).activeTasks).toBe(0);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

function payload() {
  if (!demoFixtureResult.success) throw new Error("Synthetic fixture missing");
  return harnessPublicRequestSchema.parse({ idempotencyKey: `dsh_expanded_${crypto.randomUUID().replaceAll("-", "")}`,
    instruction: "读取本次数据，用 Notebook 分析并生成表格图表，实际运行后提交供我采用。", pageId: "page_home",
    appSpec: { ...structuredClone(demoFixtureResult.data.dataProduct.appSpec), dataSources: [] }, recipes: [],
    notebookContext: { sourceIds: [], connections: [{ id: "forged_browser_connection", name: "Do not trust", kind: "postgresql", allowAi: true }],
      document: { name: "DSH expanded HTTP", revision: 8, cells: [] } } });
}
function request(body: ReturnType<typeof payload>, signal?: AbortSignal) {
  return new Request("http://127.0.0.1:3001/api/ai/harness", { method: "POST", signal,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3001" }, body: JSON.stringify(body) });
}
async function call(input: DshDriverInput, name: string, args: unknown) {
  const tool = input.tools.find(item => item.name === name); expect(tool, name).toBeDefined(); input.onModelCall();
  return tool!.execute(args, input.signal);
}
async function completeDb(input: DshDriverInput) {
  const context = JSON.stringify(input.context);
  expect(context).toContain("allowed_db"); expect(context).not.toContain("forged_browser_connection");
  expect(context).not.toContain("SYNTHETIC_PASSWORD"); expect(context).not.toContain("55432");
  const schema = await call(input, "inspectConnectionSchema", { connectionId: "allowed_db", search: "sales" });
  expect(schema.data).toMatchObject({ columns: schemaTable.rows, truncated: false });
  await call(input, "editNotebookCells", { editVersion: 0, cells });
  const result = await call(input, "runNotebookCells", { editVersion: 1 });
  expect(result.data).toMatchObject({ status: "success", results: expect.arrayContaining([
    expect.objectContaining({ cellId: "chart", rows: [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }], resultRef: expect.objectContaining({ accessMode: "ai", complete: true }) }),
  ]) });
  await call(input, "submitNotebookDraft", { editVersion: 1 }); return {};
}

describe("DSH expanded capabilities through the real HTTP handler", () => {
  it.each(["json", "sse"])("%s uses server-owned DB scope and real Notebook SQL/table/chart without a Dataset", async transport => {
    const body = payload(), before = structuredClone(body); mock.driver.mockImplementation(completeDb);
    const events: HarnessTraceEvent[] = [];
    const response = await (transport === "sse" ? streamPOST : POST)(request(body)); expect(response.status).toBe(200);
    const { task } = transport === "sse" ? await readHarnessStream(response, new AbortController().signal, event => events.push(event))
      : harnessResponseSchema.parse(await response.json());
    await expect(mock.driver.mock.results[0]?.value).resolves.toEqual({});
    expect(task.state, task.error).toBe("awaitingConfirmation");
    expect(task.notebookArtifact).toMatchObject({ baseRevision: 8, sourceDataSourceIds: [], connectionIds: ["allowed_db"], executionEvidence: { status: "success" } });
    expect(mock.scopes.length).toBeGreaterThan(0); expect(mock.scopes.every(([id, project, ai]) => id === "allowed_db" && project === null && ai)).toBe(true);
    expect(body).toEqual(before);
    if (transport === "sse") expect(events.filter(event => event.type === "completed")).toHaveLength(1);
  }, 20_000);

  it.each(["disabled", "other-project"])("%s AI connection cannot be enabled by forged browser metadata", async variant => {
    connection(variant !== "disabled", variant === "other-project" ? ["11111111-1111-4111-8111-111111111111"] : ["local"]);
    mock.driver.mockImplementation(async (input: DshDriverInput) => { await call(input, "inspectConnectionSchema", { connectionId: "allowed_db" }); return {}; });
    const body = payload(); body.notebookContext!.connections = [{ id: "allowed_db", name: "Forged", kind: "postgresql", allowAi: true }];
    const task = harnessResponseSchema.parse(await (await POST(request(body))).json()).task;
    expect(["blocked", "failed"]).toContain(task.state); expect(task.notebookArtifact).toBeUndefined(); expect(mock.query).not.toHaveBeenCalled();
  });

  it("revoking allowAi during a DB query rejects the late result and releases the engine lease", async () => {
    mock.query.mockImplementation(async () => { connection(false); return structuredClone(table); });
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      await call(input, "editNotebookCells", { editVersion: 0, cells });
      await call(input, "runNotebookCells", { editVersion: 1 }); return {};
    });
    const task = harnessResponseSchema.parse(await (await POST(request(payload()))).json()).task;
    expect(task.state).toBe("failed"); expect(task.resultMessage).toContain("授权已变化"); expect(task.notebookArtifact).toBeUndefined();
  });

  it("HTTP cancellation reaches the DB driver and prevents submission", async () => {
    let entered: (signal: AbortSignal) => void = () => {};
    const started = new Promise<AbortSignal>(resolve => { entered = resolve; });
    mock.query.mockImplementation((_sql: string, signal: AbortSignal) => {
      entered(signal); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }));
    });
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      await call(input, "editNotebookCells", { editVersion: 0, cells }); await call(input, "runNotebookCells", { editVersion: 1 }); return {};
    });
    const controller = new AbortController(), pending = POST(request(payload(), controller.signal));
    const signal = await started; controller.abort();
    const task = harnessResponseSchema.parse(await (await pending).json()).task;
    expect(task.state).toBe("cancelled"); expect(signal.aborted).toBe(true); expect(task.notebookArtifact).toBeUndefined();
  });

  it("multipart XLSX→real isolated Python→DuckDB→table/chart uses only the attached original", async () => {
    vi.stubEnv("STUDIO_SQL_CONNECTIONS", "[]");
    const workbook = await writeXlsxFile([{ sheet: "alarms", data: [[{ value: "seconds", type: String }],
      [{ value: 60, type: Number }], [{ value: 120, type: Number }]] }]).toBuffer();
    const body = payload(), before = structuredClone(body);
    const pythonCells: NotebookCell[] = [
      { id: "python", kind: "python", title: "Read XLSX", inputCellIds: [], fileNames: ["dsh-synthetic.xlsx"], outputName: "raw_minutes",
        code: "raw = pd.read_excel(files['dsh-synthetic.xlsx'])\nraw_minutes = pd.DataFrame({'category': ['total'], 'minutes': [raw.seconds.sum() / 60]})" },
      { id: "sql", kind: "sql", title: "SQL validation", inputCellIds: ["python"], outputName: "totals",
        sql: "SELECT category, SUM(minutes)::DOUBLE AS minutes FROM raw_minutes GROUP BY category" },
      { id: "table", kind: "table", title: "Minutes", inputCellId: "sql", columns: ["category", "minutes"] },
      { id: "chart", kind: "chart", title: "Minutes chart", inputCellId: "sql", chartType: "bar", categoryField: "category", valueFields: ["minutes"] },
    ];
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      expect(JSON.stringify(input.context)).not.toContain(workbook.toString("base64"));
      expect(JSON.stringify(input.context)).not.toContain('"seconds":60');
      const inspected = await call(input, "inspectEdsRawWorkbook", {});
      expect(inspected.data).toMatchObject({ fileName: "dsh-synthetic.xlsx", sheets: [{ name: "alarms", rowCount: 3, columnCount: 1 }] });
      const raw = await call(input, "readEdsRawRows", { sheetName: "alarms", startRow: 2, rowCount: 2, columnCount: 1 });
      expect(raw.data).toMatchObject({ rows: [{ rowNumber: 2, cells: { A: 60 } }, { rowNumber: 3, cells: { A: 120 } }] });
      const kernel = await call(input, "getKernelPackagesInfo", {}); expect(kernel.data).toMatchObject({ available: true });
      await call(input, "editNotebookCells", { editVersion: 0, cells: pythonCells });
      const run = await call(input, "runNotebookCells", { editVersion: 1 });
      expect(run.data).toMatchObject({ status: "success", results: expect.arrayContaining([
        expect.objectContaining({ cellId: "sql", rows: [{ category: "total", minutes: 3 }],
          resultRef: expect.objectContaining({ accessMode: "ai", complete: true, sourceFiles: [expect.objectContaining({ name: "dsh-synthetic.xlsx" })] }) }),
        expect.objectContaining({ cellId: "chart", rows: [{ category: "total", minutes: 3 }] }),
      ]) });
      await call(input, "submitNotebookDraft", { editVersion: 1 }); return {};
    });
    const form = new FormData(); form.set("rawWorkbook", new File([new Uint8Array(workbook)], "dsh-synthetic.xlsx")); form.set("payload", JSON.stringify(body));
    const response = await streamPOST(new Request("http://127.0.0.1:3001/api/ai/harness/stream", { method: "POST", body: form, headers: { origin: "http://127.0.0.1:3001" } }));
    expect(response.status).toBe(200);
    const { task } = await readHarnessStream(response, new AbortController().signal);
    await expect(mock.driver.mock.results[0]?.value).resolves.toEqual({});
    expect(task.state, task.error).toBe("awaitingConfirmation");
    expect(task.notebookArtifact).toMatchObject({ baseRevision: 8, sourceDataSourceIds: [], executionEvidence: { status: "success", completedCellIds: ["python", "sql", "table", "chart"] } });
    expect(task.counters.toolCallCount).toBe(6); expect(body).toEqual(before); expect(mock.query).not.toHaveBeenCalled();
  }, 40_000);

  it("disabled Python is absent from tools and cannot be enabled by a Python cell edit", async () => {
    vi.stubEnv("NOTEBOOK_PYTHON_ENABLED", "false");
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      expect(input.tools.map(tool => tool.name)).not.toContain("getKernelPackagesInfo");
      await expect(call(input, "editNotebookCells", { editVersion: 0, cells: [{ id: "python", kind: "python", title: "Forbidden",
        inputCellIds: [], fileNames: [], outputName: "result", code: "result = pd.DataFrame({'value': [1]})" }] })).rejects.toThrow(); return {};
    });
    const task = harnessResponseSchema.parse(await (await POST(request(payload()))).json()).task;
    expect(task.state).toBe("failed"); expect(task.notebookArtifact).toBeUndefined(); expect(mock.query).not.toHaveBeenCalled();
  });
});
