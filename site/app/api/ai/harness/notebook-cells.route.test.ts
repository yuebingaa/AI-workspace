import { afterEach, describe, expect, it, vi } from "vitest";
import writeXlsxFile from "write-excel-file/node";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { HarnessRuntime } from "@/core/harness/runtime";
import { readHarnessStream } from "@/core/harness/stream";
import type { HarnessModel, HarnessToolName, HarnessTraceEvent } from "@/core/harness/contracts";
import { POST } from "./stream/route";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("Notebook 单元工具经公开 SSE API 执行", () => {
  it("当前请求的 Excel 原件供 Agent Python 读取，字节不进入模型上下文", async () => {
    vi.stubEnv("HARNESS_MCP_ENABLED", "false"); vi.stubEnv("HARNESS_MULTI_AGENT_MODE", "single");
    if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
    const workbook = await writeXlsxFile([{ sheet: "alarms", data: [
      [{ value: "seconds", type: String }], [{ value: 60, type: Number }], [{ value: 120, type: Number }],
    ] }]).toBuffer();
    const calls: Array<[HarnessToolName, Record<string, unknown>]> = [["cellSearch", {}], ["createPythonCell", { editVersion: 0,
      cell: { id: "python", kind: "python", title: "读取附件", inputCellIds: [], fileNames: ["agent-synthetic.xlsx"], outputName: "result",
        code: "raw = pd.read_excel(files['agent-synthetic.xlsx'])\nresult = pd.DataFrame({'minutes': [raw.seconds.sum() / 60]})" } }],
      ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }]];
    const model: HarnessModel = { next: async ({ iteration, context }) => {
      expect(JSON.stringify(context)).not.toContain(workbook.toString("base64"));
      if (iteration === 4) expect(context.latestObservation).toMatchObject({ result: { status: "success", results: [{ rows: [{ minutes: 3 }] }] } });
      const [name, args] = calls[iteration - 1];
      return { model: "scripted-python-xlsx", usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
        turn: { type: "callTool", name, arguments: args, toolCallId: `xlsx_${iteration}`, message: "读取合成附件" } };
    } };
    const originalRun = HarnessRuntime.prototype.run;
    vi.spyOn(HarnessRuntime.prototype, "run").mockImplementation(function (this: HarnessRuntime, input, options) {
      expect(options.rawWorkbook).not.toHaveProperty("bytes");
      return originalRun.call(this, input, { ...options, modelClient: model });
    });
    const form = new FormData();
    form.set("rawWorkbook", new File([new Uint8Array(workbook)], "agent-synthetic.xlsx"));
    form.set("payload", JSON.stringify({ idempotencyKey: "python_xlsx_" + crypto.randomUUID().replaceAll("-", ""),
      instruction: "创建 Python 单元，读取 Excel 附件并汇总停机分钟", pageId: "page_home", appSpec: demoFixtureResult.data.dataProduct.appSpec, recipes: [],
      notebookContext: { sourceIds: [], document: { name: "附件 Python", revision: 0, cells: [] } },
    }));
    const response = await POST(new Request("http://localhost/api/ai/harness/stream", { method: "POST", body: form }));
    expect(response.status).toBe(200);
    const { task } = await readHarnessStream(response, new AbortController().signal, () => {});
    expect(task.state, task.error).toBe("awaitingConfirmation");
    expect(task.verification?.status).toBe("passed");
  }, 30_000);

  it("Agent 查询环境、创建 Python、真实执行后才提交待采用草稿", async () => {
    vi.stubEnv("HARNESS_MCP_ENABLED", "false");
    vi.stubEnv("HARNESS_MULTI_AGENT_MODE", "single");
    if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
    const product = structuredClone(demoFixtureResult.data.dataProduct);
    const calls: Array<[HarnessToolName, Record<string, unknown>]> = [["cellSearch", {}], ["getKernelPackagesInfo", {}],
      ["createPythonCell", { editVersion: 0, cell: { id: "python", kind: "python", title: "Python 示例", inputCellIds: [], fileNames: [], outputName: "result",
        code: "result = pd.DataFrame({'value': np.array([2, 3]) * 10})\nprint('computed')" } }],
      ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }]];
    const model: HarnessModel = { next: async ({ iteration, context }) => {
      if (iteration === 3) expect(context.latestObservation).toMatchObject({ result: { available: true, packages: { pandas: "3.0.2" } } });
      if (iteration === 5) expect(context.latestObservation).toMatchObject({ result: { status: "success", results: [{ rows: [{ value: 20 }, { value: 30 }] }] } });
      const [name, args] = calls[iteration - 1];
      return { model: "scripted-python-api", usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
        turn: { type: "callTool", name, arguments: args, toolCallId: `python_${iteration}`, message: "验证 Python 步骤" } };
    } };
    const originalRun = HarnessRuntime.prototype.run;
    vi.spyOn(HarnessRuntime.prototype, "run").mockImplementation(function (this: HarnessRuntime, input, options) {
      return originalRun.call(this, input, { ...options, modelClient: model });
    });
    const response = await POST(new Request("http://localhost/api/ai/harness/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      idempotencyKey: "python_api_" + crypto.randomUUID().replaceAll("-", ""), instruction: "添加 Python 单元，用 pandas 生成示例数据并运行", pageId: "page_home",
      appSpec: product.appSpec, recipes: [], notebookContext: { sourceIds: [], document: { name: "Python API", revision: 0, cells: [] } },
    }) }));
    expect(response.status).toBe(200);
    const { task } = await readHarnessStream(response, new AbortController().signal, () => {});
    expect(task.state, JSON.stringify({ error: task.error, events: task.events.filter((e) => e.type === "observation") })).toBe("awaitingConfirmation");
    expect(task.verification?.status).toBe("passed");
    expect(task.notebookArtifact).toMatchObject({ executionEvidence: { status: "success" }, cells: [{ kind: "python" }] });
    expect(task.events.flatMap((e) => e.type === "toolCall" ? [e.toolCall!.name] : [])).toEqual(calls.map(([name]) => name));
  }, 30_000);

  it("结构检索经 SSE 返回普通回答，文字 Notebook 无需计算或提交草稿", async () => {
    vi.stubEnv("HARNESS_MCP_ENABLED", "false");
    vi.stubEnv("HARNESS_MULTI_AGENT_MODE", "single");
    if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
    const product = structuredClone(demoFixtureResult.data.dataProduct);
    const model: HarnessModel = { next: async ({ iteration, context }) => {
      if (iteration === 2) expect(context.latestObservation).toMatchObject({ result: { totalCells: 1, matchedCount: 1, runStatus: "notRun" } });
      return { model: "scripted-api-search", usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
        turn: iteration === 1 ? { type: "callTool", name: "cellSearch", arguments: { query: "说明", view: "source" }, toolCallId: "api_search", message: "读取说明单元" }
          : { type: "complete", message: "这个说明单元只有文字，没有输入依赖，也没有运行结果。" } };
    } };
    const originalRun = HarnessRuntime.prototype.run;
    vi.spyOn(HarnessRuntime.prototype, "run").mockImplementation(function (this: HarnessRuntime, input, options) {
      return originalRun.call(this, input, { ...options, modelClient: model, notebookRunner: async () => { throw new Error("只读检索不应运行 Notebook"); } });
    });
    const response = await POST(new Request("http://localhost/api/ai/harness/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      idempotencyKey: "search_api_" + crypto.randomUUID().replaceAll("-", ""), instruction: "查看说明单元的内容和依赖，不要修改或运行",
      pageId: "page_home", appSpec: product.appSpec, recipes: [], notebookContext: { sourceIds: [], document: { name: "API 只读检索", revision: 0,
        cells: [{ id: "note", kind: "text", title: "说明", markdown: "尚未配置分析" }] } },
    }) }));
    expect(response.status).toBe(200);
    const events: HarnessTraceEvent[] = [];
    const { task } = await readHarnessStream(response, new AbortController().signal, (event) => events.push(event));
    expect(task.state, task.error).toBe("completed");
    expect(task.verification?.status).toBe("passed");
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.events.flatMap((event) => event.type === "toolCall" ? [event.toolCall!.name] : [])).toEqual(["cellSearch"]);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  });

  it("沿用服务端数据运行器和事件协议，真实 SQL 结果进入可审阅草稿", async () => {
    vi.stubEnv("HARNESS_MCP_ENABLED", "false");
    vi.stubEnv("HARNESS_MULTI_AGENT_MODE", "single");
    if (!demoFixtureResult.success) throw new Error("Fixture unavailable");
    const product = structuredClone(demoFixtureResult.data.dataProduct);
    const source = product.appSpec.dataSources.find((item) => item.id === "dataset_retail_orders")!;
    expect(source).toBeDefined();
    const calls: Array<[HarnessToolName, Record<string, unknown>]> = [["cellSearch", {}], ["editNotebookCells", { editVersion: 0, cells: [
      { id: "count", kind: "sql", title: "记录计数", inputCellIds: ["data"], outputName: "count_result", sql: "SELECT COUNT(*) AS records FROM input_data" },
      { id: "table", kind: "table", title: "计数结果", inputCellId: "count", columns: ["records"] },
    ] }], ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }]];
    let expectedCount = -1;
    let actualCount = -2;
    const model: HarnessModel = { next: async ({ iteration, context }) => {
      if (iteration === 4) {
        const observation = context.latestObservation as { result: { status: string; results: Array<{ rows: Array<{ records: number }> }> } };
        expect(observation.result.status).toBe("success");
        actualCount = observation.result.results[0].rows[0].records;
      }
      const [name, args] = calls[iteration - 1];
      return { model: "scripted-api-test", usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
        turn: { type: "callTool", name, arguments: args, toolCallId: `api_cell_${iteration}`, message: "检查单元执行" } };
    } };
    const originalRun = HarnessRuntime.prototype.run;
    vi.spyOn(HarnessRuntime.prototype, "run").mockImplementation(function (this: HarnessRuntime, input, options) {
      expectedCount = options.dataRuntime.rowsByDataSourceId[source.id].length;
      return originalRun.call(this, input, { ...options, modelClient: model });
    });
    const response = await POST(new Request("http://localhost/api/ai/harness/stream", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
      idempotencyKey: "cells_api_" + crypto.randomUUID().replaceAll("-", ""),
      instruction: "检查数据单元，添加 SQL 计数和结果表格单元", pageId: "page_home", dataSourceId: source.id,
      appSpec: product.appSpec, recipes: [], notebookContext: { sourceIds: [source.id], document: { name: "API 单元验收", revision: 4,
        cells: [{ id: "data", kind: "data", title: "示例数据", sourceDataSourceId: source.id, outputName: "input_data" }] } },
    }) }));
    expect(response.status).toBe(200);
    const events: HarnessTraceEvent[] = [];
    const { task } = await readHarnessStream(response, new AbortController().signal, (event) => events.push(event));
    expect(task.state, task.error).toBe("awaitingConfirmation");
    expect(actualCount).toBe(expectedCount);
    expect(actualCount).toBeGreaterThan(0);
    expect(task.verification?.status).toBe("passed");
    expect(task.notebookArtifact).toMatchObject({ baseRevision: 4, executionEvidence: { status: "success" } });
    expect(task.events.flatMap((event) => event.type === "toolCall" ? [event.toolCall!.name] : [])).toEqual(calls.map(([name]) => name));
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
  }, 20_000);
});
