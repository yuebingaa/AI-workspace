import { describe, expect, it } from "vitest";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { runNotebook } from "@/core/notebook/server/runtime";
import type { NotebookCell } from "@/core/notebook/definition";
import { adoptNotebookDraft, notebookFingerprint } from "@/core/notebook/client-state";
import { buildNotebookSearchIndex } from "@/core/notebook/search";
import { analyzeNotebookOutputRenames } from "@/core/notebook/output-renames";
import { createHarnessAnalysisPlanArtifact } from "./analysis-planner";
import { harnessAnalysisPlanDraftSchema, type HarnessAnalysisPlanDraft } from "./analysis-plan-contracts";
import { createHarnessNotebookArtifact } from "./notebook";
import { buildHarnessContextSelection } from "./context-selector";
import { executeHarnessTool, harnessToolCatalog, type HarnessToolContext } from "./tool-registry";
import type { HarnessRequest, HarnessToolName } from "./contracts";
import { DeepSeekHarness } from "./deepseek-harness";

const parameter: Extract<NotebookCell, { kind: "parameter" }> = { id: "amount", kind: "parameter", title: "金额参数",
  outputName: "amount", parameter: { type: "number", value: 250 } };
const sql: Extract<NotebookCell, { kind: "sql" }> = { id: "summary", kind: "sql", title: "两倍金额",
  outputName: "totals", inputCellIds: [parameter.id], sql: "SELECT value * 2 AS total FROM amount" };
const text: Extract<NotebookCell, { kind: "text" }> = { id: "note", kind: "text", title: "动态说明",
  markdown: "金额：{{amount}}；计算结果：{{total}}。", references: [
    { key: "amount", cellId: parameter.id, field: "value" }, { key: "total", cellId: sql.id, field: "total" },
  ] };
const expectedText = "金额：250；计算结果：500。";

function fixture() {
  const { product } = semanticFixture(); product.appSpec.dataSources = [];
  const request: HarnessRequest = { idempotencyKey: "text_reference_test", instruction: "创建参数、SQL单元和引用结果的文本说明",
    role: "editor", pageId: "page_home", appSpec: product.appSpec, recipes: [],
    notebookContext: { sourceIds: [], document: { name: "引用验证", revision: 2, cells: [] } } };
  const context: HarnessToolContext = { request, now: Date.now, id: () => crypto.randomUUID(), dataRuntime: { rowsByDataSourceId: {} },
    notebookCellSession: { document: structuredClone(request.notebookContext!.document), editVersion: 0 },
    notebookRunner: (artifact, ctx) => runNotebook({ document: { name: artifact.name, revision: artifact.baseRevision ?? 2, cells: artifact.cells },
      sources: [], forAi: true, signal: ctx.signal, log: () => {} }),
  };
  const plan: HarnessAnalysisPlanDraft = { name: "受控文本计划", objective: "显示金额与两倍结果", questions: ["结果是多少"],
    deliverables: ["narrative"], steps: [
      { id: parameter.id, kind: "parameter", title: parameter.title, objective: "提供金额", parameter: parameter.parameter, dependsOn: [] },
      { id: sql.id, kind: "sql", title: sql.title, objective: "计算两倍", transformation: "将金额乘二", dependsOn: [parameter.id] },
      { id: text.id, kind: "text", title: text.title, objective: "显示真实结果", narrativeGoal: "引用金额与计算结果", dependsOn: [parameter.id, sql.id], references: text.references },
    ] };
  return { request, context, plan };
}

describe("controlled text in existing Agent paths", () => {
  it("keeps static plans compatible and requires exact declared reference dependencies", () => {
    const { plan } = fixture();
    expect(harnessAnalysisPlanDraftSchema.parse(plan)).toEqual(plan);
    const note = plan.steps[2]; expect(note.kind).toBe("text");
    expect(harnessAnalysisPlanDraftSchema.safeParse({ ...plan, steps: [...plan.steps.slice(0, 2), { ...note, dependsOn: [] }] }).success).toBe(false);
    expect(harnessAnalysisPlanDraftSchema.safeParse({ ...plan, steps: [...plan.steps.slice(0, 2), { ...note, dependsOn: [parameter.id, parameter.id] }] }).success).toBe(false);
    expect(harnessAnalysisPlanDraftSchema.safeParse({ ...plan, steps: [...plan.steps.slice(0, 2), { ...note, dependsOn: [], references: undefined }] }).success).toBe(true);
  });

  it("plan and notebook use the same bindings; known missing fields and changed plan fields reject", () => {
    const { request, plan } = fixture(); const options = { request, allowedDataSourceIds: [], now: Date.now, id: () => "reference" };
    const artifact = createHarnessAnalysisPlanArtifact(plan, options);
    const draft = { name: "引用", analysisPlanId: artifact.id, cells: [parameter, sql, text] };
    expect(createHarnessNotebookArtifact(draft, { ...options, analysisPlan: artifact }).lineage.at(-1)).toEqual({ cellId: text.id, dependsOn: [parameter.id, sql.id] });
    expect(() => createHarnessNotebookArtifact({ ...draft, cells: [parameter, sql, { ...text,
      references: [{ key: "amount", cellId: parameter.id, field: "value" }, { key: "total", cellId: sql.id, field: "other" }] }] }, { ...options, analysisPlan: artifact })).toThrow("文本引用与分析计划不一致");
    const invalid = structuredClone(plan); const note = invalid.steps[2];
    if (note.kind !== "text") throw new Error("Fixture kind");
    note.references![0].field = "missing";
    expect(() => createHarnessAnalysisPlanArtifact(invalid, options)).toThrow("不存在的字段");
    expect(() => createHarnessNotebookArtifact({ name: "invalid", cells: [parameter, { ...text, markdown: "{{amount}}",
      references: [{ key: "amount", cellId: parameter.id, field: "missing" }] }] }, options)).toThrow("不存在的字段");
  });

  it("incremental tools perform a real parameter/SQL/text run, return bounded text, and await adoption", async () => {
    const { context, request } = fixture();
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [text, sql, parameter] }, context);
    const result = await executeHarnessTool("runNotebookCells", { editVersion: 1 }, context);
    expect(result.data).toMatchObject({ status: "success", textResults: [{ cellId: text.id, text: expectedText, truncated: false, characterCount: expectedText.length }] });
    expect(context.notebookCellSession!.run!.cells.map((cell) => cell.cellId)).toEqual([parameter.id, sql.id, text.id]);
    expect(context.notebookCellSession!.run!.cells.at(-1)).toMatchObject({ status: "success", text: expectedText });
    expect(context.notebookCellSession!.run!.cells.at(-1)).not.toHaveProperty("table");
    const submitted = await executeHarnessTool("submitNotebookDraft", { editVersion: 1 }, context);
    expect(submitted.notebookArtifact?.lineage.find((entry) => entry.cellId === text.id)?.dependsOn).toEqual([parameter.id, sql.id]);
    expect(request.notebookContext!.document.cells).toEqual([]);
    expect(adoptNotebookDraft(request.notebookContext!.document, submitted.notebookArtifact!).cells).toHaveLength(3);
    const observations = [{ toolName: "runNotebookCells" as const, toolCallId: "text_run", summary: result.summary, data: result.data }];
    for (const iteration of [0, 20]) expect(JSON.stringify(buildHarnessContextSelection(request, observations, iteration))).toContain(expectedText);
  });

  it("whole-plan generation returns the same computed text and does not auto-adopt", async () => {
    const { plan, context, request } = fixture(); context.analysisPlanStore = new Map();
    await executeHarnessTool("createAnalysisPlan", plan, context);
    const artifact = [...context.analysisPlanStore.values()][0];
    const result = await executeHarnessTool("createNotebookDraft", { name: "文本说明", analysisPlanId: artifact.id, cells: [parameter, sql, text] }, context);
    expect(result.data).toMatchObject({ textResults: [{ cellId: text.id, text: expectedText, truncated: false }], execution: { status: "success" } });
    expect(result.notebookArtifact?.status).toBe("draft"); expect(request.notebookContext!.document.cells).toEqual([]);
  });

  it("a data/text-only draft now needs a real runner; old static text still does not", async () => {
    const { product, source, rows } = semanticFixture(); const { context } = fixture();
    context.request.appSpec = product.appSpec; context.request.dataSourceId = source.id;
    context.request.notebookContext!.sourceIds = [source.id]; context.dataRuntime = { rowsByDataSourceId: { [source.id]: rows } };
    context.notebookRunner = undefined;
    const data: NotebookCell = { id: "source", kind: "data", title: "数据", sourceDataSourceId: source.id, outputName: "source" };
    const note: NotebookCell = { ...text, markdown: "{{one}}", references: [{ key: "one", cellId: data.id, field: source.fields[0].name }] };
    await expect(executeHarnessTool("createNotebookDraft", { name: "未执行", cells: [data, note] }, context)).rejects.toThrow("文本引用运行时未配置");
    const result = await executeHarnessTool("createNotebookDraft", { name: "静态", cells: [data, { ...note, references: undefined, markdown: "{{literal}}" }] }, context);
    expect(result.notebookArtifact?.executionEvidence).toBeUndefined();
    const dynamic = createHarnessNotebookArtifact({ name: "需运行", cells: [data, note] }, { request: context.request, allowedDataSourceIds: [source.id], now: Date.now, id: () => "new" });
    dynamic.baseRevision = 2;
    expect(() => adoptNotebookDraft(context.request.notebookContext!.document, dynamic)).toThrow("文本引用草稿缺少成功试运行证据");
  });

  it("unknown SQL fields fail the real run; stale text and failed drafts cannot be submitted", async () => {
    const { context } = fixture();
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [parameter, sql, text] }, context);
    await executeHarnessTool("runNotebookCells", { editVersion: 1 }, context);
    const badText: NotebookCell = { ...text, references: [{ key: "amount", cellId: parameter.id, field: "value" }, { key: "total", cellId: sql.id, field: "missing" }] };
    await executeHarnessTool("editNotebookCells", { editVersion: 1, cells: [badText] }, context);
    expect(context.notebookCellSession!.run).toBeUndefined();
    const failed = await executeHarnessTool("runNotebookCells", { editVersion: 2 }, context);
    expect(failed.data).toMatchObject({ status: "failure", errors: [{ cellId: text.id, status: "failure" }] });
    expect(failed.data).not.toHaveProperty("textResults");
    await expect(executeHarnessTool("submitNotebookDraft", { editVersion: 2 }, context)).rejects.toThrow("尚未完整试运行通过");
  });

  it("rejects a runner claiming success without the new required text receipt", async () => {
    const { context } = fixture(); const original = context.notebookRunner!;
    context.notebookRunner = async (artifact, ctx) => {
      const result = await original(artifact, ctx);
      if (!result) throw new Error("Missing fixture result");
      result.cells.forEach((cell) => { delete cell.text; }); return result;
    };
    await executeHarnessTool("editNotebookCells", { editVersion: 0, cells: [parameter, sql, text] }, context);
    await expect(executeHarnessTool("runNotebookCells", { editVersion: 1 }, context)).rejects.toThrow("回执与本次草稿不一致");
    expect(context.notebookCellSession!.runVersion).toBeUndefined();
  });

  it("stable Cell IDs preserve reference lineage after output rename and invalidate only related text", () => {
    const before = { name: "引用", revision: 1, cells: [parameter, sql, text] };
    const renamed = { ...sql, outputName: "renamed" }; const after = { ...before, revision: 2, cells: [parameter, renamed, text] };
    expect(buildNotebookSearchIndex(after).byId.get(text.id)?.inputs.map((input) => input.variable)).toEqual(["amount", "renamed"]);
    expect(analyzeNotebookOutputRenames(before.cells, after.cells)).not.toEqual([]);
    expect(notebookFingerprint(before, text.id, [], [])).not.toBe(notebookFingerprint(after, text.id, [], []));
    expect(text.references![1].cellId).toBe(sql.id);
  });

  it("tool schema and instructions expose references without an expression executor", () => {
    const { request } = fixture();
    for (const name of ["createAnalysisPlan", "createNotebookDraft", "editNotebookCells"] as const) {
      const [tool] = harnessToolCatalog({ names: [name], request });
      expect(tool.description).toContain("不执行表达式");
      const schema = JSON.stringify(tool.parameters); expect(schema).toContain('"references"'); expect(schema).toContain('"maxItems":10');
    }
  });

  it("a scripted model uses real tools and SQL to submit a text draft, not change the project", async () => {
    const { request, context } = fixture();
    const calls: Array<[HarnessToolName, Record<string, unknown>]> = [["cellSearch", {}],
      ["editNotebookCells", { editVersion: 0, cells: [parameter, sql, text] }], ["runNotebookCells", { editVersion: 1 }], ["submitNotebookDraft", { editVersion: 1 }]];
    const task = await new DeepSeekHarness().run(request, { dataRuntime: context.dataRuntime, notebookRunner: context.notebookRunner,
      modelClient: { next: async (input) => {
        const [name, args] = calls[input.iteration - 1];
        expect(input.tools.map((tool) => tool.name)).toContain(name);
        return { model: "scripted-text-reference", usage: { promptTokens: 20, completionTokens: 20, totalTokens: 40 },
          turn: { type: "callTool", name, arguments: args, toolCallId: `text_${input.iteration}`, message: "受控文本验证" } };
      } } });
    expect(task.state).toBe("awaitingConfirmation");
    expect(task.notebookArtifact?.cells.find((cell) => cell.id === text.id)).toEqual(text);
    expect(task.verification?.status).toBe("passed");
    expect(task.counters.toolCallCount).toBe(4);
    expect(request.notebookContext!.document.cells).toEqual([]);
  }, 15000);
});
