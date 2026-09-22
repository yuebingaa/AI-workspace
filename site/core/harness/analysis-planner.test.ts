import { describe, expect, it } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import type { HarnessModel, HarnessRequest } from "./contracts";
import type { HarnessAnalysisPlanDraft } from "./analysis-plan-contracts";
import type { HarnessNotebookDraft } from "./notebook-contracts";
import { createHarnessAnalysisPlanArtifact } from "./analysis-planner";
import { executeHarnessTool, harnessToolCatalog, HarnessToolArgumentsError } from "./tool-registry";
import { plannedHarnessToolSequence, resolveHarnessIntent } from "./context-selector";
import { DeepSeekHarness } from "./deepseek-harness";
import { runNotebook } from "@/core/notebook/server/runtime";

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
  it("向模型保留表格 / 图表字段格式，中文标题仍可使用", () => {
    const { request } = fixture();
    const [tool] = harnessToolCatalog({ names: ["createAnalysisPlan"], request });
    const expanded: unknown = JSON.parse(JSON.stringify(tool.parameters, (_key, value: unknown) => {
      if (value && typeof value === "object" && "$ref" in value && typeof value.$ref === "string") {
        const name = value.$ref.replace("#/$defs/", "");
        const definition = Object.entries(tool.parameters.$defs ?? {}).find(([key]) => key === name)?.[1];
        expect(definition, `unresolved ${value.$ref}`).toBeDefined();
        return definition;
      }
      return value;
    }));
    expect(expanded).toMatchObject({ properties: { steps: { items: { oneOf: expect.arrayContaining([
      expect.objectContaining({ properties: expect.objectContaining({ kind: expect.objectContaining({ const: "table" }),
        columns: expect.objectContaining({ items: expect.objectContaining({ pattern: "^[A-Za-z][A-Za-z0-9_]*$" }) }),
      }) }),
      expect.objectContaining({ properties: expect.objectContaining({ kind: expect.objectContaining({ const: "chart" }),
        categoryField: expect.objectContaining({ pattern: "^[A-Za-z][A-Za-z0-9_]*$" }),
        valueFields: expect.objectContaining({ items: expect.objectContaining({ pattern: "^[A-Za-z][A-Za-z0-9_]*$" }) }),
      }) }),
    ]) } } } });
    expect(tool.description).toContain("fields.name");
  });

  it("拒绝中文 / 非法列标识并返回可操作规则，不泄露参数内容", async () => {
    const input = fixture();
    const badPlan = structuredClone(input.plan);
    const table = badPlan.steps.find((step) => step.kind === "table")!;
    if (table.kind !== "table") throw new Error("fixture");
    table.columns = ["销售区域", "收入(元)", "sk-synthetic-secret-not-for-diagnostics"];
    try {
      await executeHarnessTool("createAnalysisPlan", badPlan, input.context);
      throw new Error("Invalid arguments must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(HarnessToolArgumentsError);
      if (!(error instanceof HarnessToolArgumentsError)) throw error;
      expect(error.issueSummary[0]).toContain("steps.3.columns.0:invalid_format");
      expect(error.issueSummary[0]).toContain("^[A-Za-z][A-Za-z0-9_]*$");
      expect(error.issueSummary[0]).toContain("fields.name");
      expect(error.message).not.toContain("销售区域");
      expect(error.message).not.toContain("synthetic-secret");
    }
  });

  it("在原预算内用真实字段目录纠正非法列名并交付有效计划", async () => {
    const input = fixture("请先制定分析计划，暂时不要生成 Notebook");
    const badPlan = structuredClone(input.plan);
    const table = badPlan.steps.find((step) => step.kind === "table")!;
    if (table.kind !== "table") throw new Error("fixture");
    table.columns = ["区域", "销售额"];
    const initialSpec = structuredClone(input.request.appSpec);
    let attempts = 0;
    const task = await new DeepSeekHarness().run(input.request, { dataRuntime: input.context.dataRuntime,
      modelClient: { next: async ({ context, iteration }) => {
        attempts += 1;
        if (iteration === 2) {
          expect(context.toolCorrection).toMatchObject({ issueSummary: expect.arrayContaining([
            expect.stringContaining("fields.name"),
          ]) });
          expect(context.datasets).toEqual(expect.arrayContaining([expect.objectContaining({ id: input.source.id,
            fields: input.source.fields.map(({ name, type }) => ({ name, type })),
          })]));
        }
        return { model: "scripted-plan-repair", usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
          turn: iteration <= 2
            ? { type: "callTool", message: "生成分析计划", toolCallId: `plan_${iteration}`, name: "createAnalysisPlan", arguments: iteration === 1 ? badPlan : input.plan }
            : { type: "complete", message: "分析计划已校验，按统一口径比较区域销售，尚未执行数据计算。" },
        };
      } },
    });
    expect(task.state, task.error).toBe("completed");
    expect(attempts).toBe(3);
    expect(task.events.filter((event) => event.toolCall?.status === "failure")).toHaveLength(1);
    expect(task.events.filter((event) => event.toolCall?.status === "success")).toHaveLength(1);
    expect(task.analysisPlanArtifact?.steps).toEqual(input.plan.steps);
    expect(task.verification?.status).toBe("passed");
    expect(input.request.appSpec).toEqual(initialSpec);
  });

  it("语义成员格式错误提示模型 key，而不是原表字段或中文标签", async () => {
    const input = fixture();
    const invalid = structuredClone(input.plan);
    const step = invalid.steps.find((step) => step.kind === "semanticQuery")!;
    if (step.kind !== "semanticQuery") throw new Error("fixture");
    step.measures = ["销售额"];
    await expect(executeHarnessTool("createAnalysisPlan", invalid, input.context)).rejects.toThrow("dimensions/measures.key");
  });

  it.each([false, true])("六个非法列字段纠正后实际运行 SQL / 表格 / 图表，仍需确认采用（含已有长单元：%s）", async (largeContext) => {
    const input = fixture("帮我分析文件");
    delete input.request.semanticModel;
    input.request.notebookContext = { document: { name: "空白分析", revision: 0, cells: [] }, sourceIds: [input.source.id] };
    if (largeContext) input.request.notebookContext.document.cells.push({ id: "sales_note", kind: "text", title: "已有分析说明", markdown: "合成说明。".repeat(800) });
    input.request.appSpec.dataSources.push({ ...input.source, id: "out_of_scope", name: "不能读取的来源" });
    input.plan.steps[1] = { id: "sales_metrics", kind: "sql", title: "区域销售额", objective: "按区域汇总", dependsOn: ["sales_data"], transformation: "按 region 汇总 amount，输出 area 和 revenue" };
    input.notebook.cells[1] = { id: "sales_metrics", kind: "sql", title: "区域销售额", inputCellIds: ["sales_data"], outputName: "sales_by_area",
      sql: "SELECT region AS area, SUM(amount) AS revenue FROM sales_raw GROUP BY region" };
    const invalid = structuredClone(input.plan);
    const table = invalid.steps.find((step) => step.kind === "table")!;
    if (table.kind !== "table") throw new Error("fixture");
    table.columns = Array.from({ length: 6 }, (_, index) => `非法字段${index}`);
    const before = structuredClone(input.request);
    let runCount = 0;
    const task = await new DeepSeekHarness().run(input.request, { dataRuntime: input.context.dataRuntime,
      notebookRunner: async (artifact) => {
        runCount += 1;
        const result = await runNotebook({ document: { name: artifact.name, revision: 0, cells: artifact.cells },
          sources: [{ source: input.source, rows: input.context.dataRuntime.rowsByDataSourceId[input.source.id] }], forAi: true, log: () => {} });
        expect(result.status).toBe("success");
        expect(result.cells.find((cell) => cell.cellId === "sales_table")?.table?.rows).toEqual(expect.arrayContaining([
          { area: "华东", revenue: 150 }, { area: "华南", revenue: 80 },
        ]));
        return result;
      },
      modelClient: { next: async ({ iteration, context }) => {
        if (iteration === 2) {
          expect(context.toolCorrection).toMatchObject({ attempt: 1, maxAttempts: 1, issueSummary: expect.any(Array) });
          expect(context.datasets).toEqual([expect.objectContaining({ id: input.source.id, fields: [
            { name: "region", type: "string" }, { name: "amount", type: "number" },
          ] })]);
          expect(JSON.stringify(context.datasets)).not.toContain("out_of_scope");
          expect(JSON.stringify(context.datasets)).not.toContain("华东");
        }
        const observation = context.latestObservation as { result?: { analysisPlanArtifactId?: string } } | undefined;
        return { model: "scripted-notebook-repair", usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
          turn: iteration <= 2
            ? { type: "callTool", message: "生成分析计划", toolCallId: `plan_${iteration}`, name: "createAnalysisPlan", arguments: iteration === 1 ? invalid : input.plan }
            : { type: "callTool", message: "运行分析草稿", toolCallId: "draft", name: "createNotebookDraft",
              arguments: { ...input.notebook, analysisPlanId: observation?.result?.analysisPlanArtifactId } },
        };
      } },
    });
    expect(task.state, task.error).toBe("awaitingConfirmation");
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(task.verification?.status).toBe("passed");
    expect(runCount).toBe(1);
    expect(task.contextUsage?.limitReached).toBeUndefined();
    if (largeContext) expect(task.contextUsage?.requests.some((entry) => entry.inputChars > 10_000)).toBe(true);
    else expect(task.contextUsage?.requests.every((entry) => entry.inputChars <= 10_000),
      JSON.stringify(task.contextUsage?.requests.map(({ inputChars, phase }) => ({ inputChars, phase })))).toBe(true);
    expect(input.request).toEqual(before);
  });

  it("重复非法字段时仍按原次数停止，不能伪造成功产物", async () => {
    const input = fixture("请先制定分析计划，暂时不要生成 Notebook");
    const invalid = structuredClone(input.plan);
    const table = invalid.steps.find((step) => step.kind === "table")!;
    if (table.kind !== "table") throw new Error("fixture");
    table.columns = ["不合法列名"];
    const task = await new DeepSeekHarness().run(input.request, { dataRuntime: input.context.dataRuntime,
      modelClient: { next: async () => ({ model: "scripted-invalid-plan", usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
        turn: { type: "callTool", message: "仍然生成错误参数", toolCallId: "bad_plan", name: "createAnalysisPlan", arguments: invalid },
      }) },
    });
    expect(task.state).toBe("failed");
    expect(task.terminationCode).toBe("toolExecutionFailed");
    expect(task.counters.toolCallCount).toBe(2);
    expect(task.analysisPlanArtifact).toBeUndefined();
    expect(task.notebookArtifact).toBeUndefined();
    expect(task.error).toContain("fields.name");
  });

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
