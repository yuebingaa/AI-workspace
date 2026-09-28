import { afterEach, describe, expect, it, vi } from "vitest";
import { parseCsvUpload } from "@/core/datasets/server/csv-dataset";
import { harnessRequestSchema } from "@/core/harness/contracts";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { runNotebook } from "@/core/notebook/server/runtime";
import * as bridgeModule from "@/core/harness/server/notebook-tool-bridge";
import * as oldRouting from "./readonly-answer";
import { runDshEngine, type DshDriverInput, type DshEngineOptions } from "./dsh-engine";
import { createAgentExecutor } from "./executor";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function fixture(withData = true) {
  if (!demoFixtureResult.success) throw new Error("Synthetic fixture unavailable");
  const parsed = await parseCsvUpload({ originalFileName: "conversation-synthetic.csv", mimeType: "text/csv",
    stream: new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode("region,amount\nEast,100\nEast,50\nSouth,80\n")); controller.close();
    } }),
  });
  const source = parsed.dataset.source;
  const request = harnessRequestSchema.parse({ idempotencyKey: "dsh_conversation_synthetic", role: "editor", pageId: "page_home",
    instruction: "你是DS吗", appSpec: { ...structuredClone(demoFixtureResult.data.dataProduct.appSpec), dataSources: withData ? [source] : [] }, recipes: [],
    ...(withData ? { dataSourceId: source.id } : {}),
    notebookContext: { sourceIds: withData ? [source.id] : [], document: { name: "对话合成验收", revision: 7, cells: withData ? [
      { id: "data", kind: "data", title: "合成数据", sourceDataSourceId: source.id, outputName: "sales_data" },
      { id: "totals", kind: "sql", title: "地区汇总", inputCellIds: ["data"], outputName: "totals_data",
        sql: "SELECT region, SUM(amount)::DOUBLE AS revenue FROM sales_data GROUP BY region ORDER BY region" },
    ] : [] } },
  });
  const runner = vi.fn<NonNullable<DshEngineOptions["notebookRunner"]>>((artifact, context) => runNotebook({
    document: { name: artifact.name, revision: artifact.baseRevision ?? 0, cells: artifact.cells },
    sources: context.sources,
    forAi: true, signal: context.signal, log: () => {},
  }));
  const options: Omit<DshEngineOptions, "driver"> = { conversationMode: true,
    dataRuntime: { rowsByDataSourceId: withData ? { [source.id]: parsed.rows } : {} }, notebookRunner: runner,
    authorizeCurrentAccess: () => {},
  };
  return { request, options, runner };
}

async function call(input: DshDriverInput, name: string, args: unknown) {
  const tool = input.tools.find(candidate => candidate.name === name);
  if (!tool) throw new Error("Synthetic tool not available");
  return tool.execute(args, input.signal);
}

describe("server-selected DSH conversation terminal", () => {
  it.each([false, true])("preserves a long redacted reply through conversation/definition delivery (reads=%s)", async reads => {
    const { request, options } = await fixture(reads);
    const answer = "Notebook 配置说明。".repeat(400) + " Bearer synthetic-secret-0123456789 完整回答结尾";
    const task = await runDshEngine(request, { ...options, driver: async input => {
      if (reads) await call(input, "cellSearch", {});
      return { finalResponse: answer };
    } });
    expect(task.state).toBe("completed");
    expect(task.resultMessage!.length).toBeGreaterThan(4000);
    expect(task.resultMessage).toContain("完整回答结尾");
    expect(task.resultMessage).not.toContain("synthetic-secret");
    expect(task.resultMessage).not.toContain("按显示上限截取");
  });

  it.each([false, true])("answers without tools or fabricated analysis for a blank workspace (noNotebook=%s)", async noNotebook => {
    const { request, options, runner } = await fixture(false);
    if (noNotebook) delete request.notebookContext;
    const readonly = vi.spyOn(oldRouting, "resolveDshReadonlyMode");
    const existing = vi.spyOn(oldRouting, "isDshExistingAnalysisRequest");
    const task = await runDshEngine(request, { ...options, driver: async input => {
      expect(input.profile).toBe("conversation");
      expect(input.tools).toEqual([]);
      expect(input.context.completion).toMatchObject({ mode: "conversation" });
      expect(input.context.toolsUnavailable).toBeDefined();
      expect(input.context).not.toHaveProperty("notebook");
      input.onModelCall();
      return { finalResponse: "我是通过 DeepSeek Harness 接入的 AgentCanvas 助手。模型版本以网站配置为准。" };
    } });
    expect(task).toMatchObject({ state: "completed", counters: { toolCallCount: 0, modelCallCount: 1 } });
    expect(task.verification).toBeUndefined();
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.resultMessage).toContain("DeepSeek Harness");
    expect(task.resultMessage).toContain("未读取或计算数据");
    expect(task.trace?.some(event => event.type.startsWith("verification_"))).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    expect(readonly).not.toHaveBeenCalled(); expect(existing).not.toHaveBeenCalled();
  });

  it("can clarify with available tools and preserves the request's full bounded history", async () => {
    const { request, options, runner } = await fixture();
    request.instruction = "帮我处理一下这个";
    const prior = "历史说明".repeat(260) + "按地区解释，不代表全年";
    request.conversationContext = { recentMessages: [{ instruction: "记住本轮口径", response: prior }] };
    const task = await runDshEngine(request, { ...options, driver: async input => {
      expect(input.tools.map(tool => tool.name)).toEqual(["cellSearch", "editNotebookCells", "runNotebookCells", "submitNotebookDraft"]);
      expect(input.context.recentConversation).toMatchObject({ recentMessages: [{ response: prior }] });
      return { finalResponse: "你希望查看现有地区汇总，还是新增按地区的图表？" };
    } });
    expect(task.state).toBe("completed"); expect(task.verification).toBeUndefined();
    expect(task.resultMessage).toContain("还是新增"); expect(runner).not.toHaveBeenCalled();
  });

  it("explains real 150/80 results without a phrase classifier, edit or submit", async () => {
    const { request, options, runner } = await fixture(), original = structuredClone(request);
    request.instruction = "按前面商量的口径来吧";
    const task = await runDshEngine(request, { ...options, driver: async input => {
      await call(input, "cellSearch", {});
      expect((await call(input, "runNotebookCells", { editVersion: 0 })).data).toMatchObject({ status: "success",
        results: expect.arrayContaining([expect.objectContaining({ rows: [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }] })]) });
      return { finalResponse: "East合计150，South合计80，当前样本合计230。" };
    } });
    expect(task).toMatchObject({ state: "completed", verification: { status: "passed" }, counters: { toolCallCount: 2 } });
    expect(task.notebookArtifact).toBeUndefined(); expect(task.resultMessage).toContain("East合计150");
    expect(runner).toHaveBeenCalledOnce(); expect(request.notebookContext).toEqual(original.notebookContext);
  }, 20_000);

  it("a definition-only read does not become a verified numeric calculation", async () => {
    const { request, options, runner } = await fixture();
    const task = await runDshEngine(request, { ...options, driver: async input => {
      await call(input, "cellSearch", {});
      return { finalResponse: "现有SQL按region分组，并对amount求和。" };
    } });
    expect(task.state).toBe("completed"); expect(task.resultMessage).toContain("不代表数值结果已经验证");
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([false, true])("a direct real run needs no synthetic definition lookup (searchAfterRun=%s)", async searchAfterRun => {
    const { request, options, runner } = await fixture();
    const task = await runDshEngine(request, { ...options, driver: async input => {
      expect((await call(input, "runNotebookCells", { editVersion: 0 })).data).toMatchObject({ status: "success",
        results: expect.arrayContaining([expect.objectContaining({ rows: [{ region: "East", revenue: 150 }, { region: "South", revenue: 80 }] })]) });
      if (searchAfterRun) await call(input, "cellSearch", {});
      return { finalResponse: "East为150，South为80，本轮三行样本合计230。" };
    } });
    expect(task).toMatchObject({ state: "completed", verification: { status: "passed" }, counters: { toolCallCount: searchAfterRun ? 2 : 1 } });
    expect(runner).toHaveBeenCalledOnce(); expect(task.notebookArtifact).toBeUndefined();
    expect(task.resultMessage).toContain("East为150");
    expect(task.trace?.filter(event => event.type === "tool_completed").map(event => event.toolCall?.name))
      .toEqual(searchAfterRun ? ["runNotebookCells", "cellSearch"] : ["runNotebookCells"]);
  }, 20_000);

  it("direct-run evidence still rejects a different formal revision and forged editVersion", async () => {
    const { request, options } = await fixture();
    const task = await runDshEngine(request, { ...options, driver: async input => {
      const result = await call(input, "runNotebookCells", { editVersion: 0 });
      const evidence = { observations: [{ toolCallId: "actual_run", toolName: "runNotebookCells", data: result.data }],
        baseRevision: 7, parameterCellIds: [] };
      expect(oldRouting.verifyDshCurrentRunEvidence(evidence).valid).toBe(true);
      expect(oldRouting.verifyDshCurrentRunEvidence({ ...evidence, baseRevision: 8 }).valid).toBe(false);
      const data = structuredClone(result.data);
      if (typeof data !== "object" || data === null) throw new Error("Missing actual run receipt");
      Reflect.set(data, "editVersion", 1);
      expect(oldRouting.verifyDshCurrentRunEvidence({ ...evidence,
        observations: [{ toolCallId: "changed_run", toolName: "runNotebookCells", data }] }).valid).toBe(false);
      return { finalResponse: "本次真实汇总为East150、South80。" };
    } });
    expect(task.state).toBe("completed");
  }, 20_000);

  it("allows recovered schema search failures but not an unresolved failed search", async () => {
    for (const recover of [false, true]) {
      const { request, options } = await fixture();
      const task = await runDshEngine(request, { ...options, driver: async input => {
        await expect(call(input, "cellSearch", { cellId: null })).rejects.toThrow();
        if (recover) await call(input, "cellSearch", {});
        return { finalResponse: "现有Notebook具有数据和汇总两个单元。" };
      } });
      expect(task.state).toBe(recover ? "completed" : "failed");
      if (!recover) expect(task.resultMessage).not.toContain("现有Notebook具有");
    }
  });

  it("a rejected edit cannot be recast as a successful conversation", async () => {
    const { request, options } = await fixture();
    const task = await runDshEngine(request, { ...options, driver: async input => {
      await expect(call(input, "editNotebookCells", { editVersion: 0, cells: [], removeCellIds: ["data"] })).rejects.toThrow();
      return { finalResponse: "MODEL_FALSE_SUCCESS 我已经删除了数据单元。" };
    } });
    expect(task.state).toBe("failed"); expect(task.notebookArtifact).toBeUndefined();
    expect(task.resultMessage).not.toContain("MODEL_FALSE_SUCCESS");
  });

  it("a failed real Notebook run cannot become successful prose", async () => {
    const { request, options } = await fixture();
    const sql = request.notebookContext!.document.cells.find(cell => cell.kind === "sql");
    if (sql?.kind !== "sql") throw new Error("Missing synthetic SQL");
    sql.sql = "SELECT missing_field FROM sales_data";
    const task = await runDshEngine(request, { ...options, driver: async input => {
      await call(input, "cellSearch", {});
      await call(input, "runNotebookCells", { editVersion: 0 }).catch(() => undefined);
      return { finalResponse: "MODEL_FALSE_SUCCESS 所有计算均已成功。" };
    } });
    expect(task.state).toBe("failed"); expect(task.resultMessage).not.toContain("MODEL_FALSE_SUCCESS");
    expect(task.verification?.status).not.toBe("passed");
  }, 20_000);

  it("actual editing still requires real run and private submit, leaving formal definitions unchanged", async () => {
    const { request, options } = await fixture(), before = structuredClone(request);
    const task = await runDshEngine(request, { ...options, driver: async input => {
      await call(input, "cellSearch", {});
      await call(input, "editNotebookCells", { editVersion: 0, cells: [
        { id: "chart", kind: "chart", title: "地区收入", inputCellId: "totals", chartType: "bar", categoryField: "region", valueFields: ["revenue"] },
      ] });
      expect((await call(input, "runNotebookCells", { editVersion: 1 })).data).toMatchObject({ status: "success" });
      await call(input, "submitNotebookDraft", { editVersion: 1 });
      return { finalResponse: "已生成地区汇总柱状图，East150，South80。" };
    } });
    expect(task).toMatchObject({ state: "awaitingConfirmation", verification: { status: "passed" } });
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(task.resultMessage).toContain("待你确认"); expect(request).toEqual(before);
  }, 20_000);

  it.each(["scope", "unknown", "spoofed"])("does not turn %s bridge failures into unrestricted chatting", async kind => {
    const { request, options } = await fixture();
    if (kind === "scope") options.dataRuntime.rowsByDataSourceId = {};
    else vi.spyOn(bridgeModule, "createNotebookToolBridge").mockImplementation(() => {
      throw Object.assign(new Error("SYNTHETIC_PRIVATE_ERROR"), kind === "spoofed" ? { name: "NotebookBridgePreflightError", code: "missing_data_context" } : {});
    });
    const driver = vi.fn(async () => ({ finalResponse: "not reached" }));
    const task = await runDshEngine(request, { ...options, driver });
    expect(["failed", "blocked"]).toContain(task.state); expect(driver).not.toHaveBeenCalled();
    expect(task.resultMessage).not.toContain("SYNTHETIC_PRIVATE_ERROR");
  });

  it.each(["cancel", "revoke"])("plain replies still fail closed after %s", async kind => {
    const { request, options } = await fixture(false), controller = new AbortController();
    let allowed = true;
    const task = await runDshEngine(request, { ...options, signal: controller.signal,
      authorizeCurrentAccess: () => { if (!allowed) throw new Error("Authorization revoked"); },
      driver: async () => { if (kind === "cancel") controller.abort(); else allowed = false; return { finalResponse: "LATE_RESPONSE" }; },
    });
    expect(task.state).toBe(kind === "cancel" ? "cancelled" : "failed");
    expect(task.resultMessage).not.toContain("LATE_RESPONSE");
  });

  it.each(["verification_started", "verification_completed"])("does not retain passing verification after revocation at %s", async phase => {
    const { request, options } = await fixture();
    let allowed = true;
    const task = await runDshEngine(request, { ...options,
      authorizeCurrentAccess: () => { if (!allowed) throw new Error("Synthetic revocation"); },
      onEvent: event => { if (event.type === phase) allowed = false; },
      driver: async input => { await call(input, "cellSearch", {}); return { finalResponse: "UNDELIVERABLE_DEFINITION" }; },
    });
    expect(task.state).toBe("failed"); expect(task.verification?.status).not.toBe("passed");
    expect(task.resultMessage).not.toContain("UNDELIVERABLE_DEFINITION");
  });

  it("long ordinary prose is redacted before clipping, with no invented business verification", async () => {
    const { request, options } = await fixture(false);
    const task = await runDshEngine(request, { ...options, driver: async () => ({
      finalResponse: "介绍".repeat(740) + " Bearer synthetic-secret-1234567890 " + "后续内容".repeat(100),
    }) });
    expect(task.state).toBe("completed"); expect(task.verification).toBeUndefined();
    expect(task.resultMessage).not.toContain("synthetic-secret");
    expect(task.resultMessage).toContain("[已脱敏]");
    expect(task.resultMessage!.length).toBeLessThanOrEqual(2_000);
  });

  it("fourth composition argument selects conversation while the old three-argument path is unchanged", async () => {
    const { request, options } = await fixture(false);
    const driver = vi.fn(async () => ({ finalResponse: "你好，我是DSH接入的助手。" }));
    const execute = createAgentExecutor(driver);
    const composed = { dataRuntime: options.dataRuntime, notebookRunner: options.notebookRunner,
      authorizeCurrentAccess: options.authorizeCurrentAccess };
    const old = await execute("dsh", request, composed);
    expect(old.state).toBe("blocked"); expect(driver).not.toHaveBeenCalled();
    expect((await execute("dsh", request, composed, { dshConversation: true })).state).toBe("completed");
    expect(driver).toHaveBeenCalledOnce();
    await expect(execute("harness", request, composed, { dshConversation: true })).rejects.toThrow("不能使用其他执行器");
  });
});
