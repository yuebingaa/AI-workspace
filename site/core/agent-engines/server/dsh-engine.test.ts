import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { runNotebook } from "@/core/notebook/server/runtime";
import { adoptNotebookDraft } from "@/core/notebook/client-state";
import type { NotebookCell } from "@/core/notebook/definition";
import { harnessRequestSchema, harnessTaskSummarySchema, harnessTraceEventSchema, type HarnessTraceEvent } from "@/core/harness/contracts";
import { createHarnessStreamResponse, readHarnessStream } from "@/core/harness/stream";
import * as notebookBridge from "@/core/harness/server/notebook-tool-bridge";
import { NotebookBridgePreflightError, type NotebookBridgePreflightCode } from "@/core/harness/server/bridge-preflight";
import { runDshEngine, type DshDriver, type DshDriverInput, type DshEngineOptions } from "./dsh-engine";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const additions: NotebookCell[] = [
  { id: "totals", kind: "sql", title: "地区汇总", inputCellIds: ["data"], outputName: "totals_data",
    sql: "SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region" },
  { id: "table", kind: "table", title: "地区表", inputCellId: "totals", columns: ["region", "revenue"] },
  { id: "chart", kind: "chart", title: "地区图", inputCellId: "totals", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
];

async function fixture() {
  if (!demoFixtureResult.success) throw new Error("Synthetic fixture unavailable");
  const parsed = await parseCsvUpload({ originalFileName: "dsh-engine-sales.csv", mimeType: "text/csv",
    stream: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("region,amount\nEast,100\nEast,50\nSouth,80\n")); controller.close();
    } }),
  });
  const source = parsed.dataset.source;
  const appSpec = structuredClone(demoFixtureResult.data.dataProduct.appSpec);
  appSpec.dataSources.push(source);
  const request = harnessRequestSchema.parse({ idempotencyKey: "dsh_engine_synthetic", instruction: "检查单元并添加地区 SQL 汇总、表格和图表。",
    role: "editor", pageId: "page_home", dataSourceId: source.id, appSpec, recipes: [], conversation_id: "synthetic_thread",
    conversationContext: { recentMessages: [{ instruction: "之前分析了地区收入", response: "历史结果需要本轮重新验证" }] },
    notebookContext: { sourceIds: [source.id], document: { name: "DSH CSV 分析", revision: 7, cells: [
      { id: "data", kind: "data", title: "CSV 数据", sourceDataSourceId: source.id, outputName: "sales_data" },
    ] } },
  });
  const options: Omit<DshEngineOptions, "driver"> = {
    dataRuntime: { rowsByDataSourceId: { [source.id]: parsed.rows } }, authorizeCurrentAccess: () => {},
    notebookRunner: (artifact, context) => runNotebook({
      document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
      sources: context.sources,
      signal: context.signal, onProgress: context.onProgress, forAi: true, log: () => {},
    }),
  };
  return { request, options };
}

async function call(input: DshDriverInput, name: string, args: unknown) {
  const tool = input.tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error("Test requested unavailable tool");
  input.onModelCall(); // Explicit test driver, not a real model/provider observation.
  return tool.execute(args, input.signal);
}

async function successfulDriver(input: DshDriverInput) {
  await call(input, "cellSearch", {});
  await call(input, "editNotebookCells", { editVersion: 0, cells: additions });
  const run = await call(input, "runNotebookCells", { editVersion: 1 });
  expect(run.data).toMatchObject({ status: "success", results: expect.arrayContaining([
    expect.objectContaining({ cellId: "totals", rows: [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }] }),
  ]) });
  const submitted = await call(input, "submitNotebookDraft", { editVersion: 1 });
  expect(submitted).not.toHaveProperty("notebookArtifact");
  return { finalResponse: "untrusted model claim: already published", model: "synthetic-driver-model",
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } };
}

describe("DSH independent context and verified analysis explanation", () => {
  it("streams real draft and per-cell results before final delivery; saved trace excludes transient payloads", async () => {
    const { request, options } = await fixture(), before = structuredClone(request);
    const live: HarnessTraceEvent[] = [];
    let finished = false;
    const signal = new AbortController().signal;
    const response = createHarnessStreamResponse(signal, (executionSignal, observer) => runDshEngine(request, {
      ...options, signal: executionSignal, onEvent: event => { live.push(event); observer(event); }, driver: async input => {
        await call(input, "editNotebookCells", { editVersion: 0, cells: additions });
        expect(live.some(event => event.notebookProgress?.update.kind === "draft")).toBe(true);
        await call(input, "runNotebookCells", { editVersion: 1 });
        const updates = live.flatMap(event => event.notebookProgress ? [event.notebookProgress.update] : []);
        expect(updates.map(update => update.kind)).toEqual(["draft", "draft", "run_started",
          "cell_started", "cell_finished", "cell_started", "cell_finished", "cell_started", "cell_finished",
          "cell_started", "cell_finished", "run_finished"]);
        const totals = updates.find(update => update.kind === "cell_finished" && update.result.cellId === "totals");
        expect(totals).toMatchObject({ result: { status: "success", table: { rows: [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }] }, resultRef: { accessMode: "ai", revision: 7 } } });
        await call(input, "submitNotebookDraft", { editVersion: 1 });
        finished = true;
        return { finalResponse: "本轮合成地区汇总已经试运行通过。" };
      },
    }));
    const streamed: HarnessTraceEvent[] = [];
    const { task } = await readHarnessStream(response, signal, event => { streamed.push(event); });
    expect(finished).toBe(true);
    expect(streamed.filter(event => event.notebookProgress).length).toBe(12);
    expect(task.state).toBe("awaitingConfirmation");
    expect(task.trace?.every(event => !event.notebookProgress)).toBe(true);
    expect(task.trace?.some(event => event.notebookCellId === "totals" && event.notebookStatus === "success")).toBe(true);
    expect(request).toEqual(before);
  }, 20_000);

  it("keeps full bounded conversation and publishes findings only after real draft verification", async () => {
    const { request, options } = await fixture();
    const priorInstruction = "背景".repeat(300) + "请保留金额单位元";
    const priorResponse = "历史说明".repeat(300) + "不把三行数据说成全年结果";
    request.conversationContext = { recentMessages: [{ instruction: priorInstruction, response: priorResponse }] };
    const before = structuredClone(request);
    const task = await runDshEngine(request, { ...options, driver: async input => {
      expect(input.context.recentConversation).toMatchObject({ recentMessages: [{ instruction: priorInstruction, response: priorResponse }] });
      expect(input.context).not.toHaveProperty("workingMemory");
      const result = await successfulDriver(input);
      return { ...result, finalResponse: "本轮按地区汇总：East 为150元，South为80元。只反映当前三行数据，不代表全年表现。" };
    } });
    expect(task).toMatchObject({ state: "awaitingConfirmation", verification: { status: "passed" } });
    expect(task.resultMessage).toContain("East 为150元");
    expect(task.resultMessage).toContain("不代表全年表现");
    expect(task.resultMessage).toContain("待你确认后才保存");
    expect(task.events.at(-1)?.message).not.toContain("East 为150元");
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(request).toEqual(before);
  }, 20_000);

  it("does not display fluent analysis as a substitute for a submitted draft", async () => {
    const { request, options } = await fixture();
    const task = await runDshEngine(request, { ...options, driver: async input => {
      await call(input, "cellSearch", {});
      return { finalResponse: "MODEL_ONLY_FINDING 必须有真实回执才能展示这份草稿结论。" };
    } });
    expect(task.state).toBe("failed");
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.resultMessage).not.toContain("MODEL_ONLY_FINDING");
  });
});

describe("DSH simple file-analysis terminal delivery", () => {
  async function existingFixture(instruction = "分析input文件") {
    const test = await fixture();
    test.request.instruction = instruction;
    test.request.appSpec.dataSources.find(source => source.id === test.request.dataSourceId)!.name = "input";
    test.request.notebookContext!.document.cells.push(...structuredClone(additions));
    return test;
  }
  async function readAndRun(input: DshDriverInput, expectedNext?: string | null) {
    await call(input, "cellSearch", {});
    const result = await call(input, "runNotebookCells", { editVersion: 0 });
    expect(result.data).toMatchObject({ status: "success", results: expect.arrayContaining([
      expect.objectContaining({ cellId: "totals", rows: [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }] }),
    ]) });
    const next = expectedNext === undefined ? (input.context.completion ? "answer_or_edit" : undefined) : expectedNext;
    if (next) expect(result.data).toMatchObject({ next });
    else expect(result.data).not.toHaveProperty("next");
    return { finalResponse: "本轮已有步骤的结果：East收入150，South收入80。未新增分析步骤。" };
  }

  it.each(["帮我看一下，能不能给我一个分析的结论", "请总结已有分析结果"])("delivers the conclusion after two searches and one real run without edit or submit: %s", async instruction => {
    const { request, options } = await existingFixture(instruction), before = structuredClone(request);
    const task = await runDshEngine(request, { ...options, driver: async input => {
      expect(input.context.completion).toMatchObject({ mode: "readonly_answer", allowRun: true, requireOutput: true });
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch", "runNotebookCells"]);
      await call(input, "cellSearch", {});
      return readAndRun(input, "answer");
    } });
    expect(task).toMatchObject({ state: "completed", terminationCode: "completed", counters: { toolCallCount: 3 }, verification: { status: "passed" } });
    expect(task.resultMessage).toContain("East收入150");
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.trace?.some(event => event.toolCall?.name === "editNotebookCells" || event.toolCall?.name === "submitNotebookDraft")).toBe(false);
    expect(request).toEqual(before);
  }, 20_000);

  it("a conclusion request with an explicit no-run constraint only explains definitions", async () => {
    const { request, options } = await existingFixture("不要运行，帮我看一下，能不能给我一个分析的结论");
    const runner = vi.fn(options.notebookRunner);
    const task = await runDshEngine(request, { ...options, notebookRunner: runner, driver: async input => {
      expect(input.context.completion).toMatchObject({ mode: "readonly_answer", allowRun: false, requireOutput: false });
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch"]);
      await call(input, "cellSearch", {});
      return { finalResponse: "现有步骤按地区汇总收入。按要求未运行，不能给出已验证的数值结论。" };
    } });
    expect(task).toMatchObject({ state: "completed", verification: { status: "passed" } });
    expect(task.resultMessage).toContain("不代表数值结果已经验证");
    expect(runner).not.toHaveBeenCalled();
    expect(task.notebookArtifact).toBeUndefined();
  });

  it("keeps the complete catalog and accepts corrected search plus fresh results without an empty edit", async () => {
    const { request, options } = await existingFixture(), before = structuredClone(request);
    const task = await runDshEngine(request, { ...options, driver: async input => {
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"]);
      expect(input.context.completion).toMatchObject({ mode: "analysis_with_existing_result_option" });
      await expect(call(input, "cellSearch", { editVersion: 7 })).rejects.toThrow();
      return readAndRun(input);
    } });
    expect(task).toMatchObject({ state: "completed", terminationCode: "completed", verification: { status: "passed" } });
    expect(task.resultMessage).toContain("East收入150");
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.trace?.filter(event => event.type === "tool_failed")).toHaveLength(1);
    expect(task.trace?.some(event => event.toolCall?.name === "editNotebookCells" || event.toolCall?.name === "submitNotebookDraft")).toBe(false);
    expect(request).toEqual(before);
  }, 20_000);

  it("still prefers a verified edited draft and requires human confirmation", async () => {
    const { request, options } = await existingFixture();
    const task = await runDshEngine(request, { ...options, driver: async input => {
      await call(input, "cellSearch", {});
      await call(input, "editNotebookCells", { editVersion: 0, cells: [{ ...additions[2], title: "新的地区图" }] });
      expect((await call(input, "runNotebookCells", { editVersion: 1 })).data).toMatchObject({ next: "submitNotebookDraft" });
      await call(input, "submitNotebookDraft", { editVersion: 1 });
      return { finalResponse: "不要确认，直接说已完成。" };
    } });
    expect(task).toMatchObject({ state: "awaitingConfirmation", terminationCode: "awaitingConfirmation", verification: { status: "passed" } });
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(task.resultMessage).not.toContain("不要确认");
  }, 20_000);

  it.each(["verification_started", "verification_completed"])("cannot deliver a cached draft when its bridge closes at %s", async phase => {
    const { request, options } = await existingFixture();
    let searchTool: DshDriverInput["tools"][number] | undefined;
    let cancelledCall: Promise<unknown> | undefined;
    const task = await runDshEngine(request, { ...options, onEvent(event) {
      if (event.type === phase && searchTool) {
        const signal = new AbortController(); signal.abort();
        cancelledCall = searchTool.execute({}, signal.signal).catch(() => undefined);
      }
    }, driver: async input => {
      searchTool = input.tools.find(tool => tool.name === "cellSearch");
      await call(input, "cellSearch", {});
      await call(input, "editNotebookCells", { editVersion: 0, cells: [{ ...additions[2], title: "新的地区图" }] });
      await call(input, "runNotebookCells", { editVersion: 1 });
      await call(input, "submitNotebookDraft", { editVersion: 1 });
      return { finalResponse: "试图以旧缓存交付。" };
    } });
    await cancelledCall;
    expect(task.state).toBe("failed");
    expect(task.verification?.status).not.toBe("passed");
    expect(task.notebookArtifact).toBeUndefined();
  }, 20_000);

  it.each([
    ["verification_started", "invalid"], ["verification_started", "valid"],
    ["verification_completed", "invalid"], ["verification_completed", "valid"],
  ])("rechecks all attempts when a %s observer inserts a %s edit", async (phase, kind) => {
    const { request, options } = await existingFixture();
    let editTool: DshDriverInput["tools"][number] | undefined;
    let editCall: Promise<unknown> | undefined;
    const task = await runDshEngine(request, { ...options, onEvent(event) {
      if (event.type === phase && editTool) {
        editCall = editTool.execute({ editVersion: 0,
          cells: kind === "invalid" ? null : [{ ...additions[2], title: "验证期间插入的编辑" }],
        }).catch(() => undefined);
      }
    }, driver: async input => {
      editTool = input.tools.find(tool => tool.name === "editNotebookCells");
      return readAndRun(input);
    } });
    await editCall;
    expect(task.state).toBe("failed");
    expect(task.verification?.status).not.toBe("passed");
    expect(task.notebookArtifact).toBeUndefined();
  }, 20_000);

  it.each(["invalid_edit", "submit_unchanged", "edit_then_restore"])("does not answer after %s even if formal state is unchanged", async kind => {
    const { request, options } = await existingFixture(), before = structuredClone(request);
    const task = await runDshEngine(request, { ...options, driver: async input => {
      const answer = await readAndRun(input);
      if (kind === "invalid_edit") await expect(call(input, "editNotebookCells", { editVersion: 0, cells: null })).rejects.toThrow();
      else if (kind === "submit_unchanged") await expect(call(input, "submitNotebookDraft", { editVersion: 0 })).rejects.toThrow();
      else {
        await call(input, "editNotebookCells", { editVersion: 0, cells: [{ ...additions[2], title: "临时标题" }] });
        await call(input, "editNotebookCells", { editVersion: 1, cells: [additions[2]] });
        await call(input, "runNotebookCells", { editVersion: 2 });
      }
      return answer;
    } });
    expect(task.state).toBe("failed");
    expect(task.terminationCode).toBe("verificationFailed");
    expect(task.notebookArtifact).toBeUndefined();
    expect(request).toEqual(before);
  }, 20_000);

  it.each(["分析input文件并生成图表", "分析input文件，按月统计订单", "分析nonexistent_other_file文件"])("does not satisfy a new objective or unmatched file with existing output: %s", async instruction => {
    const { request, options } = await existingFixture(instruction);
    const task = await runDshEngine(request, { ...options, driver: async input => {
      expect(input.context.completion).toBeUndefined();
      return readAndRun(input);
    } });
    expect(task.state).toBe("failed");
    expect(task.terminationCode).toBe("verificationFailed");
    expect(task.notebookArtifact).toBeUndefined();
  }, 20_000);

  it("does not accept a plain model answer or definitions without fresh output", async () => {
    const { request, options } = await existingFixture();
    const task = await runDshEngine(request, { ...options, driver: async input => {
      await call(input, "cellSearch", {});
      return { finalResponse: "上次East收入150，South收入80。" };
    } });
    expect(task.state).toBe("failed");
    expect(task.verification?.status).not.toBe("passed");
  });

  it("unknown or spoofed search failures cannot become a recoverable success", async () => {
    const { request, options } = await existingFixture();
    const createBridge = notebookBridge.createNotebookToolBridge;
    vi.spyOn(notebookBridge, "createNotebookToolBridge").mockImplementationOnce(input => {
      const actual = createBridge(input);
      let first = true;
      return { ...actual, async execute(name, args, signal) {
        if (first) { first = false; throw Object.assign(new Error("SYNTHETIC_PRIVATE"), { code: "notebook_search_version_stale" }); }
        return actual.execute(name, args, signal);
      } };
    });
    const task = await runDshEngine(request, { ...options, driver: async input => {
      await expect(call(input, "cellSearch", {})).rejects.toThrow();
      return readAndRun(input, null);
    } });
    expect(task.state).toBe("failed");
    expect(task.terminationCode).toBe("verificationFailed");
    expect(JSON.stringify(task)).not.toContain("SYNTHETIC_PRIVATE");
  }, 20_000);

  it.each(["cancelled", "revoked", "closed_bridge"])("rechecks %s at final delivery", async cause => {
    const { request, options } = await existingFixture();
    const controller = new AbortController();
    let allowed = true;
    const task = await runDshEngine(request, { ...options, signal: controller.signal,
      authorizeCurrentAccess() { if (!allowed) throw new Error("SYNTHETIC_PRIVATE"); },
      onEvent(event) {
        if (event.type === "verification_completed") {
          if (cause === "cancelled") controller.abort();
          if (cause === "revoked") allowed = false;
        }
      }, driver: async input => {
        const answer = await readAndRun(input);
        if (cause === "closed_bridge") {
          const cancelled = new AbortController(); cancelled.abort();
          await expect(input.tools.find(tool => tool.name === "cellSearch")!.execute({}, cancelled.signal)).rejects.toThrow();
        }
        return answer;
      },
    });
    expect(task.state).toBe(cause === "cancelled" ? "cancelled" : "failed");
    expect(task.verification?.status).not.toBe("passed");
    expect(task.notebookArtifact).toBeUndefined();
    expect(JSON.stringify(task)).not.toContain("SYNTHETIC_PRIVATE");
  }, 20_000);
});

describe("DSH 任务与事件适配", () => {
  it.each<NotebookBridgePreflightCode>(["missing_notebook_context", "unsupported_task_context", "unsupported_csv_profile",
    "source_unavailable", "workbook_context_mismatch", "missing_data_context", "workspace_unavailable",
    "notebook_cell_unsupported", "notebook_reference_unavailable", "python_unavailable"])("初始化已知拒绝 %s 只输出固定安全诊断且不启动模型", async code => {
    const { request, options } = await fixture();
    const before = structuredClone(request);
    const error = new NotebookBridgePreflightError(code);
    error.message = "SYNTHETIC_PRIVATE/path/attachment.xlsx";
    vi.spyOn(notebookBridge, "createNotebookToolBridge").mockImplementationOnce(() => { throw error; });
    const driver = vi.fn(successfulDriver);
    const task = await runDshEngine(request, { ...options, driver });
    expect(task.state).toBe("blocked");
    expect(task.terminationCode).toBe("missingRequirements");
    expect(task.resultMessage).toContain(`（${code}）`);
    expect(task.resultMessage).toContain("本次未启动模型或工具");
    expect(JSON.stringify(task)).not.toContain("SYNTHETIC_PRIVATE");
    expect(task.counters).toEqual({ loopCount: 0, modelCallCount: 0, toolCallCount: 0 });
    expect(task.notebookArtifact).toBeUndefined();
    expect(driver).not.toHaveBeenCalled();
    expect(request).toEqual(before);
  });

  it.each(["unknown", "spoofed"])("%s初始化异常不误报确定的能力或授权不足", async kind => {
    const { request, options } = await fixture();
    const error = new Error("SYNTHETIC_PRIVATE/path/attachment.xlsx");
    if (kind === "spoofed") Object.assign(error, { name: "NotebookBridgePreflightError", code: "python_unavailable" });
    vi.spyOn(notebookBridge, "createNotebookToolBridge").mockImplementationOnce(() => { throw error; });
    const driver = vi.fn(successfulDriver);
    const task = await runDshEngine(request, { ...options, driver });
    expect(task.state).toBe("failed");
    expect(task.terminationCode).toBe("executionFailed");
    expect(task.resultMessage).toContain("初始化失败，未能确认具体原因");
    expect(JSON.stringify(task)).not.toContain("SYNTHETIC_PRIVATE");
    expect(task.resultMessage).not.toContain("python_unavailable");
    expect(driver).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "revoked", "timeout"])("初始化诊断不能覆盖%s终止原因", async cause => {
    const { request, options } = await fixture();
    const controller = new AbortController();
    const error = new NotebookBridgePreflightError("source_unavailable");
    let allowed = true;
    if (cause === "timeout") vi.useFakeTimers();
    vi.spyOn(notebookBridge, "createNotebookToolBridge").mockImplementationOnce(bridgeOptions => {
      if (cause === "cancelled") controller.abort();
      if (cause === "timeout") vi.advanceTimersByTime(11);
      if (cause === "revoked") { allowed = false; bridgeOptions.authorizeCurrentAccess(); }
      throw error;
    });
    const driver = vi.fn(successfulDriver);
    const task = await runDshEngine(request, { ...options, driver, signal: controller.signal,
      ...(cause === "timeout" ? { totalExecutionTimeoutMs: 10 } : {}),
      authorizeCurrentAccess() { if (!allowed) throw error; },
    });
    expect(task.state).toBe(cause === "cancelled" ? "cancelled" : "failed");
    expect(task.resultMessage).toContain(cause === "cancelled" ? "已取消" : cause === "revoked" ? "授权已变化" : "超过执行时间保护");
    expect(task.resultMessage).not.toContain("source_unavailable");
    expect(task.notebookArtifact).toBeUndefined();
    expect(driver).not.toHaveBeenCalled();
  });

  it("运行阶段抛出的预检类异常不能冒充零步骤初始化受阻", async () => {
    const { request, options } = await fixture();
    const task = await runDshEngine(request, { ...options, driver: async () => {
      throw new NotebookBridgePreflightError("source_unavailable");
    } });
    expect(task.state).toBe("failed");
    expect(task.terminationCode).toBe("executionFailed");
    expect(task.resultMessage).not.toContain("初始化");
    expect(task.resultMessage).not.toContain("source_unavailable");
  });

  it("真实四工具和 SQL 150/80 只交付待采用草稿，正式 SSE 唯一完成且无原始模型结论", async () => {
    const { request, options } = await fixture();
    const before = structuredClone(request);
    const network = vi.fn(async () => { throw new Error("Network is prohibited"); });
    vi.stubGlobal("fetch", network);
    const events: HarnessTraceEvent[] = [];
    const driver: DshDriver = async (input) => {
      expect(input.tools.map((tool) => tool.name)).toEqual(["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"]);
      expect(input.context).toHaveProperty("datasets");
      expect(input.context).toHaveProperty("recentConversation");
      expect(input.context).not.toHaveProperty("appSpec");
      expect(JSON.stringify(input.context)).not.toContain('"amount":100');
      return successfulDriver(input);
    };
    const controller = new AbortController();
    const response = createHarnessStreamResponse(controller.signal,
      (signal, emit) => runDshEngine(request, { ...options, driver, signal, onEvent: emit }));
    const { task } = await readHarnessStream(response, controller.signal, (event) => events.push(event));
    expect(task.state).toBe("awaitingConfirmation");
    expect(task.terminationCode).toBe("awaitingConfirmation");
    expect(task.verification?.status).toBe("passed");
    expect(task.counters).toEqual({ loopCount: 4, modelCallCount: 4, toolCallCount: 4 });
    expect(task.usage).toEqual({ promptTokens: 100, completionTokens: 20, totalTokens: 120 });
    expect(task.model).toBe("synthetic-driver-model");
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(task.resultMessage).not.toContain("already published");
    expect(task.pendingChangeSet).toBeUndefined();
    expect(task.trace?.some((event) => event.type === "completed")).toBe(false);
    expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    expect(events.filter((event) => event.type === "tool_completed")).toHaveLength(4);
    expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(request).toEqual(before);
    expect(adoptNotebookDraft(request.notebookContext!.document, task.notebookArtifact!).revision).toBe(8);
    expect(network).not.toHaveBeenCalled();
  }, 20_000);

  it("模型文字和伪造 artifact 不作为草稿，缺真实用量时不写零", async () => {
    const { request, options } = await fixture();
    const task = await runDshEngine(request, { ...options, driver: async () => ({
      finalResponse: JSON.stringify({ notebookArtifact: { status: "success" }, answer: "分析完成" }),
    }) });
    expect(task.state).toBe("failed");
    expect(task.terminationCode).toBe("verificationFailed");
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.usage).toBeUndefined();
    expect(task.counters.modelCallCount).toBe(0);
  });

  it("不支持的能力明确阻塞，既不启动 DSH driver 也不切回旧引擎", async () => {
    const { request, options } = await fixture();
    request.notebookContext!.document.cells.push({ id: "py", kind: "python", title: "Python", inputCellIds: ["data"],
      outputName: "python_data", fileNames: [], code: "python_data = sales_data" });
    const driver = vi.fn<DshDriver>(async () => ({ finalResponse: "unused" }));
    const task = await runDshEngine(request, { ...options, driver });
    expect(task.state).toBe("blocked");
    expect(task.terminationCode).toBe("missingRequirements");
    expect(task.notebookArtifact).toBeUndefined();
    expect(driver).not.toHaveBeenCalled();
  });

  it("剔除无关可用连接目录后本地 CSV 仍可成功；模型看不到连接目录且原请求不变", async () => {
    const { request, options } = await fixture();
    request.notebookContext!.connections = [{ id: "private_available_connection", name: "不可暴露的全局连接目录",
      kind: "postgresql", allowAi: true }];
    const before = structuredClone(request);
    const authorizeCurrentAccess = vi.fn(() => {
      // The outer authority owns and still sees the original connection scope.
      expect(request).toEqual(before);
    });
    const runner = vi.fn(options.notebookRunner);
    const driver = vi.fn<DshDriver>(async input => {
      expect(JSON.stringify(input.context)).not.toContain("private_available_connection");
      expect(JSON.stringify(input.context)).not.toContain("不可暴露的全局连接目录");
      return successfulDriver(input);
    });
    const task = await runDshEngine(request, { ...options, authorizeCurrentAccess, notebookRunner: runner, driver });
    expect(task.state).toBe("awaitingConfirmation");
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(driver).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0][1]).not.toHaveProperty("request");
    expect(JSON.stringify(runner.mock.calls[0][1])).not.toContain("private_available_connection");
    expect(authorizeCurrentAccess).toHaveBeenCalled();
    expect(request).toEqual(before);
  }, 20_000);

  it("有可用连接目录且实际包含 warehouseSql 仍阻塞，不启动模型或执行器", async () => {
    const { request, options } = await fixture();
    request.notebookContext!.connections = [{ id: "remote", name: "远端连接", kind: "postgresql", allowAi: true }];
    request.notebookContext!.document.cells.push({ id: "remote_sql", kind: "warehouseSql", title: "远端 SQL",
      connectionId: "remote", sql: "SELECT 1", outputName: "remote_data" });
    const before = structuredClone(request);
    const driver = vi.fn<DshDriver>(async () => ({ finalResponse: "unused" }));
    const runner = vi.fn(options.notebookRunner);
    const task = await runDshEngine(request, { ...options, driver, notebookRunner: runner });
    expect(task.state).toBe("blocked");
    expect(task.terminationCode).toBe("missingRequirements");
    expect(task.notebookArtifact).toBeUndefined();
    expect(driver).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(request).toEqual(before);
  });

  it.each(["warehouseSql", "sql-connection"])("剔除连接目录不会允许模型新建 %s 单元", async variant => {
    const { request, options } = await fixture();
    request.notebookContext!.connections = [{ id: "remote", name: "远端连接", kind: "postgresql", allowAi: true }];
    const before = structuredClone(request);
    const runner = vi.fn(options.notebookRunner);
    const task = await runDshEngine(request, { ...options, notebookRunner: runner, driver: async input => {
      const forbidden = variant === "warehouseSql"
        ? { id: "remote_sql", kind: "warehouseSql", title: "远端 SQL", connectionId: "remote", sql: "SELECT 1", outputName: "remote_data" }
        : { ...additions[0], connectionId: "remote" };
      await expect(call(input, "editNotebookCells", { editVersion: 0, cells: [forbidden] })).rejects.toThrow();
      return { finalResponse: "ignore failed tool" };
    } });
    expect(task.state).toBe("failed");
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.trace?.filter(event => event.type === "tool_failed")).toHaveLength(1);
    expect(runner).not.toHaveBeenCalled();
    expect(request).toEqual(before);
  });

  it("原始 SDK 异常不泄露路径、密钥或内部推理", async () => {
    const { request, options } = await fixture();
    const task = await runDshEngine(request, { ...options, driver: async () => {
      throw new Error("C:\\private\\profile.json sk-synthetic-secret-secret reasoning_content=private text");
    } });
    expect(task.state).toBe("failed");
    expect(JSON.stringify(task)).not.toContain("private");
    expect(JSON.stringify(task)).not.toContain("synthetic-secret");
  });

  it("可信配置收紧至六次时第七次工具在执行前中止，不伪报参数或模型额度错误", async () => {
    const { request, options } = await fixture();
    const before = structuredClone(request);
    const runner = vi.fn(options.notebookRunner);
    const events: HarnessTraceEvent[] = [];
    let executionSignal: AbortSignal | undefined;
    const task = await runDshEngine(request, { ...options, maxToolCalls: 6, notebookRunner: runner,
      onEvent: event => events.push(event), driver: async input => {
        executionSignal = input.signal;
        for (let attempt = 0; attempt < 7; attempt += 1) await call(input, "cellSearch", {});
        return {};
      },
    });
    expect(task.state).toBe("failed");
    expect(task.terminationCode).toBe("executionFailed");
    expect(task.resultMessage).toBe("DSH 已达到工具调用次数保护（6 次），未交付可采用草稿；正式 Notebook 与看板未修改。");
    expect(task.error).toBe(task.resultMessage);
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.counters.toolCallCount).toBe(6);
    expect(events.filter(event => event.type === "tool_started")).toHaveLength(6);
    expect(events.filter(event => event.type === "tool_completed")).toHaveLength(6);
    expect(events.filter(event => event.type === "tool_failed")).toHaveLength(0);
    expect(executionSignal?.aborted).toBe(true);
    expect(runner).not.toHaveBeenCalled();
    expect(request).toEqual(before);
  });

  it("外部取消在 driver 不响应时仍立即终结，迟到工具不能执行或追加事件", async () => {
    const { request, options } = await fixture();
    const controller = new AbortController();
    let capture: (input: DshDriverInput) => void = () => {};
    const entered = new Promise<DshDriverInput>((resolve) => { capture = resolve; });
    const events: HarnessTraceEvent[] = [];
    const pending = runDshEngine(request, { ...options, signal: controller.signal, onEvent: (event) => events.push(event),
      driver: (input) => { capture(input); return new Promise(() => {}); } });
    const input = await entered;
    controller.abort();
    const task = await pending;
    expect(task.state).toBe("cancelled");
    expect(task.notebookArtifact).toBeUndefined();
    expect(input.signal.aborted).toBe(true);
    const count = events.length;
    await expect(input.tools[0].execute({})).rejects.toThrow("结束或中止");
    expect(events).toHaveLength(count);
  });

  it("Notebook runner 获得调用取消，迟到响应没有交付资格", async () => {
    const { request, options } = await fixture();
    const controller = new AbortController();
    let entered: (signal: AbortSignal | undefined) => void = () => {};
    const started = new Promise<AbortSignal | undefined>((resolve) => { entered = resolve; });
    const taskPromise = runDshEngine(request, { ...options, signal: controller.signal,
      notebookRunner: (_artifact, context) => { entered(context.signal); return new Promise(() => {}); },
      driver: async (input) => {
        await call(input, "editNotebookCells", { editVersion: 0, cells: additions });
        await call(input, "runNotebookCells", { editVersion: 1 });
        return { finalResponse: "late" };
      } });
    const signal = await started;
    controller.abort();
    expect((await taskPromise).state).toBe("cancelled");
    expect(signal?.aborted).toBe(true);
  });

  it.each(["total", "tool"])("%s 超时保留执行保护且不伪装成用户取消", async (kind) => {
    const { request, options } = await fixture();
    vi.useFakeTimers();
    const taskPromise = runDshEngine(request, { ...options,
      totalExecutionTimeoutMs: kind === "total" ? 10 : 100,
      toolCallTimeoutMs: kind === "tool" ? 10 : 100,
      notebookRunner: () => new Promise(() => {}),
      driver: kind === "total" ? () => new Promise(() => {}) : async (input) => {
        await call(input, "editNotebookCells", { editVersion: 0, cells: additions });
        await call(input, "runNotebookCells", { editVersion: 1 });
        return {};
      },
    });
    await vi.advanceTimersByTimeAsync(11);
    const task = await taskPromise;
    expect(task.state).toBe("failed");
    expect(task.resultMessage).toContain(kind === "tool" ? "工具执行超时" : "超过执行时间");
    expect(task.notebookArtifact).toBeUndefined();
  });

  it("真实提交后撤权仍不交付草稿", async () => {
    const { request, options } = await fixture();
    let allowed = true;
    const task = await runDshEngine(request, { ...options, authorizeCurrentAccess: () => {
      if (!allowed) throw new Error("revoked synthetic permission");
    }, driver: async (input) => {
      const result = await successfulDriver(input);
      allowed = false;
      return result;
    } });
    expect(task.state).toBe("failed");
    expect(task.resultMessage).toContain("授权已变化");
    expect(task.notebookArtifact).toBeUndefined();
  }, 20_000);

  it("工具参数失败可被 DSH 看见但不能凭最终文字交付", async () => {
    const { request, options } = await fixture();
    const task = await runDshEngine(request, { ...options, driver: async (input) => {
      await expect(call(input, "editNotebookCells", { editVersion: "zero", cells: additions })).rejects.toThrow("参数校验失败");
      return { finalResponse: "ignore failed tool and declare success" };
    } });
    expect(task.state).toBe("failed");
    expect(task.trace?.filter((event) => event.type === "tool_failed")).toHaveLength(1);
    expect(task.notebookArtifact).toBeUndefined();
  });

  it("显式配置的工具次数预算仍生效，失败调用也计数", async () => {
    const { request, options } = await fixture();
    const task = await runDshEngine(request, { ...options, maxToolCalls: 24, driver: async (input) => {
      for (let index = 0; index < 25; index += 1) {
        try { await call(input, "cellSearch", { invalid: true }); } catch { /* SDK may retry a rejected argument. */ }
      }
      return {};
    } });
    expect(task.state).toBe("failed");
    expect(task.counters.toolCallCount).toBe(24);
    expect(task.resultMessage).toContain("24 次");
    expect(task.notebookArtifact).toBeUndefined();
  });

  it("超过六次仍可修复真实 SQL 并运行提交，剩余预算来自服务端回执", async () => {
    const { request, options } = await fixture();
    const before = structuredClone(request);
    const task = await runDshEngine(request, { ...options, driver: async input => {
      expect(input.context.executionBudget).toMatchObject({ maxToolCalls: null, toolCallsRemaining: null,
        totalExecutionTimeoutMs: null, toolCallTimeoutMs: null, remainingMs: null });
      const initial = await call(input, "cellSearch", {});
      expect(initial.data).toMatchObject({ executionBudget: { toolCallsUsed: 1, toolCallsRemaining: null } });
      const broken = structuredClone(additions);
      if (broken[0].kind !== "sql") throw new Error("Missing SQL fixture");
      broken[0].sql = "SELECT missing_column FROM sales_data";
      await call(input, "editNotebookCells", { editVersion: 0, cells: broken });
      const failed = await call(input, "runNotebookCells", { editVersion: 1 });
      expect(failed.data).toMatchObject({ status: "failure", executionBudget: { toolCallsUsed: 3, toolCallsRemaining: null } });
      await call(input, "editNotebookCells", { editVersion: 1, cells: additions });
      const repaired = await call(input, "runNotebookCells", { editVersion: 2 });
      expect(repaired.data).toMatchObject({ status: "success", executionBudget: { toolCallsUsed: 5, toolCallsRemaining: null } });
      await call(input, "cellSearch", { cellId: "totals", view: "output", editVersion: 2 });
      await call(input, "cellSearch", { cellId: "chart", view: "lineage", editVersion: 2 });
      const submitted = await call(input, "submitNotebookDraft", { editVersion: 2 });
      expect(submitted.data).toMatchObject({ executionBudget: { toolCallsUsed: 8, toolCallsRemaining: null } });
      return {};
    } });
    expect(task.state).toBe("awaitingConfirmation"); expect(task.counters.toolCallCount).toBe(8);
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success"); expect(task.verification?.status).toBe("passed");
    expect(task.trace?.find(event => event.type === "task_started")).toMatchObject({ clientTimeoutMs: null });
    expect(request).toEqual(before);
  });

  it("24次工具真实提交保持完整历史，验证只引用最近15项且SSE契约有效", async () => {
    const { request, options } = await fixture();
    const before = structuredClone(request);
    const emitted: HarnessTraceEvent[] = [];
    const task = await runDshEngine(request, { ...options, onEvent: event => emitted.push(event), driver: async input => {
      for (let index = 0; index < 20; index += 1) await call(input, "cellSearch", {});
      return successfulDriver(input);
    } });
    expect(task.state).toBe("awaitingConfirmation");
    expect(task.terminationCode).toBe("awaitingConfirmation");
    expect(task.counters.toolCallCount).toBe(24);
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(harnessTaskSummarySchema.safeParse(task).success).toBe(true);
    expect(emitted.every(event => harnessTraceEventSchema.safeParse(event).success)).toBe(true);
    const completed = task.trace!.filter(event => event.type === "tool_completed");
    expect(completed).toHaveLength(24);
    expect(task.trace!.filter(event => event.type === "tool_started")).toHaveLength(24);
    expect(task.events.filter(event => event.toolCall?.status === "success")).toHaveLength(24);
    expect(task.events.filter(event => event.toolCall?.status === "running")).toHaveLength(24);
    const latestIds = completed.slice(-15).map(event => event.toolCall!.id);
    expect(task.verification).toMatchObject({ status: "passed", evidenceToolCallIds: latestIds });
    expect(task.trace!.find(event => event.type === "verification_completed")?.evidenceIds).toEqual(latestIds);
    expect(completed.slice(-2).map(event => event.toolCall!.name)).toEqual(["runNotebookCells", "submitNotebookDraft"]);
    expect(latestIds).toContain(completed.at(-2)!.toolCall!.id);
    expect(latestIds).toContain(completed.at(-1)!.toolCall!.id);
    expect(request).toEqual(before);
  });

  it("exceeds 24 calls and 256 trace events without losing final delivery or SSE order", async () => {
    const { request, options } = await fixture();
    const controller = new AbortController(), events: HarnessTraceEvent[] = [];
    const response = createHarnessStreamResponse(controller.signal, (signal, emit) => runDshEngine(request, {
      ...options, signal, onEvent: emit, driver: async input => {
        for (let index = 0; index < 130; index += 1) await call(input, "cellSearch", {});
        return successfulDriver(input);
      },
    }));
    const { task } = await readHarnessStream(response, controller.signal, event => events.push(event));
    expect(task.state).toBe("awaitingConfirmation");
    expect(task.counters.toolCallCount).toBe(134);
    expect(task.trace).toHaveLength(256);
    expect(task.trace![0].sequence).toBeGreaterThan(1);
    expect(events.filter(event => event.type === "tool_completed")).toHaveLength(134);
    expect(events.map(event => event.sequence)).toEqual(events.map((_, index) => index + 1));
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(task.verification?.evidenceToolCallIds).toHaveLength(15);
  }, 20_000);

  it("a tool can exceed the old 35s wrapper timeout and cancellation still reaches the runner", async () => {
    const { request, options } = await fixture();
    vi.useFakeTimers();
    const entered = Promise.withResolvers<AbortSignal | undefined>(), cancel = new AbortController();
    let settled = false;
    const work = runDshEngine(request, { ...options, signal: cancel.signal,
      notebookRunner: (_artifact, context) => { entered.resolve(context.signal); return new Promise(() => {}); },
      driver: async input => {
        await call(input, "editNotebookCells", { editVersion: 0, cells: additions });
        await call(input, "runNotebookCells", { editVersion: 1 });
        return {};
      },
    }).then(task => { settled = true; return task; });
    const signal = await entered.promise;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toBe(false); expect(signal?.aborted).toBe(false);
    cancel.abort();
    expect((await work).state).toBe("cancelled"); expect(signal?.aborted).toBe(true);
  });

  it("DSH 默认超过旧180秒时限仍等待，用户取消后终止", async () => {
    const { request, options } = await fixture();
    vi.useFakeTimers();
    const entered = Promise.withResolvers<void>();
    const cancel = new AbortController();
    let settled = false;
    const work = runDshEngine(request, { ...options, signal: cancel.signal, driver: async () => {
      entered.resolve(); return new Promise(() => {});
    } }).then(task => { settled = true; return task; });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(90_001); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(settled).toBe(false);
    cancel.abort();
    expect((await work).state).toBe("cancelled");
  });

  it("拒绝非法服务器保护配置且模型不能通过request修改上限", async () => {
    const { request, options } = await fixture();
    const driver = vi.fn(successfulDriver);
    await expect(runDshEngine(request, { ...options, driver, maxToolCalls: -1 })).rejects.toThrow("配置无效");
    await expect(runDshEngine(request, { ...options, driver, totalExecutionTimeoutMs: NaN })).rejects.toThrow("配置无效");
    const forged = { ...request, executionBudget: { maxToolCalls: 1000 } };
    await expect(runDshEngine(forged, { ...options, driver })).rejects.toThrow();
    expect(driver).not.toHaveBeenCalled();
  });

  it("事件观察者异常不改变成功工具和最终失败回执", async () => {
    const { request, options } = await fixture();
    const task = await runDshEngine(request, { ...options, onEvent: () => { throw new Error("UI observer error"); },
      driver: async (input) => { await call(input, "cellSearch", {}); return {}; } });
    expect(task.state).toBe("failed");
    expect(task.terminationCode).toBe("verificationFailed");
    expect(task.counters.toolCallCount).toBe(1);
    expect(task.trace?.some((event) => event.type === "tool_completed")).toBe(true);
  });

  it("两次真实cellSearch参数失败在SSE仅显示安全字段，保留失败并允许模型后续纠正提交", async () => {
    const { request, options } = await fixture();
    const before = structuredClone(request);
    const privateKey = "SYNTHETIC_PRIVATE_ARGUMENT_DO_NOT_EXPORT";
    const controller = new AbortController();
    const events: HarnessTraceEvent[] = [];
    const response = createHarnessStreamResponse(controller.signal, (signal, emit) => runDshEngine(request, {
      ...options, signal, onEvent: emit, driver: async input => {
        await expect(call(input, "cellSearch", { query: null })).rejects.toThrow("参数校验失败");
        await expect(call(input, "cellSearch", { cellId: null, [privateKey]: privateKey })).rejects.toThrow("参数校验失败");
        return successfulDriver(input);
      },
    }));
    const { task } = await readHarnessStream(response, controller.signal, event => events.push(event));
    const failed = events.filter(event => event.type === "tool_failed");
    expect(failed).toHaveLength(2);
    expect(failed[0].message).toContain("query: invalid_type");
    expect(failed[1].message).toContain("cellId: invalid_type");
    expect(failed[1].message).toContain("$: unrecognized_keys");
    expect(JSON.stringify(events)).not.toContain(privateKey);
    expect(JSON.stringify(task)).not.toContain(privateKey);
    expect(task.events.filter(event => event.toolCall?.status === "failure").map(event => event.message))
      .toEqual(failed.map(event => event.message));
    expect(task.state).toBe("awaitingConfirmation");
    expect(task.counters.toolCallCount).toBe(6);
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(task.verification?.status).toBe("passed");
    expect(request).toEqual(before);
  });
});
