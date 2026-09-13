import { describe, expect, it } from "vitest";
import type { AppNode, BarChartProps } from "@/core/models";
import { harnessPublicRequestSchema, type HarnessTaskSummary, type HarnessModelTurn } from "@/core/harness/contracts";
import { DeepSeekHarness } from "@/core/harness/deepseek-harness";
import { buildHarnessContextSelection } from "@/core/harness/context-selector";
import { harnessToolCatalog } from "@/core/harness/tool-registry";
import { demoLocalDataRuntime } from "@/fixtures/retail-orders";
import { caseForInstruction, createLabAppSpec, createLabRequest, LAB_PAGE_ID, LAB_CHART_CONTAINER_ID, visualizationCases } from "./cases";
import { evaluateLabTask } from "./evaluate";

function node(overrides: Partial<BarChartProps> = {}): AppNode {
  return { id: "chart_lab_test", type: "BarChart", props: { title: "月度收入", subtitle: "人民币元", chartType: "line",
    binding: { dataSourceId: "dataset_retail_orders", field: "revenue", aggregation: "sum", groupBy: "month", filters: [],
      sort: [{ field: "month", direction: "asc" }], limit: 12, format: { style: "currency", currency: "CNY", decimals: 2 } }, ...overrides } };
}
function task(chart: AppNode = node()): HarnessTaskSummary {
  return { id: "harness_test_visualization", idempotencyKey: "test_visualization", instruction: visualizationCases[0].prompt,
    pageId: LAB_PAGE_ID, role: "editor", state: "awaitingConfirmation", createdAt: "2026-09-13T00:00:00.000Z", updatedAt: "2026-09-13T00:00:00.000Z",
    events: [], counters: { loopCount: 1, modelCallCount: 1, toolCallCount: 1 }, pendingChangeSet: { id: "change_lab", title: "图表预览", status: "ready",
      operations: [{ id: "op_chart", label: "添加图表", description: "月度收入趋势", type: "addNode", pageId: LAB_PAGE_ID, parentId: LAB_CHART_CONTAINER_ID, node: chart }] } };
}
const failures = (value: HarnessTaskSummary) => evaluateLabTask(value, visualizationCases[0]).checks.filter((check) => check.status === "failed");

describe("visualization lab", () => {
  it("uses an empty, isolated app and only synthetic data, with no prior conversation", () => {
    const request = harnessPublicRequestSchema.parse(createLabRequest(visualizationCases[0].prompt, "lab_request_123"));
    expect(request.appSpec.pages).toHaveLength(1);
    expect(request.appSpec.pages[0].root.children).toEqual([{ id: LAB_CHART_CONTAINER_ID, type: "DashboardGrid", props: {}, children: [] }]);
    expect(request.recipes).toEqual([]);
    expect(request.conversation_id).toBeUndefined();
    expect(request.appSpec.dataSources.map((source) => source.id)).toEqual(["dataset_retail_orders"]);
    request.appSpec.pages[0].title = "changed";
    expect(createLabAppSpec().pages[0].title).toBe("可视化测试画布");
  });

  it("independently checks a correct generated chart, leaves visual quality to review", () => {
    const result = evaluateLabTask(task(), visualizationCases[0]);
    expect(result.checks.filter((check) => check.status === "failed")).toEqual([]);
    expect(result.chartIds).toEqual(["chart_lab_test"]);
    expect(result.checks.at(-1)?.status).toBe("manual");
  });

  it("rejects plausible but wrong chart types, averages, missing groups and ordering", () => {
    expect(failures(task(node({ chartType: "bar" })))).toEqual(expect.arrayContaining([expect.objectContaining({ id: "type-chart_lab_test" })]));
    const correct = node(); if (correct.type !== "BarChart") throw new Error("chart");
    expect(failures(task(node({ binding: { ...correct.props.binding, aggregation: "average" } })))).toEqual(expect.arrayContaining([expect.objectContaining({ id: "values-chart_lab_test" })]));
    expect(failures(task(node({ binding: { ...correct.props.binding, limit: 5 } })))).toEqual(expect.arrayContaining([expect.objectContaining({ id: "values-chart_lab_test" })]));
    expect(failures(task(node({ binding: { ...correct.props.binding, sort: [{ field: "month", direction: "desc" }] } })))).toEqual(expect.arrayContaining([expect.objectContaining({ id: "order-chart_lab_test" })]));
  });

  it("does not pass successful prose without a chart or a failed task with a leftover candidate", () => {
    const noChart = task(); delete noChart.pendingChangeSet; noChart.state = "completed"; noChart.resultMessage = "已生成完美折线图";
    expect(failures(noChart)[0].id).toBe("receipt");
    expect(failures({ ...task(), state: "failed" })[0].id).toBe("receipt");
  });

  it("rejects cross-page changes and invalid sources without mutating the formal app", () => {
    const original = createLabAppSpec(); const before = JSON.stringify(original);
    const outside = task(); outside.pendingChangeSet!.operations[0].pageId = "page_home";
    expect(evaluateLabTask(outside, visualizationCases[0]).preview).toBeUndefined();
    const chart = node(); if (chart.type !== "BarChart") throw new Error("chart");
    chart.props.binding.dataSourceId = "private_dataset";
    expect(evaluateLabTask(task(chart), visualizationCases[0]).preview).toBeUndefined();
    expect(JSON.stringify(original)).toBe(before);
  });

  it("never applies preset answers to edited prompts", () => {
    expect(caseForInstruction("monthly-line", visualizationCases[0].prompt)).toBeDefined();
    expect(caseForInstruction("monthly-line", "改成每月平均收入")).toBeUndefined();
    const custom = evaluateLabTask(task(), undefined);
    expect(custom.checks.find((check) => check.id.startsWith("values-"))).toBeUndefined();
    expect(custom.checks.at(-1)?.detail).toContain("没有标准答案");
  });

  it("gives the model a valid chart insertion target and allows unfiltered data", () => {
    const request = { ...createLabRequest(visualizationCases[0].prompt, "lab_catalog"), role: "editor" as const };
    const selection = buildHarnessContextSelection(request, [], 1);
    const catalog = harnessToolCatalog({ names: ["createChangeSetPreview"], request, instruction: request.instruction, editableNodes: selection.editableNodes });
    const schema = catalog[0].parameters as { properties: { operations: { items: { properties: {
      type: { enum: string[] }; parentId: { enum: string[] }; node: { properties: { props: { properties: {
        binding: { properties: { filters: { minItems: number } } }
      } } } }
    } } } } };
    const operation = schema.properties.operations.items.properties;
    expect(operation.type.enum).toEqual(["addNode"]);
    expect(operation.parentId.enum).toEqual([LAB_CHART_CONTAINER_ID]);
    expect(operation.node.properties.props.properties.binding.properties.filters.minItems).toBe(0);
  });

  it("runs the actual Harness and preview tool with a scripted model", async () => {
    const request = createLabRequest(visualizationCases[0].prompt, "lab_integration_123");
    const inputs: string[] = [];
    const turns: HarnessModelTurn[] = [
      { type: "callTool", name: "inspectDataset", toolCallId: "lab_inspect", arguments: { dataSourceId: "dataset_retail_orders" }, message: "检查数据" },
      { type: "callTool", name: "createChangeSetPreview", toolCallId: "lab_chart", arguments: { message: "图表预览已生成", operations: [{ type: "addNode", pageId: LAB_PAGE_ID, parentId: LAB_CHART_CONTAINER_ID, node: node() }] }, message: "生成图表" },
      { type: "complete", message: "已生成预览" },
    ];
    const response = await new DeepSeekHarness().run({ ...request, role: "editor" }, { dataRuntime: demoLocalDataRuntime,
      modelClient: { next: async (input) => { inputs.push(JSON.stringify(input.context)); const turn = turns.shift(); if (!turn) throw new Error("No scripted turn"); return { turn, model: "scripted-lab-integration", usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 } }; } } });
    expect(response.state, response.error ?? response.resultMessage).toBe("awaitingConfirmation");
    expect(failures(response)).toEqual([]);
    expect(inputs.length).toBeGreaterThan(0);
    expect(request.appSpec.pages[0].root.children?.[0].children).toEqual([]);
  });
});
