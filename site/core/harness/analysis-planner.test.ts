import { describe, expect, it } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { HarnessModel, HarnessRequest } from "./contracts";
import type { HarnessAnalysisPlanDraft } from "./analysis-plan-contracts";
import type { HarnessNotebookDraft } from "./notebook-contracts";
import { createHarnessAnalysisPlanArtifact } from "./analysis-planner";
import { executeHarnessTool } from "./tool-registry";
import { plannedHarnessToolSequence, resolveHarnessIntent } from "./context-selector";
import { DeepSeekHarness } from "./deepseek-harness";

function fixture(instruction = "请先制定分析计划") {
  const { product, model, source, rows } = semanticFixture();
  const request: HarnessRequest = { idempotencyKey: "analysis_plan_test", instruction, pageId: "page_home", dataSourceId: source.id,
    role: "editor", appSpec: product.appSpec, recipes: product.recipes, semanticModel: model };
  const plan: HarnessAnalysisPlanDraft = {
    name: "区域销售分析计划",
    objective: "使用统一销售额口径比较各区域表现",
    questions: ["各区域销售额分别是多少？", "哪个区域销售额最高？"],
    deliverables: ["chart", "table", "narrative"],
    assumptions: ["销售额使用语义模型中的 revenue 指标"],
    steps: [
      { id: "sales_data", kind: "data", title: "销售明细", objective: "读取当前销售数据", dependsOn: [], sourceDataSourceId: source.id },
      { id: "sales_metrics", kind: "semanticQuery", title: "区域销售额", objective: "按区域汇总销售额", dependsOn: ["sales_data"],
        modelId: model.id, modelVersion: model.version, dimensions: ["area"], measures: ["revenue"] },
      { id: "sales_chart", kind: "chart", title: "区域销售额图表", objective: "比较区域差异", dependsOn: ["sales_metrics"],
        chartType: "bar", categoryField: "area", valueFields: ["revenue"] },
      { id: "sales_table", kind: "table", title: "区域销售额明细", objective: "提供可核对数值", dependsOn: ["sales_metrics"], columns: ["area", "revenue"] },
      { id: "sales_note", kind: "text", title: "分析说明", objective: "说明结论与口径", dependsOn: [], narrativeGoal: "概括区域差异并说明销售额口径" },
    ],
  };
  const notebook: HarnessNotebookDraft = { name: "区域销售分析", cells: [
    { id: "sales_data", kind: "data", title: "销售明细", sourceDataSourceId: source.id, outputName: "sales_raw" },
    { id: "sales_metrics", kind: "semanticQuery", title: "区域销售额", inputCellId: "sales_data", modelId: model.id,
      modelVersion: model.version, dimensions: ["area"], measures: ["revenue"], limit: 100, outputName: "sales_by_area" },
    { id: "sales_chart", kind: "chart", title: "区域销售额图表", inputCellId: "sales_metrics", chartType: "bar", categoryField: "area", valueFields: ["revenue"] },
    { id: "sales_table", kind: "table", title: "区域销售额明细", inputCellId: "sales_metrics", columns: ["area", "revenue"] },
    { id: "sales_note", kind: "text", title: "分析说明", markdown: "按统一销售额口径比较各区域。" },
  ] };
  return { request, plan, notebook, source, context: { request, dataRuntime: { rowsByDataSourceId: { [source.id]: rows } },
    now: () => Date.parse("2026-09-10T00:00:00.000Z"), id: () => "analysis_test" } };
}

describe("Harness Analysis Planner", () => {
  it("生成包含目标、问题、依赖、交付物和模型版本的计划产物", () => {
    const input = fixture();
    const artifact = createHarnessAnalysisPlanArtifact(input.plan, { request: input.request, allowedDataSourceIds: [input.source.id],
      now: input.context.now, id: input.context.id });
    expect(artifact).toMatchObject({ id: "analysis_analysis_test", version: 1, status: "planned", objective: input.plan.objective,
      executionOrder: input.plan.steps.map((step) => step.id), sourceDataSourceIds: [input.source.id] });
  });

  it("拒绝前向依赖、模型口径漂移和没有对应步骤的交付物", () => {
    const input = fixture();
    const options = { request: input.request, allowedDataSourceIds: [input.source.id], now: input.context.now, id: input.context.id };
    const forward = structuredClone(input.plan);
    forward.steps[1].dependsOn = ["sales_chart"];
    expect(() => createHarnessAnalysisPlanArtifact(forward, options)).toThrow("排在它之前");
    const stale = structuredClone(input.plan);
    const semantic = stale.steps.find((step) => step.kind === "semanticQuery")!;
    if (semantic.kind === "semanticQuery") semantic.measures = ["profit"];
    expect(() => createHarnessAnalysisPlanArtifact(stale, options)).toThrow("上游不存在的字段");
    const missingChart = structuredClone(input.plan);
    missingChart.steps = missingChart.steps.filter((step) => step.kind !== "chart");
    expect(() => createHarnessAnalysisPlanArtifact(missingChart, options)).toThrow("没有对应步骤");
  });

  it("把计划保存在单次任务内，并要求 Notebook 按计划编译", async () => {
    const input = fixture();
    const store = new Map();
    const context = { ...input.context, analysisPlanStore: store };
    const planned = await executeHarnessTool("createAnalysisPlan", input.plan, context);
    const planId = planned.analysisPlanArtifact!.id;
    expect(store.get(planId)).toBe(planned.analysisPlanArtifact);

    const compiled = await executeHarnessTool("createNotebookDraft", { ...input.notebook, analysisPlanId: planId }, context);
    expect(compiled.notebookArtifact).toMatchObject({ analysisPlanId: planId, status: "draft" });

    const reordered = structuredClone(input.notebook);
    [reordered.cells[2], reordered.cells[3]] = [reordered.cells[3], reordered.cells[2]];
    await expect(executeHarnessTool("createNotebookDraft", { ...reordered, analysisPlanId: planId }, context)).rejects.toThrow("执行顺序不一致");

    const drifted = structuredClone(input.notebook);
    const chart = drifted.cells.find((cell) => cell.kind === "chart")!;
    if (chart.kind === "chart") chart.chartType = "pie";
    await expect(executeHarnessTool("createNotebookDraft", { ...drifted, analysisPlanId: planId }, context)).rejects.toThrow("改变了计划配置");
  });

  it("区分只生成分析计划和继续生成 Notebook 两种任务", () => {
    const planOnly = fixture("请先给我一份分析方案，暂时不要生成 Notebook");
    expect(resolveHarnessIntent(planOnly.request)).toMatchObject({ wantsAnalysisPlan: true, wantsNotebook: false, wantsChange: false });
    expect(plannedHarnessToolSequence(planOnly.request)).toEqual(["createAnalysisPlan"]);

    const notebook = fixture("请创建一个 Hex 风格 Notebook 分析文档");
    expect(resolveHarnessIntent(notebook.request)).toMatchObject({ wantsAnalysisPlan: true, wantsNotebook: true, wantsChange: false });
    expect(plannedHarnessToolSequence(notebook.request)).toEqual(["createAnalysisPlan", "createNotebookDraft"]);
  });

  it("完整 Harness 可以只交付 Analysis Plan 而不生成 Notebook", async () => {
    const input = fixture("请先给我一份分析方案，暂时不要生成 Notebook");
    const model: HarnessModel = {
      next: async ({ iteration }) => ({
        model: "analysis-plan-mock",
        usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
        turn: iteration === 1
          ? { type: "callTool", message: "生成分析计划", toolCallId: "analysis_plan_only_call", name: "createAnalysisPlan", arguments: input.plan }
          : { type: "complete", message: "分析计划已生成，包含目标、问题、步骤、依赖和交付物。" },
      }),
    };

    const task = await new DeepSeekHarness().run(input.request, { dataRuntime: input.context.dataRuntime, modelClient: model });
    expect(task.state, task.error).toBe("completed");
    expect(task.verification?.status).toBe("passed");
    expect(task.analysisPlanArtifact).toMatchObject({ status: "planned", executionOrder: input.plan.steps.map((step) => step.id) });
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.pendingChangeSet).toBeUndefined();
  });
});
