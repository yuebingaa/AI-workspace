import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { HarnessObservation, HarnessRequest, HarnessWorkingMemory } from "./contracts";
import {
  createHarnessExecutionPlan,
  finishHarnessExecutionPlan,
  harnessExecutionPlanContext,
  replanHarnessExecutionPlanAfterVerification,
  syncHarnessExecutionPlan,
} from "./execution-planner";

function request(instruction = "检查 retail_orders 数据集，并将本月收入标题改为月度总收入"): HarnessRequest {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return {
    idempotencyKey: "request_execution_planner",
    instruction,
    pageId: "page_home",
    role: "editor",
    appSpec: structuredClone(demoFixtureResult.data.dataProduct.appSpec),
    recipes: structuredClone(demoFixtureResult.data.dataProduct.recipes),
  };
}

describe("Harness Planner / Executor 分离", () => {
  it("Planner 在执行前生成完整步骤，Executor 初始只能调用第一步工具", () => {
    const plan = createHarnessExecutionPlan(request());

    expect(plan.steps.map(({ kind, toolName, status }) => ({ kind, toolName, status }))).toEqual([
      { kind: "tool", toolName: "inspectDataset", status: "active" },
      { kind: "tool", toolName: "createChangeSetPreview", status: "pending" },
      { kind: "finalize", toolName: undefined, status: "pending" },
    ]);
    expect(plan.allowedTools).toEqual(["inspectDataset"]);
    expect(harnessExecutionPlanContext(plan)).toMatchObject({
      separation: "plannerThenExecutor",
      currentStep: { objective: "检查目标数据集概况" },
      allowedTools: ["inspectDataset"],
    });
  });

  it("Executor 完成当前步骤后只激活下一步，完成时关闭工具权限", () => {
    const initial = createHarnessExecutionPlan(request());
    const observations: HarnessObservation[] = [{
      toolCallId: "dataset_checked",
      toolName: "inspectDataset",
      summary: "数据集已检查",
      data: { rowCount: 48, columnCount: 14 },
    }];
    const advanced = syncHarnessExecutionPlan(initial, observations, ["createChangeSetPreview"], []);

    expect(advanced.steps[0].status).toBe("completed");
    expect(advanced.steps[1].status).toBe("active");
    expect(advanced.allowedTools).toEqual(["createChangeSetPreview"]);

    const finished = finishHarnessExecutionPlan(advanced, "awaitingConfirmation");
    expect(finished.currentStepId).toBeUndefined();
    expect(finished.allowedTools).toEqual([]);
    expect(finished.steps[1].status).toBe("completed");
  });

  it("工具失败时 Planner 提升版本并把 Replan 原因交给 Executor", () => {
    const initial = createHarnessExecutionPlan(request());
    const failedAttempts: HarnessWorkingMemory["failedAttempts"] = [{
      toolName: "inspectDataset",
      failureKind: "execution",
      attempt: 1,
      issueSummary: ["数据运行时暂时不可用"],
      status: "recovering",
    }];
    const replanned = syncHarnessExecutionPlan(initial, [], ["inspectDataset", "inspectFields"], failedAttempts, {
      failedTool: "inspectDataset",
      failureKind: "execution",
      attempt: 1,
      maxAttempts: 2,
      sameCallFailureCount: 1,
      issueSummary: ["数据运行时暂时不可用"],
    });

    expect(replanned.revision).toBe(2);
    expect(replanned.allowedTools).toEqual(["inspectFields"]);
    expect(replanned.replanReason).toContain("数据运行时暂时不可用");
    expect(replanned.steps[0]).toMatchObject({
      toolName: "inspectFields",
      status: "active",
    });
    expect(replanned.steps[1]).toMatchObject({
      toolName: "inspectDataset",
      status: "pending",
      attempts: 1,
    });
    expect(replanned.steps.filter((step) => step.status === "active")).toHaveLength(1);
  });

  it("Verifier 驳回结果后重新激活收尾步骤并提升计划版本", () => {
    const initial = createHarnessExecutionPlan(request("你好"));
    const replanned = replanHarnessExecutionPlanAfterVerification(initial, ["最终输出过于笼统"]);

    expect(replanned.revision).toBe(2);
    expect(replanned.allowedTools).toEqual([]);
    expect(replanned.steps.at(-1)).toMatchObject({ kind: "finalize", status: "active", attempts: 1 });
    expect(replanned.replanReason).toContain("Verifier 未通过");
  });
});
