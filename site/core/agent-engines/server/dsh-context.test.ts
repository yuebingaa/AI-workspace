import { describe, expect, it, vi } from "vitest";
import { harnessRequestSchema } from "@/core/harness/contracts";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { buildDshContext } from "./dsh-context";
import { DEFAULT_DSH_EXECUTION_POLICY } from "./execution-policy";

// A runtime dependency on the old planner would fail these tests immediately.
vi.mock("@/core/harness/context-selector", () => { throw new Error("DSH must not load the original planner"); });

function fixture() {
  const { product, source, model } = semanticFixture();
  const request = harnessRequestSchema.parse({ idempotencyKey: "dsh_context_independent", role: "editor", pageId: "page_home",
    instruction: "请解释目前的数据", dataSourceId: source.id, appSpec: product.appSpec, recipes: [], semanticModel: model,
    notebookContext: { sourceIds: [source.id], selectedCellIds: ["data"], document: { name: "独立上下文", revision: 7,
      cells: [{ id: "data", kind: "data", title: "销售表", sourceDataSourceId: source.id, outputName: "sales_data" },
        { id: "private_code", kind: "sql", title: "源码按需读取", inputCellIds: ["data"], outputName: "computed",
          sql: "SELECT 'CODE_MUST_BE_READ_WITH_A_TOOL' FROM sales_data" }] },
      connections: [{ id: "visible_connection", name: "已授权", kind: "postgresql", allowAi: true },
        { id: "hidden_connection", name: "HIDDEN_CONNECTION_LABEL", kind: "postgresql", allowAi: false }] },
    conversationContext: { recentMessages: [{ instruction: "说明".repeat(410) + "重要约定在问题末尾",
      response: "历史".repeat(810) + "重要约定在回答末尾" }], summary: "摘要".repeat(900),
      previousInstruction: "继续同一任务", previousAssistantMessage: "前轮说明".repeat(400),
      selectedContext: [source.id], taskHistory: [{ id: "prior_task", state: "completed", goal: "上一轮目标" }] },
  });
  const build = (value = request) => buildDshContext({ request: value, capabilities: { python: { enabled: false, reason: "当前未启用" } },
    existingAnalysis: false, budget: { ...DEFAULT_DSH_EXECUTION_POLICY, toolCallsUsed: 0, toolCallsRemaining: null, remainingMs: null } });
  return { request, source, build };
}

describe("DSH environment without Harness planning", () => {
  it("does not advertise the retired execution or answer quotas", () => {
    const { build } = fixture(), context = build();
    expect(context.executionBudget).toMatchObject({ maxToolCalls: null, toolCallTimeoutMs: null,
      totalExecutionTimeoutMs: null, remainingMs: null, toolCallsRemaining: null });
    expect(JSON.stringify(context)).not.toMatch(/不超过1600字|180000|35000/);
  });
  it("preserves authorized schema even when phrasing does not match old data intent rules", () => {
    const { request, source, build } = fixture(); request.instruction = "继续照上面的口径办";
    const context = build();
    expect(context.datasets).toEqual([expect.objectContaining({ id: source.id, fields: source.fields })]);
    expect(context).not.toHaveProperty("workingMemory");
    expect(context).not.toHaveProperty("plan");
    expect(context).not.toHaveProperty("allowedTools");
    expect(context).not.toHaveProperty("appSpec");
    expect(context).not.toHaveProperty("completion");
  });
  it("passes complete bounded recent turns, including their important endings", () => {
    const { request, build } = fixture();
    expect(build().recentConversation).toMatchObject(request.conversationContext!);
  });
  it("redacts secrets before any display cut without removing later ordinary context", () => {
    const { request, build } = fixture();
    request.conversationContext!.recentMessages![0].response = "前文".repeat(510) + " Bearer synthetic-secret-012345 后续约定保留";
    request.conversationContext!.summary = "sk-synthetic-secret-012345";
    const serialized = JSON.stringify(build());
    expect(serialized).not.toContain("synthetic-secret-012345");
    expect(serialized).toContain("后续约定保留");
    expect(serialized).toContain("[已脱敏]");
  });
  it("does not leak unselected datasets, connections, full SQL or data samples", () => {
    const { request, source, build } = fixture();
    request.appSpec.dataSources.push({ ...structuredClone(source), id: "private_source", name: "HIDDEN_DATASET_LABEL" });
    const serialized = JSON.stringify(build());
    for (const forbidden of ["HIDDEN_DATASET_LABEL", "hidden_connection", "HIDDEN_CONNECTION_LABEL", "CODE_MUST_BE_READ_WITH_A_TOOL", '"amount":100']) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).toContain("visible_connection");
    expect(build().notebook).toMatchObject({ baseRevision: 7, totalCells: 2, selection: { status: "declared", cells: [{ id: "data" }] } });
  });
  it("never includes a pending source or a semantic model outside the selected source scope", () => {
    const { request, source, build } = fixture();
    request.appSpec.dataSources.find(item => item.id === source.id)!.aiAccessPolicy = "pending";
    request.semanticModel!.sourceDatasetId = "outside_scope";
    expect(build().datasets).toEqual([]);
    expect(build()).not.toHaveProperty("semanticModel");
  });
  it("builds detached facts rather than a second mutable source of truth", () => {
    const { request, build } = fixture(), before = structuredClone(request);
    const context = build();
    Reflect.set(context, "datasets", []);
    // Mutate nested metadata through reflection to verify isolation without a cast.
    const original = build();
    if (!Array.isArray(original.datasets)) throw new Error("Expected source catalog");
    original.datasets[0].fields[0].supportedAggregations.push("test_only_mutation");
    expect(request).toEqual(before);
  });
  it.each([false, true])("retains explicit readonly bounds (allowRun=%s)", allowRun => {
    const { request } = fixture();
    const context = buildDshContext({ request, capabilities: { python: { enabled: false } },
      readonlyMode: { allowRun, requireOutput: allowRun }, existingAnalysis: false,
      budget: { ...DEFAULT_DSH_EXECUTION_POLICY, toolCallsUsed: 0, toolCallsRemaining: null, remainingMs: null } });
    expect(context.completion).toMatchObject({ mode: "readonly_answer", allowRun, requireOutput: allowRun });
    expect(context.executionPolicy).toContain("不编辑、提交或修改正式文档");
  });
  it("keeps memory labelled historical, not invented current verified facts", () => {
    const { request, build } = fixture();
    request.conversationContext!.workingMemory = { goal: "前轮目标", iteration: 1, confirmedDataSources: [], confirmedFields: [],
      completedTools: [], completedSteps: ["之前运行过"], keyStatistics: ["历史结果不是本轮证据"], pendingGoals: ["继续比较"],
      failedAttempts: [], missingCapabilities: [] };
    expect(build().continuityMemory).toMatchObject({ trust: "conversationContinuityOnly", previousGoal: "前轮目标",
      rememberedStatistics: ["历史结果不是本轮证据"], pendingGoals: ["继续比较"] });
    expect(build()).not.toHaveProperty("workingMemory");
  });
});
