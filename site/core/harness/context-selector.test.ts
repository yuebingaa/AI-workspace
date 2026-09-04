import { describe, expect, it, vi } from "vitest";
import type { HarnessModel, HarnessModelResult, HarnessObservation, HarnessRequest } from "./contracts";
import {
  buildHarnessContextSelection,
  classifyHarnessTask,
  DeepSeekHarness,
  estimateHarnessModelInputChars,
  executeHarnessTool,
  harnessToolCatalog,
  harnessSystemPrompt,
  resolveHarnessContextBudget,
  resolveHarnessPageDataSourceIds,
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
  it("模型提示词与顶层判别联合协议完全一致", () => {
    for (const iteration of [1, 2]) {
      const prompt = harnessSystemPrompt(iteration);
      expect(prompt).toContain('{"type":"callTool","message":"检查","toolCallId":"c1","name":"inspectDataset","arguments":{}}');
      expect(prompt).toContain('{"type":"complete","message":"根据工具结果，数据共48行；建议优先检查退款异常。"}');
      expect(prompt).toContain('{"type":"blocked","message":"受阻","missingRequirements":["字段"]}');
      expect(prompt).toContain("一次一种动作");
      expect(prompt).toContain("禁止Markdown");
      expect(prompt).toContain("interactionMode为conversation时必须complete");
      if (iteration > 1) expect(prompt).toContain("禁止仅写“完成”或“已完成”");
      expect(prompt).not.toContain('"action"');
    }
  });

  it("从客户洞察页面绑定发现 retail_orders，并仅提供当前步骤所需工具", () => {
    const input = { ...request("检查销售数据，找出异常订单，并生成复购率指标。"), pageId: "page_customers" };
    const selection = buildHarnessContextSelection(input, [], 1);
    const tools = harnessToolCatalog({
      names: selection.toolNames,
      editableNodes: selection.editableNodes,
      instruction: input.instruction,
      request: input,
    });
    const serialized = JSON.stringify({ ...selection.context, tools });

    expect(resolveHarnessPageDataSourceIds(input)).toEqual(["dataset_retail_orders"]);
    expect(classifyHarnessTask(input)).toEqual({ complexity: "multiStep", maxModelCalls: 4, maxToolCalls: 6 });
    expect(selection.toolNames).toEqual(["inspectDataset"]);
    expect(serialized).toContain("retail_orders");
    expect(serialized).toContain("page_customers_metrics");
    expect(serialized).not.toContain("order_1_1");
    expect(serialized).not.toContain('"appSpec"');
    const compacted = buildHarnessContextSelection(input, [], 1, true);
    const compactedTools = harnessToolCatalog({
      names: compacted.toolNames,
      editableNodes: compacted.editableNodes,
      instruction: input.instruction,
      request: input,
    });
    expect(estimateHarnessModelInputChars(compacted.context, compactedTools, 1)).toBeLessThanOrEqual(10_000);
  });

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

  it("模型语义观察不受配方步骤实际耗时影响", () => {
    const input = { ...request("执行华东异常订单配方预览，不要修改页面。"), pageId: "page_customers" };
    const observation = (durationMs: number): HarnessObservation => ({
      toolCallId: "recipe_preview",
      toolName: "previewDataRecipe",
      summary: "配方执行成功",
      data: {
        outputRowCount: 4,
        fields: [{ name: "region", type: "string" }],
        steps: [{
          stepId: "filter_east",
          stepType: "filter",
          inputRowCount: 48,
          outputRowCount: 12,
          durationMs,
        }],
        lineage: { region: { sourceFields: ["region"], stepIds: ["filter_east"] } },
      },
    });
    const fast = buildHarnessContextSelection(input, [observation(1)], 2);
    const slow = buildHarnessContextSelection(input, [observation(9_999)], 2);
    const fastTools = harnessToolCatalog({ names: fast.toolNames, editableNodes: fast.editableNodes, instruction: input.instruction, request: input });
    const slowTools = harnessToolCatalog({ names: slow.toolNames, editableNodes: slow.editableNodes, instruction: input.instruction, request: input });

    expect(fast.context).toEqual(slow.context);
    expect(estimateHarnessModelInputChars(fast.context, fastTools, 2))
      .toBe(estimateHarnessModelInputChars(slow.context, slowTools, 2));
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
    expect(task.error).toContain("模型输入");
    expect(task.counters.modelCallCount).toBe(0);
    expect(next).not.toHaveBeenCalled();
  });

  it("上下文预算只能收紧而不能放宽硬上限", () => {
    expect(() => resolveHarnessContextBudget({ maxTotalPromptTokens: 8_001 }))
      .toThrow(/上下文预算无效/);
    expect(() => resolveHarnessContextBudget({ maxToolResultEntries: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow(/上下文预算无效/);
  });

  it("简单只读任务使用较低调用和上下文预算", () => {
    const input = request("检查 retail_orders 数据集是否可用，返回行数和列数。不要修改页面。");
    expect(classifyHarnessTask(input)).toEqual({ complexity: "simpleReadOnly", maxModelCalls: 2, maxToolCalls: 2 });
  });

  it("闲聊短句保留最近对话并进入 conversation，而不是伪装成缺少数据的任务", () => {
    const input = {
      ...request("额"),
      conversationContext: {
        previousInstruction: "分析一下数据",
        previousAssistantMessage: "夜班异常次数高于白班。",
      },
    };
    const selection = buildHarnessContextSelection(input, [], 1);

    expect(selection.toolNames).toEqual([]);
    expect(selection.blockingReason).toBeUndefined();
    expect(selection.context).toMatchObject({
      interactionMode: "conversation",
      recentConversation: input.conversationContext,
    });
  });

  it("仅在配方成功预览后动态暴露 Excel 导出工具", () => {
    const input = { ...request("整理华东异常订单，创建复购分析，并提供 Excel 下载。"), pageId: "page_customers" };
    const observations: HarnessObservation[] = [
      { toolCallId: "dataset", toolName: "inspectDataset", summary: "数据集可用", data: { id: "dataset_retail_orders", rowCount: 48, columnCount: 14 } },
      { toolCallId: "fields", toolName: "inspectFields", summary: "字段可用", data: { fields: [{ field: "region", type: "string" }] } },
    ];
    expect(buildHarnessContextSelection(input, observations, 3).toolNames).toEqual(["previewDataRecipe"]);
    observations.push({
      toolCallId: "recipe",
      toolName: "previewDataRecipe",
      summary: "配方执行成功",
      data: { outputRowCount: 4, fields: ["region", "total_anomaly_count"] },
    });
    const selection = buildHarnessContextSelection(input, observations, 4);
    const tools = harnessToolCatalog({ names: selection.toolNames, request: input, instruction: input.instruction });
    expect(selection.toolNames).toEqual(["exportDataRecipeToExcel"]);
    expect(tools).toHaveLength(1);
    expect(JSON.stringify(tools[0].parameters)).toContain("recipe_east_anomalies");
    expect(JSON.stringify(selection.context)).not.toContain("order_1_1");
  });
});
