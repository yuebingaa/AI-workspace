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

describe("真实 Harness HTTP 入口的 DSH 分派", () => {
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

  it.each(["json", "sse"])("%s 未支持单元给出安全初始化原因，零模型且不泄露定义", async transport => {
    selected("dsh");
    const { payload } = await fixture();
    payload.notebookContext!.document.cells.push({ id: "private_cell", kind: "text", title: "PRIVATE_TITLE",
      markdown: "PRIVATE_CELL_CONTENT" });
    const before = structuredClone(payload);
    const response = await (transport === "sse" ? streamPOST : POST)(request(payload));
    expect(response.status).toBe(200);
    const result = transport === "sse" ? await readHarnessStream(response, new AbortController().signal)
      : harnessResponseSchema.parse(await response.json());
    expect(result.task).toMatchObject({ state: "blocked", terminationCode: "missingRequirements",
      counters: { toolCallCount: 0, modelCallCount: 0 } });
    expect(result.task.resultMessage).toContain("notebook_cell_unsupported");
    expect(result.task.resultMessage).toContain("本次未启动模型或工具");
    expect(JSON.stringify(result.task)).not.toMatch(/PRIVATE_TITLE|PRIVATE_CELL_CONTENT|private_cell/u);
    expect(result.task.notebookArtifact).toBeUndefined();
    expect(payload).toEqual(before); expect(mock.driver).not.toHaveBeenCalled();
    expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it("DSH默认保护不继承旧Harness六次，八次真实工具后交付已验证草稿", async () => {
    selected("dsh");
    const { payload } = await fixture();
    vi.stubEnv("HARNESS_MAX_TOOL_CALLS", "1"); vi.stubEnv("HARNESS_TOTAL_EXECUTION_TIMEOUT_MS", "1000");
    mock.driver.mockImplementation(async (input: DshDriverInput) => {
      expect(input.context.executionBudget).toMatchObject({ maxToolCalls: 24, toolCallsRemaining: 24,
        totalExecutionTimeoutMs: 180_000, toolCallTimeoutMs: 35_000 });
      for (let index = 0; index < 4; index += 1) {
        input.onModelCall();
        await input.tools.find(tool => tool.name === "cellSearch")!.execute({}, input.signal);
      }
      return successfulDriver(input);
    });
    const result = harnessResponseSchema.parse(await (await POST(request(payload))).json());
    expect(result.task.state).toBe("awaitingConfirmation");
    expect(result.task.counters.toolCallCount).toBe(8);
    expect(result.task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(result.task.trace?.find(event => event.type === "task_started" && event.clientTimeoutMs)).toMatchObject({ clientTimeoutMs: 185_000 });
    expect(current().activeTasks).toBe(0); expectNoLegacyOrNetwork();
  });

  it("DSH环境仅可收紧可信保护，公共请求不接受提升预算", async () => {
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
    expect(result.task.resultMessage).not.toContain("UNTRUSTED_MODEL_COMPLETION");
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
