import { describe, expect, it, vi } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { runNotebook } from "@/core/notebook/server/runtime";
import { adoptNotebookDraft } from "@/core/notebook/client-state";
import type { NotebookCell } from "@/core/notebook/definition";
import type { HarnessModel, HarnessObservation, HarnessRequest, HarnessToolName } from "./contracts";
import { executeHarnessTool, harnessToolCatalog, type HarnessToolContext } from "./tool-registry";
import { buildHarnessContextSelection, estimateHarnessModelInputChars, plannedHarnessToolSequence } from "./context-selector";
import { DeepSeekHarness } from "./deepseek-harness";

function fixture() {
  const { product, source, rows } = semanticFixture();
  const request: HarnessRequest = { idempotencyKey: "notebook_cells_test", instruction: "检查现有单元，添加 SQL 汇总和图表单元",
    role: "editor", pageId: "page_home", appSpec: product.appSpec, recipes: [], dataSourceId: source.id,
    notebookContext: { sourceIds: [source.id], document: { name: "区域分析", revision: 7, cells: [
      { id: "note", kind: "text", title: "销售数据分析演示", markdown: "保留原有分析说明" },
      { id: "data", kind: "data", title: "销售数据", sourceDataSourceId: source.id, outputName: "sales_data" },
    ] } } };
  const context: HarnessToolContext = { request, dataRuntime: { rowsByDataSourceId: { [source.id]: rows } },
    now: Date.now, id: () => crypto.randomUUID(),
    notebookCellSession: { document: structuredClone(request.notebookContext!.document), editVersion: 0 },
    notebookRunner: (artifact, ctx) => runNotebook({ document: { name: artifact.name, revision: 7, cells: artifact.cells },
      sources: [{ source, rows }], forAi: true, signal: ctx.signal, log: () => {} }) };
  const sql: NotebookCell = { id: "summary", kind: "sql", title: "按地区汇总", inputCellIds: ["data"],
    outputName: "totals", sql: "SELECT region, SUM(amount) AS revenue FROM sales_data GROUP BY region ORDER BY revenue DESC" };
  const chart: NotebookCell = { id: "chart", kind: "chart", title: "地区收入", inputCellId: "summary", chartType: "bar", categoryField: "region", valueFields: ["revenue"] };
  return { request, context, sql, chart };
}

describe("Notebook 单元工具", () => {
  it("查找标题、相邻单元与长定义分页，不把空匹配当作空文档", async () => {
    const { context } = fixture();
    const result = await executeHarnessTool("cellSearch", { query: "演示" }, context);
    expect(result.data).toMatchObject({ editVersion: 0, totalCells: 2, matchedCount: 1, sourceCellId: "note", neighbors: [{ id: "note" }, { id: "data" }] });
    expect((await executeHarnessTool("cellSearch", { query: "不存在" }, context)).data).toMatchObject({ matchedCount: 0, totalCells: 2 });
    context.notebookCellSession!.document.cells[0] = { id: "note", kind: "text", title: "长说明", markdown: "甲".repeat(3900) };
    const first = await executeHarnessTool("cellSearch", { cellId: "note" }, context);
    const second = await executeHarnessTool("cellSearch", { cellId: "note", sourceOffset: 2000 }, context);
    expect(first.data).toMatchObject({ sourceTruncated: true, nextSourceOffset: 2000 });
    expect(second.data).toMatchObject({ sourceTruncated: false });
    await expect(executeHarnessTool("cellSearch", { cellId: "missing" }, context)).rejects.toThrow("找不到");
  });

  it("真实执行 SQL→图表；保留原单元，采用前不改文档，采用时拒绝过期版本", async () => {
    const { context, request, sql, chart } = fixture();
    const before = structuredClone(request);
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [sql, chart] }, context);
    const result = await executeHarnessTool("runNotebookCells", { editVersion: 1 }, context);
    expect(result.data).toMatchObject({ status: "success", results: [
      { cellId: "summary", rows: [{ region: "华东", revenue: 150 }, { region: "华南", revenue: 80 }] },
      { cellId: "chart", rows: [{ region: "华东", revenue: 150 }, { region: "华南", revenue: 80 }] },
    ] });
    const submitted = await executeHarnessTool("submitNotebookDraft", { editVersion: 1 }, context);
    expect(request).toEqual(before);
    expect(submitted.notebookArtifact!.cells.slice(0, 2)).toEqual(before.notebookContext!.document.cells);
    expect(submitted.notebookArtifact).toMatchObject({ baseRevision: 7, executionEvidence: { status: "success" } });
    expect(adoptNotebookDraft(request.notebookContext!.document, submitted.notebookArtifact!).cells).toHaveLength(4);
    expect(() => adoptNotebookDraft({ ...request.notebookContext!.document, revision: 8 }, submitted.notebookArtifact!)).toThrow();
  }, 15_000);

  it("预算缩减时源代码仍可按真实偏移连续读取，不标记截断代码为完整", async () => {
    const { context } = fixture();
    const state = context.notebookCellSession!;
    state.document.cells[0] = { id: "note", kind: "text", title: "长说明", markdown: "\\\"\n".repeat(1000) };
    context.resultBudgetChars = 1200;
    let offset = 0;
    let joined = "";
    for (let page = 0; page < 40; page += 1) {
      const result = await executeHarnessTool("cellSearch", { cellId: "note", sourceOffset: offset }, context);
      const data = result.data as { source: string; sourceTruncated: boolean; nextSourceOffset: number | null };
      expect(JSON.stringify(data).length).toBeLessThanOrEqual(1200);
      joined += data.source;
      if (!data.sourceTruncated) break;
      expect(data.nextSourceOffset).toBeGreaterThan(offset);
      offset = data.nextSourceOffset!;
    }
    expect(joined).toBe(JSON.stringify(state.document.cells[0], null, 2));
  });

  it("失败保留可修正错误；修改后旧运行证据失效，修复再运行才可提交", async () => {
    const { context, sql, chart } = fixture();
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [{ ...sql, sql: "SELECT missing FROM sales_data" }, chart] }, context);
    expect((await executeHarnessTool("runNotebookCells", { editVersion: 1 }, context)).data).toMatchObject({ status: "failure", errors: [{ cellId: "summary", status: "failure" }, { cellId: "chart", status: "blocked" }] });
    await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 1 }, context)).rejects.toThrow("尚未完整试运行通过");
    await executeHarnessTool("editNotebookCells", { editVersion: 1, cells: [sql] }, context);
    await expect(executeHarnessTool("runNotebookCells", { editVersion: 1 }, context)).rejects.toThrow("版本已变化");
    await executeHarnessTool("runNotebookCells", { editVersion: 2 }, context);
    await executeHarnessTool("editNotebookCells", { editVersion: 2, cells: [{ ...chart, title: "新标题" }] }, context);
    await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 3 }, context)).rejects.toThrow("尚未完整试运行通过");
    await executeHarnessTool("runNotebookCells", { editVersion: 3 }, context);
    expect((await executeHarnessTool("submitNotebookDraft", { editVersion: 3 }, context)).notebookArtifact).toBeDefined();
  }, 20_000);

  it("事务化验证源权限、SQL限制、依赖、重复 ID 与插入位置，失败不损坏草稿", async () => {
    const { context, sql, chart } = fixture();
    const before = structuredClone(context.notebookCellSession);
    const attempts = [
      { cells: [chart] }, { cells: [sql, sql] }, { cells: [sql], afterCellId: "missing" },
      { cells: [sql], afterCellId: null }, { cells: [sql], removeCellIds: [sql.id] },
      { cells: [{ ...sql, sql: "DROP TABLE sales_data" }] },
      { cells: [{ id: "secret", kind: "data", title: "其他数据", sourceDataSourceId: "unapproved", outputName: "secret" }] },
      { cells: [], removeCellIds: ["missing"] },
    ];
    for (const args of attempts) {
      await expect(executeHarnessTool("editNotebookCells", { editVersion: 0, ...args }, context)).rejects.toThrow();
      expect(context.notebookCellSession).toEqual(before);
    }
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [sql, chart], afterCellId: "data" }, context);
    await expect(executeHarnessTool("editNotebookCells", { editVersion: 1, cells: [], removeCellIds: ["data"] }, context)).rejects.toThrow();
    expect(context.notebookCellSession!.editVersion).toBe(1);
  });

  it("任务隔离、没有运行器、取消后迟到回执和不完整回执均不能生成成功证据", async () => {
    const { context, sql } = fixture();
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [sql] }, context);
    expect(fixture().context.notebookCellSession!.editVersion).toBe(0);
    await expect(executeHarnessTool("runNotebookCells", { editVersion: 1 }, { ...context, notebookRunner: undefined })).rejects.toThrow("执行器未配置");
    const runner = context.notebookRunner!;
    const abort = new AbortController();
    context.signal = abort.signal;
    context.notebookRunner = async (artifact, ctx) => { const run = await runner(artifact, ctx); abort.abort(); return run; };
    await expect(executeHarnessTool("runNotebookCells", { editVersion: 1 }, context)).rejects.toThrow();
    expect(context.notebookCellSession!.run).toBeUndefined();
    context.signal = undefined;
    context.notebookRunner = async (artifact, ctx) => ({ ...await runner(artifact, ctx), cells: [] });
    await expect(executeHarnessTool("runNotebookCells", { editVersion: 1 }, context)).rejects.toThrow("回执与本次草稿不一致");
  }, 15_000);

  it.each([null, 10_000])("主 Harness 完成搜索→修改→真实运行→提交，兼容无额度和显式额度（%s）", async (maxRequestInputChars) => {
    const { context, request, sql, chart } = fixture();
    const calls: Array<[HarnessToolName, Record<string, unknown>]> = [["cellSearch", {}], ["editNotebookCells", { editVersion: 0, cells: [sql, chart] }],
      ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }]];
    const inputs: number[] = [];
    const model: HarnessModel = {
      classifyIntent: async () => ({ model: "scripted-router", inputChars: 300,
        usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
        decision: { mode: "readOnlyTask", wantsNotebook: true, wantsData: true, wantsEdsAnalysis: false,
          wantsRawWorkbook: false, wantsFields: false, wantsRecipe: false, wantsAppInspection: false, wantsExcel: false,
          changeAction: "none", changeTarget: "none", componentKind: "none", chartType: "auto", skillIds: [], confidence: 1, rationale: "编辑分析单元" } }),
      plan: async ({ fallbackPlan }) => ({ plan: fallbackPlan, model: "scripted-planner", inputChars: 300,
        usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 } }),
      next: async (input) => {
      const [name, args] = calls[input.iteration - 1];
      inputs.push(input.estimatedInputChars);
      expect(input.tools.map((tool) => tool.name)).toContain(name);
      return { model: "scripted-notebook-test", usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
        turn: { type: "callTool", name, arguments: args, toolCallId: `cell_call_${input.iteration}`, message: "验证单元" } };
    } };
    const task = await new DeepSeekHarness().run(request, { dataRuntime: context.dataRuntime, modelClient: model, notebookRunner: context.notebookRunner,
      contextBudget: { maxRequestInputChars } });
    expect(task.state, JSON.stringify({ error: task.error, events: task.events.map((event) => event.message) })).toBe("awaitingConfirmation");
    expect(task.verification?.status).toBe("passed");
    expect(task.counters.toolCallCount).toBe(4);
    expect(task.counters.modelCallCount).toBe(6);
    if (maxRequestInputChars !== null) expect(Math.max(...inputs)).toBeLessThanOrEqual(maxRequestInputChars);
    else expect(Math.max(...inputs)).toBeGreaterThan(10_000);
    expect(task.contextUsage?.limits?.maxRequestInputChars).toBe(maxRequestInputChars);
    expect(task.notebookArtifact!.cells).toHaveLength(4);
  }, 15_000);

  it("主循环可按 SQL 失败回执修改再跑，六次工具内完成并拒绝采用失败结果", async () => {
    const { context, request, sql } = fixture();
    const calls: Array<[HarnessToolName, Record<string, unknown>]> = [["cellSearch", {}],
      ["editNotebookCells", { editVersion: 0, cells: [{ ...sql, sql: "SELECT missing FROM sales_data" }] }],
      ["runNotebookCells", { editVersion: 1 }], ["editNotebookCells", { editVersion: 1, cells: [sql] }],
      ["runNotebookCells", { editVersion: 2 }], ["submitNotebookDraft", { editVersion: 2 }]];
    const task = await new DeepSeekHarness().run(request, { dataRuntime: context.dataRuntime, notebookRunner: context.notebookRunner,
      modelClient: { next: async (input) => {
        if (input.iteration === 4) {
          expect(input.tools.map((tool) => tool.name)).not.toContain("submitNotebookDraft");
          expect(input.context.latestObservation).toMatchObject({ result: { status: "failure", errors: [{ cellId: "summary" }] } });
        }
        const [name, args] = calls[input.iteration - 1];
        expect(input.tools.map((tool) => tool.name)).toContain(name);
        return { model: "scripted-repair", usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
          turn: { type: "callTool", name, arguments: args, toolCallId: `repair_${input.iteration}`, message: "核查并修复单元" } };
      } } });
    expect(task.state, task.error).toBe("awaitingConfirmation");
    expect(task.counters.toolCallCount).toBe(6);
    expect(task.notebookArtifact!.executionEvidence!.status).toBe("success");
  }, 15_000);

  it("按最新编辑/运行选择后续工具；长文档按需读取；旧整稿路径和闲聊保留", async () => {
    const { context, request, sql, chart } = fixture();
    const observations: HarnessObservation[] = [];
    for (const [name, args] of [["cellSearch", {}], ["editNotebookCells", { editVersion: 0, cells: [sql, chart] }], ["runNotebookCells", { editVersion: 1 }]] as const) {
      const selection = buildHarnessContextSelection(request, observations, 1, true);
      expect(selection.toolNames).toContain(name);
      const catalog = harnessToolCatalog({ names: selection.toolNames, request });
      expect(estimateHarnessModelInputChars(selection.context, catalog, 1)).toBeLessThanOrEqual(10_000);
      const result = await executeHarnessTool(name, args, context);
      observations.push({ toolName: name, toolCallId: name, summary: result.summary, data: result.data });
    }
    expect(buildHarnessContextSelection(request, observations, 4).toolNames).toContain("submitNotebookDraft");
    const edit = await executeHarnessTool("editNotebookCells", { editVersion: 1, cells: [sql] }, context);
    observations.push({ toolName: "editNotebookCells", toolCallId: "edit_again", summary: edit.summary, data: edit.data });
    expect(buildHarnessContextSelection(request, observations, 5).toolNames).not.toContain("submitNotebookDraft");
    expect(plannedHarnessToolSequence({ ...request, instruction: "创建分析文档" })).toEqual(["createAnalysisPlan", "createNotebookDraft"]);
    expect(plannedHarnessToolSequence({ ...request, instruction: "你能创建 Notebook 单元吗？" })).toEqual([]);
    const noNotebook = { ...request, notebookContext: undefined };
    expect(harnessToolCatalog({ names: ["cellSearch"], request: noNotebook })).toEqual([]);
    await expect(executeHarnessTool("cellSearch", {}, { ...context, request: noNotebook })).rejects.toThrow("没有 Notebook");
    expect(vi.isMockFunction(context.notebookRunner)).toBe(false);
  }, 15_000);
});
