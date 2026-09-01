import { describe, expect, it, vi } from "vitest";
import type { HarnessModel, HarnessModelResult, HarnessObservation, HarnessRequest } from "./contracts";
import {
  buildHarnessContextSelection,
  DeepSeekHarness,
  estimateHarnessModelInputChars,
  executeHarnessTool,
  harnessToolCatalog,
} from "./index";
import { demoFixtureResult } from "@/fixtures/demo-product";

function fixtures() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return structuredClone(demoFixtureResult.data);
}

function request(instruction = "检查 retail_orders 数据集的基本信息，并将‘本月收入’标题改为‘月度总收入’，不要应用"): HarnessRequest {
  const data = fixtures();
  return {
    idempotencyKey: "request_context_budget",
    instruction,
    pageId: "page_home",
    appSpec: data.dataProduct.appSpec,
    recipes: data.dataProduct.recipes,
    role: "editor",
  };
}

describe("Harness 最小上下文选择器", () => {
  it("首轮只发送当前任务需要的页面摘要、数据目录和单个动态工具", () => {
    const input = request();
    const selection = buildHarnessContextSelection(input, [], 1);
    const tools = harnessToolCatalog({
      names: selection.toolNames,
      editableNodes: selection.editableNodes,
      instruction: input.instruction,
    });
    const serialized = JSON.stringify({ ...selection.context, tools });

    expect(selection.toolNames).toEqual(["inspectDataset"]);
    expect(tools).toHaveLength(1);
    expect(serialized).toContain("page_home_revenue");
    expect(serialized).toContain("dataset_retail_orders");
    expect(serialized).not.toContain("order_1_1");
    expect(serialized).not.toContain("nav_home");
    expect(serialized).not.toContain('"navigation"');
    expect(serialized.length).toBeLessThan(JSON.stringify(input.appSpec).length);
  });

  it("第二轮只保留目标、紧凑观察和当前后续工具，不重复首轮目录", async () => {
    const input = request();
    const data = fixtures();
    const result = await executeHarnessTool("inspectDataset", { dataSourceId: "dataset_retail_orders" }, {
      request: input,
      dataRuntime: data.dataRuntime,
      now: () => 1,
      id: () => "context_test",
    });
    const observations: HarnessObservation[] = [{
      toolCallId: "inspect_once",
      toolName: "inspectDataset",
      summary: result.summary,
      data: result.data,
    }];
    const first = buildHarnessContextSelection(input, [], 1);
    const second = buildHarnessContextSelection(input, observations, 2);
    const firstTools = harnessToolCatalog({ names: first.toolNames, editableNodes: first.editableNodes, instruction: input.instruction });
    const secondTools = harnessToolCatalog({ names: second.toolNames, editableNodes: second.editableNodes, instruction: input.instruction });
    const secondSerialized = JSON.stringify({ ...second.context, tools: secondTools });
    const totalChars = estimateHarnessModelInputChars(first.context, firstTools, 1)
      + estimateHarnessModelInputChars(second.context, secondTools, 2);

    expect(second.toolNames).toEqual(["createChangeSetPreview"]);
    expect(secondTools).toHaveLength(1);
    expect(second.editableNodes.map((node) => node.nodeId)).toEqual(["page_home_revenue"]);
    expect(secondSerialized).toContain("page_home_revenue");
    expect(secondSerialized).toContain("月度总收入");
    expect(secondSerialized).not.toContain("supportedAggregations");
    expect(secondSerialized).not.toContain("order_id");
    expect(secondSerialized).not.toContain("recipe_east_anomalies");
    expect(secondSerialized).not.toContain("page_home_customers");
    expect(secondSerialized).not.toContain('"datasets"');
    expect(totalChars).toBeLessThan(6_000);
    expect(Math.ceil(totalChars / 2)).toBeLessThan(8_000);

    const compactedFirst = buildHarnessContextSelection(input, [], 1, true);
    const compactedTools = harnessToolCatalog({ names: compactedFirst.toolNames, editableNodes: compactedFirst.editableNodes, instruction: input.instruction });
    expect(estimateHarnessModelInputChars(compactedFirst.context, compactedTools, 1))
      .toBeLessThan(estimateHarnessModelInputChars(first.context, firstTools, 1));
  });

  it("上下文超限时在模型调用前安全失败", async () => {
    const data = fixtures();
    const next = vi.fn<() => Promise<HarnessModelResult>>();
    const model: HarnessModel = { next };
    const task = await new DeepSeekHarness().run(request("检查 retail_orders 数据集"), {
      dataRuntime: data.dataRuntime,
      modelClient: model,
      contextBudget: { maxRequestInputChars: 10 },
    });

    expect(task.state).toBe("failed");
    expect(task.error).toContain("上下文");
    expect(task.counters.modelCallCount).toBe(0);
    expect(next).not.toHaveBeenCalled();
  });
});
