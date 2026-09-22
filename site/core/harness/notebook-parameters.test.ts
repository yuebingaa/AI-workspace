import { describe, expect, it } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { runNotebook } from "@/core/notebook/server/runtime";
import { adoptNotebookDraft } from "@/core/notebook/client-state";
import type { NotebookCell } from "@/core/notebook/definition";
import { createHarnessAnalysisPlanArtifact } from "./analysis-planner";
import { createHarnessNotebookArtifact } from "./notebook";
import type { HarnessAnalysisPlanDraft } from "./analysis-plan-contracts";
import type { HarnessRequest, HarnessToolName } from "./contracts";
import { buildHarnessContextSelection } from "./context-selector";
import { DeepSeekHarness } from "./deepseek-harness";
import { executeHarnessTool, harnessToolCatalog, type HarnessToolContext } from "./tool-registry";

const parameter: Extract<NotebookCell, { kind: "parameter" }> = {
  id: "threshold", kind: "parameter", title: "最低金额", outputName: "threshold",
  parameter: { type: "number", value: 100 },
};
const sql: NotebookCell = { id: "calculation", kind: "sql", title: "参数计算", inputCellIds: ["threshold"],
  outputName: "calculated", sql: "SELECT value * 2 AS total FROM threshold" };
const table: NotebookCell = { id: "display", kind: "table", title: "结果", inputCellId: "calculation", columns: ["total"] };

function fixture() {
  const { product } = semanticFixture();
  product.appSpec.dataSources = [];
  const request: HarnessRequest = { idempotencyKey: "parameter_fixture", instruction: "创建金额参数和计算单元",
    role: "editor", pageId: "page_home", appSpec: product.appSpec, recipes: [],
    notebookContext: { sourceIds: [], document: { name: "参数分析", revision: 3, cells: [] } } };
  const context: HarnessToolContext = { request, now: Date.now, id: () => crypto.randomUUID(),
    dataRuntime: { rowsByDataSourceId: {} },
    notebookCellSession: { document: structuredClone(request.notebookContext!.document), editVersion: 0 },
    notebookRunner: (artifact, ctx) => runNotebook({ document: { name: artifact.name, revision: 3, cells: artifact.cells },
      sources: [], forAi: true, signal: ctx.signal, log: () => {} }),
  };
  const plan: HarnessAnalysisPlanDraft = { name: "参数计划", objective: "计算金额的两倍", questions: ["结果是多少？"],
    deliverables: ["table"], steps: [
      { id: parameter.id, kind: "parameter", title: parameter.title, objective: "提供最低金额", dependsOn: [], parameter: parameter.parameter },
      { id: sql.id, kind: "sql", title: sql.title, objective: "计算", dependsOn: [parameter.id], transformation: "将金额乘二" },
      { id: table.id, kind: "table", title: table.title, objective: "展示", dependsOn: [sql.id], columns: ["total"] },
    ] };
  return { request, context, plan };
}

describe("参数单元 Agent 兼容路径", () => {
  it("空 Notebook 的参数任务不因没有 Dataset 阻断，普通数据任务仍阻断", async () => {
    const { request, context } = fixture();
    const selection = buildHarnessContextSelection(request, [], 0);
    expect(selection.blockingReason).toBeUndefined();
    expect(selection.toolNames).toEqual(["cellSearch"]);
    const inspection = await executeHarnessTool("cellSearch", {}, context);
    expect(buildHarnessContextSelection(request, [{ toolName: "cellSearch", toolCallId: "inspect",
      summary: inspection.summary, data: inspection.data }], 1).toolNames).toContain("editNotebookCells");
    request.instruction = "分析销售数据";
    expect(buildHarnessContextSelection(request, [], 0).blockingReason).toContain("没有可解析的数据源");
    request.notebookContext!.document.cells = [parameter];
    expect(buildHarnessContextSelection(request, [], 0).blockingReason).toBeUndefined();
  });

  it("模型目录使用同源四类参数配置，非参数任务不增加无关 Schema", () => {
    const { request } = fixture();
    for (const name of ["createAnalysisPlan", "createNotebookDraft", "editNotebookCells"] as const) {
      const [tool] = harnessToolCatalog({ names: [name], request });
      expect(tool.description).toContain("不拼 SQL");
      const list = name === "createAnalysisPlan" ? "steps" : "cells";
      expect(tool.parameters).toMatchObject({ properties: { [list]: { items: { oneOf: expect.arrayContaining([
        expect.objectContaining({ properties: expect.objectContaining({ kind: { type: "string", const: "parameter" },
          parameter: expect.objectContaining({ oneOf: expect.arrayContaining([
            expect.objectContaining({ properties: expect.objectContaining({ type: { type: "string", const: "number" },
              value: expect.objectContaining({ type: "number", maximum: Number.MAX_SAFE_INTEGER, minimum: -Number.MAX_SAFE_INTEGER }) }) }),
            expect.objectContaining({ properties: expect.objectContaining({ type: { type: "string", const: "select" },
              options: expect.objectContaining({ minItems: 1, maxItems: 50 }) }) }),
          ]) }) }) }),
      ]) } } } });
    }
    request.instruction = "分析销售数据";
    expect(JSON.stringify(harnessToolCatalog({ names: ["createNotebookDraft"], request }))).not.toContain('"const":"parameter"');
    expect(harnessToolCatalog({ names: ["editNotebookCells"], request })[0].description).not.toContain("parameter.type");
  });

  it("计划与 Notebook 参数、顺序和字段保持一致，参数不授予 Dataset 或仓库访问权", () => {
    const { request, context, plan } = fixture();
    const options = { request, allowedDataSourceIds: [], now: context.now, id: context.id };
    const planned = createHarnessAnalysisPlanArtifact(plan, options);
    expect(planned.sourceDataSourceIds).toEqual([]);
    const draft = { name: plan.name, analysisPlanId: planned.id, cells: [parameter, sql, table] };
    expect(createHarnessNotebookArtifact(draft, { ...options, analysisPlan: planned }).lineage).toEqual([
      { cellId: "threshold", dependsOn: [] }, { cellId: "calculation", dependsOn: ["threshold"] },
      { cellId: "display", dependsOn: ["calculation"] },
    ]);
    expect(() => createHarnessNotebookArtifact({ ...draft, cells: [{ ...parameter, parameter: { type: "number", value: 101 } }, sql, table] },
      { ...options, analysisPlan: planned })).toThrow("参数配置与分析计划不一致");
    expect(() => createHarnessNotebookArtifact({ name: "未授权数据", cells: [parameter,
      { id: "foreign", kind: "data", title: "不可见", outputName: "secret", sourceDataSourceId: "foreign" }] }, options)).toThrow("只能使用");
    expect(() => createHarnessNotebookArtifact({ name: "未授权连接", cells: [parameter,
      { id: "foreign", kind: "warehouseSql", title: "不可见", outputName: "secret", connectionId: "foreign", sql: "SELECT 1" }] }, options)).toThrow("未授权");
    expect(() => createHarnessNotebookArtifact({ name: "错误列", cells: [parameter,
      { id: "bad", kind: "table", title: "错误列", inputCellId: "threshold", columns: ["missing"] }] }, options)).toThrow("不存在的字段");
  });

  it("整稿参数必须真实试运行；计划与草稿成功后仍待用户采用", async () => {
    const { context, plan } = fixture();
    context.analysisPlanStore = new Map();
    const planned = (await executeHarnessTool("createAnalysisPlan", plan, context)).analysisPlanArtifact!;
    const draft = { name: plan.name, analysisPlanId: planned.id, cells: [parameter, sql, table] };
    const noRunner = { ...context, notebookRunner: undefined };
    await expect(executeHarnessTool("createNotebookDraft", draft, noRunner)).rejects.toThrow("运行时未配置");
    const result = await executeHarnessTool("createNotebookDraft", draft, context);
    expect(result.notebookArtifact).toMatchObject({ baseRevision: 3, executionEvidence: { status: "success" } });
    expect(context.request.notebookContext!.document.cells).toEqual([]);
    expect(adoptNotebookDraft(context.request.notebookContext!.document, result.notebookArtifact!).cells).toHaveLength(3);
    expect(() => adoptNotebookDraft(context.request.notebookContext!.document,
      { ...result.notebookArtifact!, executionEvidence: undefined })).toThrow("成功试运行证据");
  }, 15000);

  it("参数增量编辑→真实 SQL→提交；改变值使旧回执失效，取消不产生草稿", async () => {
    const { context, request } = fixture();
    const original = structuredClone(request);
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [table, sql, parameter] }, context);
    await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 1 }, context)).rejects.toThrow("尚未完整试运行");
    const run = await executeHarnessTool("runNotebookCells", { editVersion: 1 }, context);
    expect(run.data).toMatchObject({ status: "success", results: expect.arrayContaining([
      expect.objectContaining({ cellId: "display", rows: [{ total: 200 }] }),
    ]) });
    const submitted = await executeHarnessTool("submitNotebookDraft", { editVersion: 1 }, context);
    expect(submitted.notebookArtifact!.executionOrder).toEqual(["threshold", "calculation", "display"]);
    const changed: NotebookCell = { ...parameter, parameter: { type: "number", value: 120 } };
    await executeHarnessTool("editNotebookCells", { editVersion: 1, cells: [changed] }, context);
    await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 2 }, context)).rejects.toThrow("尚未完整试运行");
    expect(request).toEqual(original);
    const controller = new AbortController(); controller.abort(); context.signal = controller.signal;
    await expect(executeHarnessTool("runNotebookCells", { editVersion: 2 }, context)).rejects.toThrow();
    expect(context.notebookCellSession!.run).toBeUndefined();
  }, 15000);

  it("非法单选值拒绝且错误不回显输入；移除被依赖参数仍拒绝", async () => {
    const { context } = fixture();
    await expect(executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [{ ...parameter,
      parameter: { type: "select", value: "sensitive-invalid-value", options: ["ok"] } }] }, context))
      .rejects.toThrow(/parameters?|parameter|参数/u);
    try {
      await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [{ ...parameter,
        parameter: { type: "select", value: "sensitive-invalid-value", options: ["ok"] } }] }, context);
    } catch (error) { expect(String(error)).not.toContain("sensitive-invalid-value"); }
    expect(context.notebookCellSession!.editVersion).toBe(0);
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [parameter, sql] }, context);
    await expect(executeHarnessTool("editNotebookCells", { editVersion: 1, cells: [], removeCellIds: [parameter.id] }, context)).rejects.toThrow();
    expect(context.notebookCellSession!.document.cells).toHaveLength(2);
  });

  it("脚本模型驱动原 Harness 完成参数工具链，保持确认与原文档隔离", async () => {
    const { request, context } = fixture();
    const calls: Array<[HarnessToolName, Record<string, unknown>]> = [["cellSearch", {}],
      ["editNotebookCells", { editVersion: 0, cells: [parameter, sql, table] }],
      ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }]];
    const task = await new DeepSeekHarness().run(request, { dataRuntime: context.dataRuntime, notebookRunner: context.notebookRunner,
      modelClient: { next: async (input) => {
        const [name, args] = calls[input.iteration - 1];
        expect(input.tools.map((tool) => tool.name)).toContain(name);
        return { model: "scripted-parameters", usage: { promptTokens: 30, completionTokens: 30, totalTokens: 60 },
          turn: { type: "callTool", name, arguments: args, toolCallId: `parameter_${input.iteration}`, message: "参数验证" } };
      } } });
    expect(task.state, task.error).toBe("awaitingConfirmation");
    expect(task.verification?.status).toBe("passed");
    expect(task.counters.toolCallCount).toBe(4);
    expect(task.notebookArtifact?.executionEvidence?.status).toBe("success");
    expect(request.notebookContext!.document.cells).toEqual([]);
  }, 15000);
});
