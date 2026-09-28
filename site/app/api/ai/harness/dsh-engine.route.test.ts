import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { datasetRepository } from "@/core/datasets/server/dataset-repository";
import { resolveDemoRequestIdentity } from "@/core/identity/server/demo-identity";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { harnessPublicRequestSchema, harnessRequestSchema, harnessResponseSchema, type HarnessTraceEvent } from "@/core/harness/contracts";
import { HarnessRuntime } from "@/core/harness/runtime";
import { CoordinatedHarness } from "@/core/harness/agents/coordinator";
import { DeepSeekHarnessModel } from "@/core/ai/server/deepseek-harness-model";
import { createHarnessTask } from "@/core/harness/task-state";
import { readHarnessStream } from "@/core/harness/stream";
import { adoptNotebookDraft } from "@/core/notebook/client-state";
import type { NotebookCell } from "@/core/notebook/definition";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { DshDriverInput } from "@/core/agent-engines/server/dsh-engine";
import { agentEngineSelection } from "@/core/agent-engines/server/selection";
import { POST } from "./route";
import { POST as streamPOST } from "./stream/route";
import { PATCH as settingsPATCH } from "../../settings/agent-engine/route";

const mock = vi.hoisted(() => ({ driver: vi.fn(), inspect: vi.fn(), mcp: vi.fn() }));
vi.mock("@/core/agent-engines/server/dsh-driver", () => ({ officialDshDriver: mock.driver, inspectOfficialDshRuntime: mock.inspect }));
vi.mock("@/core/wecom/server/runtime", () => ({ createRequestMcpRuntime: mock.mcp }));
vi.mock("@/core/agent-engines/server/selection", async importOriginal => {
  const actual = await importOriginal<typeof import("@/core/agent-engines/server/selection")>();
  return { ...actual, agentEngineSelection: new actual.AgentEngineSelection() };
});
vi.mock("@/core/datasets/server/dataset-repository", async importOriginal => {
  const actual = await importOriginal<typeof import("@/core/datasets/server/dataset-repository")>();
  return { ...actual, datasetRepository: new actual.MemoryDatasetRepository() };
});
vi.mock("@/core/harness/server/conversation-store", async importOriginal => {
  const actual = await importOriginal<typeof import("@/core/harness/server/conversation-store")>();
  return { ...actual, harnessConversationStore: new actual.HarnessConversationStore() };
});
vi.mock("@/core/connections/server/config", async importOriginal => {
  const actual = await importOriginal<typeof import("@/core/connections/server/config")>();
  return { ...actual, listConnections: () => [] };
});

const availability = { available: true, version: "0.1.6-alpha.2" };
const toolOrder = ["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"];
const unique = () => crypto.randomUUID().replaceAll("-", "");
const current = () => agentEngineSelection.status(availability);
const selected = (engine: "harness" | "dsh") => agentEngineSelection.select({ engine, revision: current().revision }, availability);
type Payload = ReturnType<typeof harnessPublicRequestSchema.parse>;
const fixtureDatasetIds: string[] = [];

beforeEach(() => {
  expect(current().activeTasks).toBe(0);
  selected("harness");
  mock.driver.mockReset(); mock.inspect.mockReset().mockResolvedValue(availability); mock.mcp.mockReset().mockResolvedValue(undefined);
  vi.stubEnv("DEEPSEEK_API_KEY", "");
  vi.stubEnv("HARNESS_MULTI_AGENT_MODE", "single");
  vi.stubEnv("HARNESS_VISUAL_VERIFICATION_ENABLED", "0");
  for (const key of ["DSH_MAX_TOOL_CALLS", "DSH_TOTAL_EXECUTION_TIMEOUT_MS", "DSH_TOOL_CALL_TIMEOUT_MS"]) vi.stubEnv(key, undefined);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No real provider or external network in this HTTP integration"); }));
  vi.spyOn(HarnessRuntime.prototype, "run").mockImplementation(async () => { throw new Error("The old Harness must not execute in a DSH request"); });
  vi.spyOn(CoordinatedHarness.prototype, "run");
  for (const name of ["classifyIntent", "plan", "next"] as const) {
    vi.spyOn(DeepSeekHarnessModel.prototype, name).mockImplementation(async () => { throw new Error("A real provider must not execute"); });
  }
});
afterEach(async () => {
  try { for (const id of fixtureDatasetIds.splice(0)) await datasetRepository.delete(resolveDemoRequestIdentity(), id); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
});

async function fixture(sensitive = false, originalFileName = "dsh-http-synthetic.csv") {
  if (!demoFixtureResult.success) throw new Error("Synthetic product unavailable");
  const csv = sensitive ? "region,amount,email\nEast,100,one@example.invalid\nEast,50,two@example.invalid\nSouth,80,three@example.invalid\n"
    : "region,amount\nEast,100\nEast,50\nSouth,80\n";
  const parsed = await parseCsvUpload({ originalFileName, mimeType: "text/csv",
    stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(csv)); controller.close(); } }) });
  const identity = resolveDemoRequestIdentity();
  const stored = await datasetRepository.put(identity, parsed);
  fixtureDatasetIds.push(stored.descriptor.source.id);
  expect(stored.descriptor.aiAccessPolicy).toBe(sensitive ? "pending" : "not-required");
  const source = stored.descriptor.source;
  const payload = harnessPublicRequestSchema.parse({ idempotencyKey: `dsh_http_${unique()}`, conversation_id: `dsh_thread_${unique()}`,
    instruction: "按地区汇总当前 CSV，生成 Notebook 的 SQL、表格和柱形图草稿，试运行后让我采用。", pageId: "page_home", dataSourceId: source.id,
    appSpec: { ...structuredClone(demoFixtureResult.data.dataProduct.appSpec), dataSources: [source] }, recipes: [],
    notebookContext: { sourceIds: [source.id], document: { name: "DSH HTTP 合成分析", revision: 7,
      cells: [{ id: "data", kind: "data", title: "合成 CSV", sourceDataSourceId: source.id, outputName: "sales_data" }] } } });
  return { payload, identity, datasetId: source.id };
}

function request(payload: Payload, signal?: AbortSignal) {
  return new Request("http://127.0.0.1:3001/api/ai/harness", { method: "POST", signal,
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3001" }, body: JSON.stringify(payload) });
}
function selectRequest(engine: "harness" | "dsh") {
  return new Request("http://127.0.0.1:3001/api/settings/agent-engine", { method: "PATCH",
    headers: { "content-type": "application/json", origin: "http://127.0.0.1:3001" },
    body: JSON.stringify({ engine, revision: current().revision }) });
}

function additions(multiplier: number): NotebookCell[] {
  return [
    { id: "totals", kind: "sql", title: "地区收入", inputCellIds: ["data"], outputName: "region_totals",
      sql: `SELECT region, (SUM(amount) * ${multiplier})::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region` },
    { id: "table", kind: "table", title: "收入表", inputCellId: "totals", columns: ["region", "revenue"] },
    { id: "chart", kind: "chart", title: "收入图", inputCellId: "totals", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
  ];
}
async function successfulDriver(input: DshDriverInput, multiplier = 1) {
  expect(input.tools.map(tool => tool.name).sort()).toEqual([...toolOrder, "getKernelPackagesInfo"].sort());
  const actions: Array<[string, unknown]> = [
    ["cellSearch", {}], ["editNotebookCells", { editVersion: 0, cells: additions(multiplier) }],
    ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }],
  ];
  for (const [name, args] of actions) {
    input.onModelCall();
    const result = await input.tools.find(tool => tool.name === name)!.execute(args, input.signal);
    expect(result).not.toHaveProperty("notebookArtifact");
    if (name === "runNotebookCells") expect(result.data).toMatchObject({ status: "success", results: expect.arrayContaining([
      expect.objectContaining({ cellId: "totals", rows: [{ region: "East", revenue: 150 * multiplier }, { region: "South", revenue: 80 * multiplier }] }),
      expect.objectContaining({ cellId: "table", rows: [{ region: "East", revenue: 150 * multiplier }, { region: "South", revenue: 80 * multiplier }] }),
      expect.objectContaining({ cellId: "chart", rows: [{ region: "East", revenue: 150 * multiplier }, { region: "South", revenue: 80 * multiplier }] }),
    ]) });
  }
  input.onModelCall();
  return { finalResponse: "UNTRUSTED_MODEL_COMPLETION_MUST_NOT_BE_THE_RECEIPT", model: "offline-dsh-route-fixture",
    usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 } };
}

function expectNoLegacyOrNetwork() {
  expect(HarnessRuntime.prototype.run).not.toHaveBeenCalled();
  expect(CoordinatedHarness.prototype.run).not.toHaveBeenCalled();
  expect(DeepSeekHarnessModel.prototype.next).not.toHaveBeenCalled();
  expect(DeepSeekHarnessModel.prototype.plan).not.toHaveBeenCalled();
  expect(DeepSeekHarnessModel.prototype.classifyIntent).not.toHaveBeenCalled();
  expect(mock.mcp).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}

async function semanticPayload(sensitive = false) {
  const test = await fixture(sensitive, "dsh-http-semantic-sales.csv");
  test.payload.semanticModel = { ...semanticFixture().model, sourceDatasetId: test.datasetId };
  test.payload.instruction = "使用当前选定的销售语义模型，创建按地区汇总的语义查询、表格和图表，试运行后供我确认。";
  return test;
}

function semanticCells(payload: Payload): NotebookCell[] {
  const model = payload.semanticModel!;
  return [
    { id: "semantic", kind: "semanticQuery", title: "选定地区销售口径", inputCellId: "data", outputName: "semantic_sales",
      modelId: model.id, modelVersion: model.version, dimensions: ["area"], measures: ["revenue"], limit: 100 },
    { id: "semantic_table", kind: "table", title: "销售口径结果表", inputCellId: "semantic", columns: ["area", "revenue"] },
    { id: "semantic_chart", kind: "chart", title: "销售口径图", inputCellId: "semantic", chartType: "bar", categoryField: "area", valueFields: ["revenue"] },
  ];
}

describe("DSH 公共 HTTP 单一已选语义模型接线", () => {
  it.each(["json", "sse"])("%s validates stored CSV, passes the selected model and produces a truly executed semantic draft", async transport => {
    selected("dsh");
    const { payload, datasetId } = await semanticPayload(), before = structuredClone(payload), cells = semanticCells(payload);
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      expect(input.context.semanticModel).toMatchObject({ id: payload.semanticModel!.id, version: 1, sourceDatasetId: datasetId });
      for (const [name, args] of [
        ["cellSearch", {}], ["editNotebookCells", { editVersion: 0, cells }],
        ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }],
      ] as Array<[string, unknown]>) {
        input.onModelCall(); const result = await input.tools.find(tool => tool.name === name)!.execute(args, input.signal);
        if (name === "runNotebookCells") expect(result.data).toMatchObject({ status: "success", completedCellIds: ["data", "semantic", "semantic_table", "semantic_chart"],
          results: expect.arrayContaining(["semantic", "semantic_table", "semantic_chart"].map(cellId => expect.objectContaining({ cellId,
            rows: [{ area: "East", revenue: 150 }, { area: "South", revenue: 80 }],
            resultRef: expect.objectContaining({ accessMode: "ai", revision: 7, complete: true }),
          }))) });
        expect(result).not.toHaveProperty("notebookArtifact");
      }
      return { finalResponse: "合成模型声称已经修改正式文档，不应替代确认回执。" };
    });
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload)); expect(response.status).toBe(200);
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal)
      : harnessResponseSchema.parse(await response.json());
    expect(result.task).toMatchObject({ state: "awaitingConfirmation", verification: { status: "passed" },
      notebookArtifact: { baseRevision: 7, sourceDataSourceIds: [datasetId], executionEvidence: { status: "success" } } });
    expect(result.task.notebookArtifact!.cells).toEqual([before.notebookContext!.document.cells[0], ...cells]);
    expect(mock.driver).toHaveBeenCalledTimes(1); expect(payload).toEqual(before); expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it.each(["json", "sse"])("%s can answer an existing semantic result only after a fresh authorized run", async transport => {
    selected("dsh");
    const { payload } = await semanticPayload();
    payload.instruction = "帮我看一下，能不能给我一个分析的结论";
    payload.notebookContext!.document.cells.push(...semanticCells(payload)); const before = structuredClone(payload);
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch", "runNotebookCells"]);
      expect(input.context.semanticModel).toMatchObject({ id: payload.semanticModel!.id, version: 1 });
      input.onModelCall(); await input.tools.find(tool => tool.name === "cellSearch")!.execute({}, input.signal);
      input.onModelCall(); const result = await input.tools.find(tool => tool.name === "runNotebookCells")!.execute({ editVersion: 0 }, input.signal);
      expect(result.data).toMatchObject({ status: "success", results: expect.arrayContaining([
        expect.objectContaining({ cellId: "semantic", rows: [{ area: "East", revenue: 150 }, { area: "South", revenue: 80 }] }),
      ]) });
      return { finalResponse: "按本次选定口径重新计算：East150、South80，合计230；没有修改正式分析或看板。" };
    });
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload)); expect(response.status).toBe(200);
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal)
      : harnessResponseSchema.parse(await response.json());
    expect(result.task).toMatchObject({ state: "completed", verification: { status: "passed" }, counters: { toolCallCount: 2 } });
    expect(result.task.resultMessage).toContain("合计230"); expect(result.task.notebookArtifact).toBeUndefined();
    expect(payload).toEqual(before); expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  describe.each(["json", "sse"] as const)("%s entry authorization and semantic validation", transport => {
    it.each(["wrong-source", "unknown-field", "unsupported-aggregation", "pending"] as const)("rejects %s before the DSH driver starts", async mode => {
      selected("dsh");
      const { payload } = await semanticPayload(mode === "pending");
      if (mode === "wrong-source") payload.semanticModel!.sourceDatasetId = "unselected_semantic_source";
      else if (mode === "unknown-field") payload.semanticModel!.measures[0].field = "missing_physical_field";
      else if (mode === "unsupported-aggregation") {
        payload.semanticModel!.measures[0].field = "region";
        payload.semanticModel!.measures[0].aggregation = "sum";
      }
      const before = structuredClone(payload);
      const response = await (transport === "sse" ? streamPOST : POST)(request(payload));
      expect(response.status).toBe(mode === "pending" ? 403 : 400);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toHaveProperty("error");
      expect(mock.driver).not.toHaveBeenCalled(); expect(payload).toEqual(before); expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
    });
  });
});

function textCells(): NotebookCell[] {
  return [
    { id: "text_total", kind: "sql", title: "完整单行总额", inputCellIds: ["data"], outputName: "text_sales_total",
      sql: "SELECT SUM(amount)::DOUBLE AS total FROM sales_data" },
    { id: "text_note", kind: "text", title: "绑定本次总额的说明", markdown: "销售合计 {{total}}。",
      references: [{ key: "total", cellId: "text_total", field: "total" }] },
  ];
}

describe("DSH 公共 HTTP 受控 text 接线", () => {
  it.each(["json", "sse"])("%s runs stored CSV through SQL and bound text without adopting the draft", async transport => {
    selected("dsh");
    const { payload, datasetId } = await fixture(false, "dsh-http-text-sales.csv"), cells = textCells();
    payload.instruction = "新增销售总额 SQL 汇总和绑定实际计算值的 text 说明，试运行后提交草稿让我确认。";
    const before = structuredClone(payload), events: HarnessTraceEvent[] = [];
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      for (const [name, args] of [
        ["cellSearch", {}], ["editNotebookCells", { editVersion: 0, cells }],
        ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }],
      ] as Array<[string, unknown]>) {
        input.onModelCall(); const result = await input.tools.find(tool => tool.name === name)!.execute(args, input.signal);
        if (name === "runNotebookCells") expect(result.data).toMatchObject({ status: "success", completedCellIds: ["data", "text_total", "text_note"],
          results: [expect.objectContaining({ cellId: "text_total", rows: [{ total: 230 }], resultRef: expect.objectContaining({ accessMode: "ai", complete: true }) })],
          textResults: [{ cellId: "text_note", text: "销售合计 230。", characterCount: 9, truncated: false }], textResultsOmitted: 0 });
        expect(result).not.toHaveProperty("notebookArtifact");
      }
      return { finalResponse: "模型自称已改正式定义，不能替代待采用回执。" };
    });
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload)); expect(response.status).toBe(200);
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal, event => events.push(event))
      : harnessResponseSchema.parse(await response.json());
    expect(result.task).toMatchObject({ state: "awaitingConfirmation", verification: { status: "passed" },
      notebookArtifact: { baseRevision: 7, sourceDataSourceIds: [datasetId], executionEvidence: { status: "success", completedCellIds: ["data", "text_total", "text_note"] } } });
    expect(result.task.notebookArtifact!.cells).toEqual([before.notebookContext!.document.cells[0], ...cells]);
    if (transport === "sse") {
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(events.filter(event => event.type === "tool_completed").map(event => event.toolCall?.name)).toEqual(toolOrder);
      expect(events.filter(event => event.type === "completed")).toHaveLength(1);
      expect(events.every(event => event.taskId === result.task.id)).toBe(true);
    }
    expect(mock.driver).toHaveBeenCalledTimes(1); expect(payload).toEqual(before); expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it("sse answers an existing bound text with new table evidence and no editing tools", async () => {
    selected("dsh");
    const { payload } = await fixture(false, "dsh-http-existing-text.csv");
    payload.instruction = "帮我看一下，能不能给我一个分析的结论";
    payload.notebookContext!.document.cells.push(...textCells()); const before = structuredClone(payload);
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch", "runNotebookCells"]);
      input.onModelCall(); await input.tools.find(tool => tool.name === "cellSearch")!.execute({}, input.signal);
      input.onModelCall(); const run = await input.tools.find(tool => tool.name === "runNotebookCells")!.execute({ editVersion: 0 }, input.signal);
      expect(run.data).toMatchObject({ status: "success", results: [expect.objectContaining({ cellId: "text_total", rows: [{ total: 230 }] })],
        textResults: [expect.objectContaining({ cellId: "text_note", text: "销售合计 230。" })] });
      return { finalResponse: "本次重新计算合计230，说明引用该完整单行汇总，正式步骤保持不变。" };
    });
    const response = await streamPOST(request(payload)); expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const result = await readHarnessStream(response, new AbortController().signal);
    expect(result.task).toMatchObject({ state: "completed", verification: { status: "passed" }, counters: { toolCallCount: 2 } });
    expect(result.task.notebookArtifact).toBeUndefined(); expect(result.task.resultMessage).toContain("合计230");
    expect(payload).toEqual(before); expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });
});

function parameterCells(): NotebookCell[] {
  return [
    { id: "minimum", kind: "parameter", title: "最低金额", outputName: "minimum", parameter: { type: "number", value: 80 } },
    { id: "region", kind: "parameter", title: "区域", outputName: "selected_region", parameter: { type: "select", value: "East", options: ["East", "South"] } },
    { id: "label", kind: "parameter", title: "标签", outputName: "report_label", parameter: { type: "text", value: "O'Reilly {{literal}}" } },
    { id: "day", kind: "parameter", title: "日期", outputName: "report_day", parameter: { type: "date", value: "2024-02-29" } },
    { id: "parameter_total", kind: "sql", title: "实际参数筛选合计", inputCellIds: ["data", "minimum", "region", "label", "day"], outputName: "parameter_sales_total",
      sql: "SELECT SUM(s.amount)::DOUBLE AS total, t.value AS label, CAST(d.value AS DATE) AS report_date FROM sales_data s CROSS JOIN minimum n CROSS JOIN selected_region r CROSS JOIN report_label t CROSS JOIN report_day d WHERE s.amount >= n.value AND s.region = r.value GROUP BY t.value, d.value" },
    { id: "parameter_note", kind: "text", title: "本轮筛选结果", markdown: "筛选后总额 {{total}}。",
      references: [{ key: "total", cellId: "parameter_total", field: "total" }] },
  ];
}

function expectParameterResult(data: unknown) {
  expect(data).toMatchObject({ status: "success", results: expect.arrayContaining([
    expect.objectContaining({ cellId: "parameter_total", rows: [{ total: 100, label: "O'Reilly {{literal}}", report_date: "2024-02-29" }],
      resultRef: expect.objectContaining({ accessMode: "ai", complete: true }) }),
  ]), textResults: [expect.objectContaining({ cellId: "parameter_note", text: "筛选后总额 100。" })] });
}

describe("DSH 公共 HTTP 四类 parameter 接线", () => {
  it.each(["json", "sse"])("%s answers current parameter values with complete source-only evidence and no execution", async transport => {
    selected("dsh");
    const { payload } = await fixture(false, "dsh-http-parameter-definition.csv");
    payload.instruction = "当前参数的值是什么？";
    payload.notebookContext!.document.cells.push(...parameterCells());
    const before = structuredClone(payload), events: HarnessTraceEvent[] = [];
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch"]);
      for (const cellId of ["minimum", "region", "label", "day"]) {
        input.onModelCall();
        const result = await input.tools[0].execute({ cellId, view: "source" }, input.signal);
        expect(result.data).toMatchObject({ sourceCellId: cellId, sourceTruncated: false,
          nextSourceOffset: null, editVersion: 0, baseRevision: 7, runStatus: "notRun" });
        expect(result).not.toHaveProperty("notebookArtifact");
      }
      return { finalResponse: "当前最低金额80、地区East、标签O'Reilly {{literal}}、日期2024-02-29；它们是输入定义，不是销售分析结果，未执行 Notebook。" };
    });
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload)); expect(response.status).toBe(200);
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal, event => events.push(event))
      : harnessResponseSchema.parse(await response.json());
    expect(result.task).toMatchObject({ state: "completed", verification: { status: "passed" }, counters: { toolCallCount: 4 } });
    expect(result.task.resultMessage).toContain("最低金额80"); expect(result.task.notebookArtifact).toBeUndefined();
    if (transport === "sse") {
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(events.filter(event => event.type === "tool_started").map(event => event.toolCall?.name)).toEqual(Array(4).fill("cellSearch"));
      expect(events.filter(event => event.type === "completed")).toHaveLength(1);
    }
    expect(mock.driver).toHaveBeenCalledTimes(1); expect(payload).toEqual(before); expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it.each(["json", "sse"])("%s executes stored CSV and canonical parameters, preserving formal definitions until confirmation", async transport => {
    selected("dsh");
    const { payload, datasetId } = await fixture(false, "dsh-http-parameter-sales.csv"), cells = parameterCells();
    payload.instruction = "新增四类参数，用 SQL 按最低金额与地区筛选实际数据，并引用结果写说明，试运行后提交草稿。";
    const before = structuredClone(payload), events: HarnessTraceEvent[] = [];
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      for (const [name, args] of [
        ["cellSearch", {}], ["editNotebookCells", { editVersion: 0, cells }],
        ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }],
      ] as Array<[string, unknown]>) {
        input.onModelCall(); const result = await input.tools.find(tool => tool.name === name)!.execute(args, input.signal);
        if (name === "runNotebookCells") expectParameterResult(result.data);
        expect(result).not.toHaveProperty("notebookArtifact");
      }
      return { finalResponse: "尚须用户采用参数草稿，模型文字不能直接改正式定义。" };
    });
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload)); expect(response.status).toBe(200);
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal, event => events.push(event))
      : harnessResponseSchema.parse(await response.json());
    expect(result.task).toMatchObject({ state: "awaitingConfirmation", verification: { status: "passed" },
      notebookArtifact: { baseRevision: 7, sourceDataSourceIds: [datasetId], executionEvidence: { status: "success" } } });
    expect(result.task.notebookArtifact!.cells).toEqual([before.notebookContext!.document.cells[0], ...cells]);
    if (transport === "sse") {
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(events.filter(event => event.type === "tool_completed").map(event => event.toolCall?.name)).toEqual(toolOrder);
      expect(events.filter(event => event.type === "completed")).toHaveLength(1);
      expect(events.every(event => event.taskId === result.task.id)).toBe(true);
    }
    expect(mock.driver).toHaveBeenCalledTimes(1); expect(payload).toEqual(before); expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it("sse readonly follow-up recomputes current parameter-dependent data without editing or submitting", async () => {
    selected("dsh");
    const { payload } = await fixture(false, "dsh-http-existing-parameters.csv");
    payload.instruction = "帮我看一下，能不能给我一个分析的结论";
    payload.notebookContext!.document.cells.push(...parameterCells()); const before = structuredClone(payload);
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch", "runNotebookCells"]);
      input.onModelCall(); await input.tools.find(tool => tool.name === "cellSearch")!.execute({}, input.signal);
      input.onModelCall(); expectParameterResult((await input.tools.find(tool => tool.name === "runNotebookCells")!.execute({ editVersion: 0 }, input.signal)).data);
      return { finalResponse: "按当前参数筛选 East 金额至少80，实际合计100；未编辑参数或分析步骤。" };
    });
    const response = await streamPOST(request(payload)); expect(response.status).toBe(200);
    const result = await readHarnessStream(response, new AbortController().signal);
    expect(result.task).toMatchObject({ state: "completed", verification: { status: "passed" }, counters: { toolCallCount: 2 } });
    expect(result.task.notebookArtifact).toBeUndefined(); expect(result.task.resultMessage).toContain("实际合计100");
    expect(payload).toEqual(before); expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });
});

describe("真实 Harness HTTP 入口的 DSH 分派", () => {
  it.each(["json", "sse"])("%s 原句请求分析结论只读运行并直接回答，不要求修改或提交", async transport => {
    selected("dsh");
    const { payload } = await fixture(false, "conclusion-existing-sales.csv");
    payload.instruction = "帮我看一下，能不能给我一个分析的结论";
    payload.notebookContext!.document.cells.push(...additions(1));
    const before = structuredClone(payload);
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      expect(input.tools.map(tool => tool.name).sort()).toEqual(["cellSearch", "runNotebookCells"]);
      input.onModelCall();
      await input.tools.find(tool => tool.name === "cellSearch")!.execute({}, input.signal);
      const run = await input.tools.find(tool => tool.name === "runNotebookCells")!.execute({ editVersion: 0 }, input.signal);
      expect(run.data).toMatchObject({ status: "success", completedCellIds: ["data", "totals", "table", "chart"],
        results: expect.arrayContaining([expect.objectContaining({ cellId: "table", rows: [
          { region: "East", revenue: 150 }, { region: "South", revenue: 80 },
        ] })]) });
      // The generic tool omits next for unchanged sessions; the read-only
      // engine explicitly directs its closed catalog to deliver an answer.
      expect(run.data).toHaveProperty("next", "answer");
      expect(run.summary).not.toContain("可提交修改对照");
      return { finalResponse: "本次运行的结论：East销售额150，高于South的80；合计230。未修改分析步骤。" };
    });
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload));
    expect(response.status).toBe(200);
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal)
      : harnessResponseSchema.parse(await response.json());
    expect(result.task).toMatchObject({ state: "completed", terminationCode: "completed", verification: { status: "passed" } });
    expect(result.task.notebookArtifact).toBeUndefined();
    expect(result.task.resultMessage).toContain("150");
    expect(result.task.trace?.some(event => ["editNotebookCells", "submitNotebookDraft"].includes(event.toolCall?.name ?? ""))).toBe(false);
    expect(payload).toEqual(before); expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it("原句没有本轮有效输出时不能只读完源码就交付数字结论", async () => {
    selected("dsh");
    const { payload } = await fixture();
    payload.instruction = "帮我看一下，能不能给我一个分析的结论";
    payload.notebookContext!.document.cells.push(...additions(1));
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      input.onModelCall();
      await input.tools.find(tool => tool.name === "cellSearch")!.execute({}, input.signal);
      return { finalResponse: "East收入150，South收入80。" };
    });
    const result = harnessResponseSchema.parse(await (await POST(request(payload))).json());
    expect(result.task).toMatchObject({ state: "failed", terminationCode: "verificationFailed" });
    expect(result.task.notebookArtifact).toBeUndefined(); expectNoLegacyOrNetwork();
  });

  it.each(["给我一个分析结论，并新增一张图表", "给我一个分析结论，并按月重新统计", "给我一个分析结论，并导出Excel"])("%s 不得用只读回答掩盖尚未完成的新目标", async instruction => {
    selected("dsh");
    const { payload } = await fixture(); payload.instruction = instruction;
    payload.notebookContext!.document.cells.push(...additions(1));
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      expect(input.tools.some(tool => tool.name === "editNotebookCells")).toBe(true);
      input.onModelCall();
      await input.tools.find(tool => tool.name === "runNotebookCells")!.execute({ editVersion: 0 }, input.signal);
      return { finalResponse: "已有结果East150、South80。" };
    });
    const result = harnessResponseSchema.parse(await (await POST(request(payload))).json());
    expect(result.task).toMatchObject({ state: "failed", terminationCode: "verificationFailed" });
    expect(result.task.notebookArtifact).toBeUndefined(); expectNoLegacyOrNetwork();
  });

  it.each(["json", "sse"])("%s 保留已有transform并真实运行下游分析，不再零步骤受阻", async transport => {
    selected("dsh");
    const { payload } = await fixture(false, "input.csv");
    payload.instruction = "分析input文件";
    const transform: NotebookCell = { id: "clean", kind: "transform", title: "已有数据处理", inputCellId: "data",
      outputName: "clean_data", steps: [{ id: "keep", type: "selectFields", fields: ["region", "amount"] }] };
    payload.notebookContext!.document.cells.push(transform);
    const before = structuredClone(payload);
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      const execute = async (name: string, args: unknown) => {
        input.onModelCall();
        return input.tools.find(tool => tool.name === name)!.execute(args, input.signal);
      };
      const index = await execute("cellSearch", {});
      expect(index.data).toMatchObject({ totalCells: 2, cells: expect.arrayContaining([expect.objectContaining({ id: "clean", kind: "transform" })]) });
      const next = additions(1).map(cell => cell.kind === "sql"
        ? { ...cell, inputCellIds: ["clean"], sql: cell.sql.replace("FROM sales_data", "FROM clean_data") } : cell);
      await execute("editNotebookCells", { editVersion: 0, cells: next });
      const run = await execute("runNotebookCells", { editVersion: 1 });
      expect(run.data).toMatchObject({ status: "success", completedCellIds: ["data", "clean", "totals", "table", "chart"],
        results: expect.arrayContaining([expect.objectContaining({ cellId: "totals", rows: [
          { region: "East", revenue: 150 }, { region: "South", revenue: 80 },
        ] })]) });
      await execute("submitNotebookDraft", { editVersion: 1 });
      return { finalResponse: "本次真实计算已经提交草稿。" };
    });
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload));
    expect(response.status).toBe(200);
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal)
      : harnessResponseSchema.parse(await response.json());
    expect(result.task.state).toBe("awaitingConfirmation");
    expect(result.task.counters).toMatchObject({ toolCallCount: 4, modelCallCount: 4 });
    expect(result.task.notebookArtifact?.cells).toContainEqual(transform);
    expect(result.task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(payload).toEqual(before);
    expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it.each(["json", "sse"])("%s 普通文件分析可依据真实已有链路回答，不制造空修改草稿", async transport => {
    selected("dsh");
    const { payload } = await fixture(false, "input.csv");
    payload.instruction = "分析input文件";
    payload.notebookContext!.document.cells.push({ id: "clean", kind: "transform", title: "已有数据处理", inputCellId: "data",
      outputName: "clean_data", steps: [{ id: "keep", type: "selectFields", fields: ["region", "amount"] }] },
    ...additions(1).map(cell => cell.kind === "sql"
      ? { ...cell, inputCellIds: ["clean"], sql: cell.sql.replace("FROM sales_data", "FROM clean_data") } : cell));
    const before = structuredClone(payload);
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      // Analysis is still free to create a draft. It is not pre-routed to a
      // read-only catalog merely because this deterministic driver reuses cells.
      expect(input.tools.some(tool => tool.name === "editNotebookCells")).toBe(true);
      const execute = async (name: string, args: unknown) => {
        input.onModelCall(); return input.tools.find(tool => tool.name === name)!.execute(args, input.signal);
      };
      await expect(execute("cellSearch", { editVersion: 999 })).rejects.toThrow();
      await execute("cellSearch", {});
      const run = await execute("runNotebookCells", { editVersion: 0 });
      expect(run.data).toMatchObject({ status: "success", results: expect.arrayContaining([
        expect.objectContaining({ cellId: "table", rows: [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }] }),
      ]) });
      return { finalResponse: "本次运行已有数据处理与地区汇总：East销售额150，South销售额80，合计230；没有新增步骤。" };
    });
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload));
    expect(response.status).toBe(200);
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal)
      : harnessResponseSchema.parse(await response.json());
    expect(result.task).toMatchObject({ state: "completed", terminationCode: "completed", verification: { status: "passed" } });
    expect(result.task.notebookArtifact).toBeUndefined();
    expect(result.task.resultMessage).toContain("150");
    expect(result.task.trace?.some(event => event.toolCall?.name === "editNotebookCells" || event.toolCall?.name === "submitNotebookDraft")).toBe(false);
    expect(payload).toEqual(before); expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it.each(["分析input文件并生成新图表", "分析input文件，按月统计收入", "分析nonexistent_other_file文件"])("%s 不能用已有分析答案代替新目标或其他来源", async instruction => {
    selected("dsh");
    const { payload } = await fixture(false, "input.csv");
    payload.instruction = instruction;
    payload.notebookContext!.document.cells.push(...additions(1));
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      for (const [name, args] of [["cellSearch", {}], ["runNotebookCells", { editVersion: 0 }]] as const) {
        input.onModelCall(); await input.tools.find(tool => tool.name === name)!.execute(args, input.signal);
      }
      return { finalResponse: "现有地区汇总显示East150、South80，已运行，没有新建步骤。" };
    });
    const result = harnessResponseSchema.parse(await (await POST(request(payload))).json());
    expect(result.task).toMatchObject({ state: "failed", terminationCode: "verificationFailed" });
    expect(result.task.notebookArtifact).toBeUndefined();
    expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it.each(["json", "sse"])("%s 部署关闭 Python 时给出安全初始化原因，零模型且不泄露定义", async transport => {
    selected("dsh");
    vi.stubEnv("NOTEBOOK_PYTHON_ENABLED", "false");
    const { payload } = await fixture();
    payload.notebookContext!.document.cells.push({ id: "private_cell", kind: "python", title: "PRIVATE_TITLE", outputName: "private_output",
      inputCellIds: ["data"], fileNames: [], code: "PRIVATE_CELL_CONTENT" });
    const before = structuredClone(payload);
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload));
    expect(response.status).toBe(200);
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal)
      : harnessResponseSchema.parse(await response.json());
    expect(result.task).toMatchObject({ state: "blocked", terminationCode: "missingRequirements",
      counters: { toolCallCount: 0, modelCallCount: 0 } });
    expect(result.task.resultMessage).toContain("python_unavailable");
    expect(result.task.resultMessage).toContain("本次未启动模型或工具");
    expect(JSON.stringify(result.task)).not.toMatch(/PRIVATE_TITLE|PRIVATE_CELL_CONTENT|private_cell/u);
    expect(result.task.notebookArtifact).toBeUndefined();
    expect(payload).toEqual(before); expect(mock.driver).not.toHaveBeenCalled();
    expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it.each(["json", "sse"])("DSH不继承旧Harness限制，134次真实工具后仍交付长回答且 %s 契约有效", async transport => {
    selected("dsh");
    const { payload } = await fixture();
    vi.stubEnv("HARNESS_MAX_TOOL_CALLS", "1"); vi.stubEnv("HARNESS_TOTAL_EXECUTION_TIMEOUT_MS", "1000");
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      expect(input.context.executionBudget).toMatchObject({ maxToolCalls: null, toolCallsRemaining: null,
        totalExecutionTimeoutMs: null, toolCallTimeoutMs: null });
      for (let index = 0; index < 130; index += 1) {
        input.onModelCall();
        await input.tools.find(tool => tool.name === "cellSearch")!.execute({}, input.signal);
      }
      return { ...await successfulDriver(input), finalResponse: "按地区输出样本说明。".repeat(350) + "长回答末尾保留" };
    });
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload));
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal)
      : harnessResponseSchema.parse(await response.json());
    expect(result.task.state).toBe("awaitingConfirmation");
    expect(result.task.resultMessage).toContain("长回答末尾保留");
    expect(result.task.resultMessage!.length).toBeGreaterThan(3000);
    expect(result.task.counters.toolCallCount).toBe(134);
    expect(result.task.trace).toHaveLength(256);
    expect(result.task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(result.task.trace?.at(-1)?.sequence).toBeGreaterThan(256);
    expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it("DSH环境可显式配置预算，公共请求不接受修改预算", async () => {
    selected("dsh");
    const { payload } = await fixture();
    vi.stubEnv("DSH_MAX_TOOL_CALLS", "8"); vi.stubEnv("DSH_TOTAL_EXECUTION_TIMEOUT_MS", "60000"); vi.stubEnv("DSH_TOOL_CALL_TIMEOUT_MS", "15000");
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      expect(input.context.executionBudget).toMatchObject({ maxToolCalls: 8, totalExecutionTimeoutMs: 60_000, toolCallTimeoutMs: 15_000 });
      return successfulDriver(input);
    });
    const result = harnessResponseSchema.parse(await (await POST(request(payload))).json());
    expect(result.task.state).toBe("awaitingConfirmation");
    const forged = { ...payload, idempotencyKey: `forged_${unique()}`, bounds: { maxToolCalls: 1000 } };
    const response = await POST(request(forged));
    expect(response.status).toBe(400);
    expect(mock.driver).toHaveBeenCalledOnce(); expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it("DSH非法环境配置拒绝执行并释放租约，不泄露配置值", async () => {
    selected("dsh");
    const { payload } = await fixture();
    vi.stubEnv("DSH_MAX_TOOL_CALLS", "PRIVATE_INVALID_CONFIG");
    const response = await POST(request(payload));
    expect(response.status).toBe(503); expect(await response.text()).not.toContain("PRIVATE_INVALID_CONFIG");
    expect(mock.driver).not.toHaveBeenCalled(); expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it.each(["json", "sse"])("%s 使用真实 CSV/四工具/SQL 和既有回执，不调用旧循环或正式采用", async transport => {
    selected("dsh");
    const { payload } = await fixture();
    const before = structuredClone(payload);
    mock.driver.mockImplementation(successfulDriver);
    const events: HarnessTraceEvent[] = [];
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload));
    expect(response.status).toBe(200);
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal, event => events.push(event))
      : harnessResponseSchema.parse(await response.json());
    expect(result.task.state).toBe("awaitingConfirmation");
    expect(result.task.notebookArtifact?.executionEvidence).toMatchObject({ status: "success", completedCellIds: ["data", "totals", "table", "chart"] });
    expect(result.task.notebookArtifact?.baseRevision).toBe(7);
    expect(result.task.counters).toMatchObject({ modelCallCount: 5, toolCallCount: 4 });
    expect(result.task.pendingChangeSet).toBeUndefined();
    expect(result.task.verification?.status).toBe("passed");
    // Model prose may now be displayed, but never replaces the bridge receipt
    // or the authoritative task/event state asserted above.
    expect(result.task.resultMessage).toContain("AI 分析说明：\nUNTRUSTED_MODEL_COMPLETION");
    expect(result.task.resultMessage).toContain("待你确认后才保存");
    expect(JSON.stringify(result.task.events)).not.toContain("UNTRUSTED_MODEL_COMPLETION");
    expect(JSON.stringify(result.task.notebookArtifact)).not.toContain("UNTRUSTED_MODEL_COMPLETION");
    expect(result.task.conversationStorage).toBe("memory");
    expect(payload).toEqual(before);
    expect(current().activeTasks).toBe(0);
    if (transport === "sse") {
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(events.filter(event => event.type === "completed")).toHaveLength(1);
      expect(events.filter(event => event.type === "tool_completed").map(event => event.toolCall?.name)).toEqual(toolOrder);
      expect(events.map(event => event.sequence)).toEqual(events.map((_event, index) => index + 1));
      expect(events.every(event => event.taskId === result.task.id)).toBe(true);
    }
    expectNoLegacyOrNetwork();
  }, 20_000);

  it.each(["json", "sse"])("%s 不展示与真实待确认状态冲突的模型保存声明", async transport => {
    selected("dsh");
    const { payload } = await fixture();
    const before = structuredClone(payload);
    mock.driver.mockImplementation(async (input: DshDriverInput) => ({ ...await successfulDriver(input),
      finalResponse: "already published: MODEL_STATUS_CANNOT_CONFIRM_THE_DRAFT" }));
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload));
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal)
      : harnessResponseSchema.parse(await response.json());
    expect(result.task.state).toBe("awaitingConfirmation");
    expect(result.task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(result.task.resultMessage).not.toContain("MODEL_STATUS_CANNOT_CONFIRM_THE_DRAFT");
    expect(result.task.resultMessage).toContain("待你确认后才保存");
    expect(payload).toEqual(before);
    expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  }, 20_000);

  it("同会话显式采用后的第二轮得到服务端历史和当前定义，重新计算 300/160", async () => {
    selected("dsh");
    const { payload } = await fixture();
    const contexts: Record<string, unknown>[] = [];
    mock.driver.mockImplementation(async (input: DshDriverInput) => { contexts.push(structuredClone(input.context)); return successfulDriver(input, contexts.length); });
    const first = harnessResponseSchema.parse(await (await POST(request(payload))).json()).task;
    expect(first.notebookArtifact).toBeDefined();
    const document = adoptNotebookDraft(payload.notebookContext!.document, first.notebookArtifact!);
    const next = harnessPublicRequestSchema.parse({ ...payload, idempotencyKey: `dsh_second_${unique()}`,
      instruction: "接着把刚才各地区收入乘以二，重新试运行后给我草稿。",
      notebookContext: { ...payload.notebookContext, document },
      conversationContext: { previousInstruction: "FORGED_CLIENT_HISTORY", recentMessages: [] } });
    const formal = structuredClone(next);
    const second = (await readHarnessStream(await streamPOST(request(next)), new AbortController().signal)).task;
    expect(second.state).toBe("awaitingConfirmation");
    expect(second.notebookArtifact?.baseRevision).toBe(8);
    expect(second.notebookArtifact?.executionEvidence?.runId).not.toBe(first.notebookArtifact?.executionEvidence?.runId);
    expect(contexts[0].recentConversation).not.toHaveProperty("previousInstruction");
    expect(contexts[1].recentConversation).toMatchObject({ trust: "untrustedConversationContinuityOnly", previousInstruction: payload.instruction,
      recentMessages: [expect.objectContaining({ instruction: payload.instruction })] });
    expect(JSON.stringify(contexts[1])).not.toContain("FORGED_CLIENT_HISTORY");
    expect(JSON.stringify(contexts[1])).not.toContain(first.notebookArtifact!.executionEvidence!.runId);
    expect(next).toEqual(formal);
    expect(current().activeTasks).toBe(0);
    expectNoLegacyOrNetwork();
  }, 20_000);

  it("相同幂等请求在切回原版后仍回放原 DSH 任务，不执行第二次", async () => {
    selected("dsh");
    const { payload } = await fixture();
    mock.driver.mockImplementation(successfulDriver);
    const first = harnessResponseSchema.parse(await (await POST(request(payload))).json()).task;
    expect((await settingsPATCH(selectRequest("harness"))).status).toBe(200);
    const replay = (await readHarnessStream(await streamPOST(request(payload)), new AbortController().signal)).task;
    expect(replay).toEqual(first);
    expect(mock.driver).toHaveBeenCalledOnce();
    expect(current().activeTasks).toBe(0);
    expectNoLegacyOrNetwork();
  }, 20_000);

  it("运行中切换 409、同会话冲突不泄漏租约，取消后可切回并发起后续请求", async () => {
    selected("dsh");
    const { payload } = await fixture();
    const controller = new AbortController();
    let entered: (input: DshDriverInput) => void = () => {};
    const started = new Promise<DshDriverInput>(resolve => { entered = resolve; });
    mock.driver.mockImplementationOnce((input: DshDriverInput) => {
      entered(input);
      return new Promise((_resolve, reject) => input.signal.addEventListener("abort", () => reject(new Error("Synthetic cancellation")), { once: true }));
    });
    const pending = POST(request(payload, controller.signal));
    const input = await started;
    expect(current().activeTasks).toBe(1);
    expect((await settingsPATCH(selectRequest("harness"))).status).toBe(409);
    const conflict = await POST(request({ ...payload, idempotencyKey: `dsh_conflict_${unique()}` }));
    expect(conflict.status).toBe(503);
    expect(current().activeTasks).toBe(1);
    controller.abort();
    const result = harnessResponseSchema.parse(await (await pending).json());
    expect(result.task.state).toBe("cancelled");
    expect(result.task.notebookArtifact).toBeUndefined();
    expect(input.signal.aborted).toBe(true);
    expect(current().activeTasks).toBe(0);
    mock.driver.mockResolvedValueOnce({ finalResponse: "no artifact" });
    const next = await POST(request({ ...payload, idempotencyKey: `dsh_after_cancel_${unique()}` }));
    expect(next.status).toBe(200);
    expect(harnessResponseSchema.parse(await next.json()).task.state).toBe("failed");
    expect(current().activeTasks).toBe(0);
    expect((await settingsPATCH(selectRequest("harness"))).status).toBe(200);
    expectNoLegacyOrNetwork();
  });

  it("DSH 失败不降级且释放租约，未授权 pending 数据在进入内核前被拒绝", async () => {
    selected("dsh");
    const { payload } = await fixture();
    mock.driver.mockRejectedValue(new Error("PRIVATE_PROVIDER_DIAGNOSTIC"));
    const failed = await POST(request(payload));
    expect(failed.status).toBe(200);
    const body = await failed.text();
    const task = harnessResponseSchema.parse(JSON.parse(body)).task;
    expect(task.state).toBe("failed");
    expect(task.notebookArtifact).toBeUndefined();
    expect(body).not.toContain("PRIVATE_PROVIDER_DIAGNOSTIC");
    expect(current().activeTasks).toBe(0);
    const sensitive = await fixture(true);
    sensitive.payload.appSpec.dataSources[0].aiAccessPolicy = "not-required";
    const rejected = await streamPOST(request(sensitive.payload));
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("content-type")).toContain("application/json");
    expect(mock.driver).toHaveBeenCalledOnce();
    expect(current().activeTasks).toBe(0);
    expectNoLegacyOrNetwork();
  });

  it("本轮授权撤回仍阻止工具并无可采用草稿", async () => {
    selected("dsh");
    const { payload, identity, datasetId } = await fixture();
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      await datasetRepository.delete(identity, datasetId);
      input.onModelCall();
      return { finalResponse: "unreachable" };
    });
    const task = harnessResponseSchema.parse(await (await POST(request(payload))).json()).task;
    expect(task.state).toBe("failed");
    expect(task.resultMessage).toContain("授权已变化");
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.counters.toolCallCount).toBe(0);
    expect(current().activeTasks).toBe(0);
    expectNoLegacyOrNetwork();
  });

  it("默认原版路径继续分派旧 coordinator，DSH transport 完全不启动", async () => {
    const { payload } = await fixture();
    vi.stubEnv("DSH_MAX_TOOL_CALLS", "INVALID_UNUSED_DSH_CONFIG");
    vi.stubEnv("HARNESS_MAX_TOOL_CALLS", "3");
    vi.mocked(HarnessRuntime.prototype.run).mockImplementationOnce(async raw => {
      const parsed = harnessRequestSchema.parse(raw);
      return { ...createHarnessTask(parsed.idempotencyKey, parsed.instruction, parsed.pageId, parsed.role,
        { now: () => new Date(), id: unique }), state: "completed", resultMessage: "Original dispatcher fixture" };
    });
    const response = await POST(request(payload));
    expect(response.status).toBe(200);
    expect(harnessResponseSchema.parse(await response.json()).task.resultMessage).toBe("Original dispatcher fixture");
    expect(CoordinatedHarness.prototype.run).toHaveBeenCalledOnce();
    expect(HarnessRuntime.prototype.run).toHaveBeenCalledOnce();
    expect(vi.mocked(HarnessRuntime.prototype.run).mock.calls[0][1].bounds?.maxToolCalls).toBe(3);
    expect(mock.driver).not.toHaveBeenCalled();
    expect(current().activeTasks).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });
});
