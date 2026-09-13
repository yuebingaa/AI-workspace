import { describe, expect, it } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { HarnessNotebookDraft } from "./notebook-contracts";
import type { HarnessModel, HarnessRequest } from "./contracts";
import { DeepSeekHarness } from "./deepseek-harness";
import { createHarnessNotebookArtifact } from "./notebook";
import { plannedHarnessToolSequence, resolveHarnessIntent } from "./context-selector";
import { executeHarnessTool, harnessToolCatalog } from "./tool-registry";
import { createHarnessExecutionPlan } from "./execution-planner";
import { verifyHarnessTask } from "./task-verifier";
import { runNotebook } from "@/core/notebook/server/runtime";
import { settleHarnessConfirmation } from "./task-state";
import type { HarnessAnalysisPlanDraft } from "./analysis-plan-contracts";

function fixture(instruction = "请根据当前数据创建一个 Hex 风格分析文档") {
  const { product, model, source, rows } = semanticFixture();
  const request: HarnessRequest = {
    idempotencyKey: "notebook_test_request",
    instruction,
    pageId: "page_home",
    dataSourceId: source.id,
    role: "editor",
    appSpec: product.appSpec,
    recipes: product.recipes,
    semanticModel: model,
  };
  const draft: HarnessNotebookDraft = {
    name: "区域销售分析",
    cells: [
      { id: "sales_data", kind: "data", title: "销售明细", sourceDataSourceId: source.id, outputName: "sales_raw" },
      { id: "sales_metrics", kind: "semanticQuery", title: "区域销售额", inputCellId: "sales_data", modelId: model.id,
        modelVersion: model.version, dimensions: ["area"], measures: ["revenue"], limit: 100, outputName: "sales_by_area" },
      { id: "sales_chart", kind: "chart", title: "区域销售额图表", inputCellId: "sales_metrics", chartType: "bar",
        categoryField: "area", valueFields: ["revenue"] },
      { id: "sales_table", kind: "table", title: "区域销售额明细", inputCellId: "sales_metrics", columns: ["area", "revenue"] },
      { id: "sales_note", kind: "text", title: "分析说明", markdown: "按统一销售额口径比较各区域。" },
    ],
  };
  return {
    request,
    draft,
    source,
    context: {
      request,
      dataRuntime: { rowsByDataSourceId: { [source.id]: rows } },
      now: () => Date.parse("2026-09-10T00:00:00.000Z"),
      id: () => "notebook_test",
    },
  };
}

function analysisPlan(input: ReturnType<typeof fixture>): HarnessAnalysisPlanDraft {
  const model = input.request.semanticModel!;
  return { name: "区域销售分析计划", objective: "按统一口径比较各区域销售额", questions: ["各区域销售额是多少？"],
    deliverables: ["chart", "table", "narrative"], steps: [
      { id: "sales_data", kind: "data", title: "销售明细", objective: "读取销售数据", dependsOn: [], sourceDataSourceId: input.source.id },
      { id: "sales_metrics", kind: "semanticQuery", title: "区域销售额", objective: "按区域汇总销售额", dependsOn: ["sales_data"],
        modelId: model.id, modelVersion: model.version, dimensions: ["area"], measures: ["revenue"] },
      { id: "sales_chart", kind: "chart", title: "区域销售额图表", objective: "比较区域差异", dependsOn: ["sales_metrics"], chartType: "bar", categoryField: "area", valueFields: ["revenue"] },
      { id: "sales_table", kind: "table", title: "区域销售额明细", objective: "展示汇总数值", dependsOn: ["sales_metrics"], columns: ["area", "revenue"] },
      { id: "sales_note", kind: "text", title: "分析说明", objective: "解释结论", dependsOn: [], narrativeGoal: "说明区域差异和指标口径" },
    ] };
}

function analysisPlanId(context: Record<string, unknown>): string {
  const observation = context.latestObservation as { result?: { analysisPlanArtifactId?: unknown } } | undefined;
  const id = observation?.result?.analysisPlanArtifactId;
  if (typeof id !== "string") throw new Error("测试缺少 Analysis Plan ID");
  return id;
}

describe("Harness Notebook 草稿", () => {
  it("生成带有稳定顺序、数据血缘和模型版本的草稿产物", () => {
    const input = fixture();
    const artifact = createHarnessNotebookArtifact(input.draft, {
      request: input.request,
      allowedDataSourceIds: [input.source.id],
      now: input.context.now,
      id: input.context.id,
    });

    expect(artifact).toMatchObject({
      id: "notebook_notebook_test",
      version: 1,
      status: "draft",
      executionOrder: ["sales_data", "sales_metrics", "sales_chart", "sales_table", "sales_note"],
      sourceDataSourceIds: [input.source.id],
    });
    expect(artifact.lineage).toEqual([
      { cellId: "sales_data", dependsOn: [] },
      { cellId: "sales_metrics", dependsOn: ["sales_data"] },
      { cellId: "sales_chart", dependsOn: ["sales_metrics"] },
      { cellId: "sales_table", dependsOn: ["sales_metrics"] },
      { cellId: "sales_note", dependsOn: [] },
    ]);
  });

  it("拒绝前向引用、未知字段和错误的语义模型版本", () => {
    const input = fixture();
    const options = { request: input.request, allowedDataSourceIds: [input.source.id], now: input.context.now, id: input.context.id };
    const forwardReference: HarnessNotebookDraft = { ...input.draft, cells: [input.draft.cells[2], ...input.draft.cells.slice(0, 2)] };
    expect(() => createHarnessNotebookArtifact(forwardReference, options)).toThrow("排在它之前");

    const unknownField = structuredClone(input.draft);
    const chart = unknownField.cells.find((cell) => cell.kind === "chart")!;
    if (chart.kind === "chart") chart.valueFields = ["profit"];
    expect(() => createHarnessNotebookArtifact(unknownField, options)).toThrow("上游不存在的字段");

    const staleModel = structuredClone(input.draft);
    const semantic = staleModel.cells.find((cell) => cell.kind === "semanticQuery")!;
    if (semantic.kind === "semanticQuery") semantic.modelVersion += 1;
    expect(() => createHarnessNotebookArtifact(staleModel, options)).toThrow("本次选中的语义模型及版本");
  });

  it("由独立工具返回草稿，不修改正式 AppSpec", async () => {
    const input = fixture();
    const before = structuredClone(input.request.appSpec);
    const result = await executeHarnessTool("createNotebookDraft", input.draft, input.context);

    expect(result.notebookArtifact?.cells).toHaveLength(5);
    expect(result.data).toMatchObject({ notebookArtifactId: "notebook_notebook_test", status: "draft", cellCount: 5 });
    expect(input.request.appSpec).toEqual(before);
    expect(harnessToolCatalog({ names: ["createNotebookDraft"], request: input.request })[0]).toMatchObject({
      name: "createNotebookDraft",
      mode: "readOnly",
    });
  });

  it("把明确的 Hex/Notebook 创建请求路由为草稿任务，不生成页面 ChangeSet", () => {
    const input = fixture();
    const intent = resolveHarnessIntent(input.request);
    expect(intent).toMatchObject({ wantsNotebook: true, wantsData: true, wantsChange: false });
    expect(plannedHarnessToolSequence(input.request)).toEqual(["createAnalysisPlan", "createNotebookDraft"]);
  });

  it("Verifier 要求 createNotebookDraft 的真实产物证据", async () => {
    const input = fixture();
    const plan = createHarnessExecutionPlan(input.request);
    const missing = verifyHarnessTask({ request: input.request, plan, observations: [], attempt: 1,
      candidate: { outcome: "completed", message: "Notebook 草稿已生成。", formalAppSpecUnchanged: true } });
    expect(missing.checks.find((check) => check.id === "notebook_draft")?.status).toBe("failed");

    const store = new Map();
    const context = { ...input.context, analysisPlanStore: store };
    const planned = await executeHarnessTool("createAnalysisPlan", analysisPlan(input), context);
    const draft = { ...input.draft, analysisPlanId: planned.analysisPlanArtifact!.id };
    const result = await executeHarnessTool("createNotebookDraft", draft, context);
    const verified = verifyHarnessTask({ request: input.request, plan, observations: [
      { toolCallId: "plan_call", toolName: "createAnalysisPlan", summary: planned.summary, data: planned.data },
      { toolCallId: "draft_call", toolName: "createNotebookDraft", summary: result.summary, data: result.data },
    ], attempt: 1,
      candidate: { outcome: "completed", message: "已生成包含数据、语义查询、图表、表格和说明的 Notebook 草稿。", formalAppSpecUnchanged: true } });
    expect(verified.status).toBe("passed");
  });

  it("完整 Harness 把 Notebook 草稿保留为任务产物", async () => {
    const input = fixture();
    const model: HarnessModel = {
      next: async ({ iteration, context }) => ({
        model: "notebook-mock",
        usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
        turn: iteration === 1
          ? { type: "callTool", message: "生成分析计划", toolCallId: "analysis_plan_call", name: "createAnalysisPlan", arguments: analysisPlan(input) }
          : iteration === 2
            ? { type: "callTool", message: "生成 Notebook 草稿", toolCallId: "notebook_draft_call", name: "createNotebookDraft", arguments: { ...input.draft, analysisPlanId: analysisPlanId(context) } }
          : { type: "complete", message: "已生成包含数据、语义查询、图表、表格和说明的 Notebook 草稿，依赖关系已通过校验。" },
      }),
    };

    const task = await new DeepSeekHarness().run(input.request, { dataRuntime: input.context.dataRuntime, modelClient: model });
    expect(task.state).toBe("completed");
    expect(task.verification?.status).toBe("passed");
    expect(task.notebookArtifact).toMatchObject({ status: "draft", executionOrder: input.draft.cells.map((cell) => cell.id) });
    expect(task.pendingChangeSet).toBeUndefined();
  });

  it("Notebook 上下文驱动真实 SQL 执行，完成后等待采用而不是修改看板", async () => {
    const input = fixture("帮我分析销售，创建可复用的步骤");
    input.request.notebookContext = { sourceIds: [input.source.id], document: { name: "分析", revision: 3, cells: [] } };
    const draft: HarnessNotebookDraft = { name: "本地销售分析", cells: [input.draft.cells[0],
      { id: "sales_sql", kind: "sql", title: "销售汇总", inputCellIds: [input.draft.cells[0].id], outputName: "totals",
        sql: "SELECT region, SUM(amount) AS revenue FROM sales_raw GROUP BY region" },
      { id: "sales_table", kind: "table", title: "销售结果", inputCellId: "sales_sql", columns: ["region", "revenue"] },
    ] };
    const sqlPlan: HarnessAnalysisPlanDraft = { name: "本地销售分析计划", objective: "按地区汇总销售额", questions: ["各地区销售额是多少？"], deliverables: ["table"], steps: [
      { id: "sales_data", kind: "data", title: "销售明细", objective: "读取销售数据", dependsOn: [], sourceDataSourceId: input.source.id },
      { id: "sales_sql", kind: "sql", title: "销售汇总", objective: "按地区计算销售额", dependsOn: ["sales_data"], transformation: "按 region 分组并对 amount 求和为 revenue" },
      { id: "sales_table", kind: "table", title: "销售结果", objective: "展示地区和销售额", dependsOn: ["sales_sql"], columns: ["region", "revenue"] },
    ] };
    const before = structuredClone(input.request.appSpec);
    const task = await new DeepSeekHarness().run(input.request, {
      dataRuntime: input.context.dataRuntime,
      modelClient: { next: async ({ iteration, context }) => ({ model: "notebook-test-model", usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
        turn: iteration === 1
          ? { type: "callTool", name: "createAnalysisPlan", toolCallId: "notebook_plan_call", message: "规划分析", arguments: sqlPlan }
          : { type: "callTool", name: "createNotebookDraft", toolCallId: "notebook_sql_call", message: "生成分析草稿", arguments: { ...draft, analysisPlanId: analysisPlanId(context) } } }) },
      notebookRunner: (artifact) => runNotebook({ document: { name: artifact.name, revision: 3, cells: artifact.cells },
        sources: [{ source: input.source, rows: input.context.dataRuntime.rowsByDataSourceId[input.source.id] }], forAi: true, log: () => {} }),
    });
    expect(task.state, task.error).toBe("awaitingConfirmation");
    expect(task.verification?.status).toBe("passed");
    expect(task.notebookArtifact).toMatchObject({ baseRevision: 3, executionEvidence: { status: "success", completedCellIds: draft.cells.map((cell) => cell.id) } });
    expect(task.pendingChangeSet).toBeUndefined(); expect(input.request.appSpec).toEqual(before);
    const confirmed = settleHarnessConfirmation(task, true, { now: () => new Date(input.context.now()), id: input.context.id });
    expect(confirmed.resultMessage).toContain("正式看板未修改");
    expect(confirmed.events.at(-1)?.message).not.toContain("ChangeSet");
  }, 15_000);
});
