import { describe, expect, it } from "vitest";
import { demoFixtureResult } from "@/fixtures/demo-product";
import type { HarnessObservation, HarnessRequest, HarnessSemanticIntentDecision } from "./contracts";
import { createHarnessExecutionPlan } from "./execution-planner";
import { pendingHarnessTaskVerification, verifyHarnessTask } from "./task-verifier";
import { deferredHarnessVisualEvidence } from "./visual-verifier";

function request(instruction: string): HarnessRequest {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return {
    idempotencyKey: "request_task_verifier",
    instruction,
    pageId: "page_home",
    role: "editor",
    appSpec: structuredClone(demoFixtureResult.data.dataProduct.appSpec),
    recipes: structuredClone(demoFixtureResult.data.dataProduct.recipes),
  };
}

describe("Harness 任务级 Verifier", () => {
  it("启动时处于等待验证状态", () => {
    expect(pendingHarnessTaskVerification()).toEqual({
      attempt: 0,
      status: "pending",
      checks: [],
      issues: [],
      evidenceToolCallIds: [],
    });
  });

  it("有计划证据且回答具体时通过", () => {
    const taskRequest = request("检查 retail_orders 数据集概况");
    const observations: HarnessObservation[] = [{
      toolCallId: "dataset_checked",
      toolName: "inspectDataset",
      summary: "数据集共 48 行、14 列",
      data: { rowCount: 48, columnCount: 14 },
    }];
    const verification = verifyHarnessTask({
      request: taskRequest,
      plan: createHarnessExecutionPlan(taskRequest),
      observations,
      attempt: 1,
      candidate: {
        outcome: "completed",
        message: "retail_orders 共 48 行、14 列，数据源可用。",
        formalAppSpecUnchanged: true,
      },
    });

    expect(verification.status).toBe("passed");
    expect(verification.checks.every((item) => item.status === "passed")).toBe(true);
    expect(verification.evidenceToolCallIds).toEqual(["dataset_checked"]);
  });

  it("笼统回答或缺少计划证据时要求重新规划", () => {
    const taskRequest = request("检查 retail_orders 数据集概况");
    const verification = verifyHarnessTask({
      request: taskRequest,
      plan: createHarnessExecutionPlan(taskRequest),
      observations: [],
      attempt: 1,
      candidate: {
        outcome: "completed",
        message: "已完成。",
        formalAppSpecUnchanged: true,
      },
    });

    expect(verification.status).toBe("replan");
    expect(verification.issues).toEqual(expect.arrayContaining([
      expect.stringContaining("过于笼统"),
      expect.stringContaining("仍缺少计划步骤"),
    ]));
  });

  it("页面变更缺少 ChangeSet 或提前修改正式 AppSpec 时拒绝通过", () => {
    const taskRequest = request("将本月收入标题改为月度总收入");
    const verification = verifyHarnessTask({
      request: taskRequest,
      plan: createHarnessExecutionPlan(taskRequest),
      observations: [{
        toolCallId: "change_preview",
        toolName: "createChangeSetPreview",
        summary: "已生成页面变更预览",
        data: { operationCount: 1 },
      }],
      attempt: 1,
      candidate: {
        outcome: "awaitingConfirmation",
        message: "标题变更预览已生成。",
        formalAppSpecUnchanged: false,
      },
    });

    expect(verification.status).toBe("replan");
    expect(verification.issues).toEqual(expect.arrayContaining([
      "缺少待确认 ChangeSet。",
      expect.stringContaining("正式 AppSpec"),
    ]));
  });

  it("UI、图表和布局任务没有截图证据时不能仅凭代码或工具结果通过", () => {
    const taskRequest = request("检查当前页面布局是否有重叠");
    const semanticIntent: HarnessSemanticIntentDecision = {
      mode: "readOnlyTask",
      requiresVisualVerification: true,
      wantsData: false,
      wantsEdsAnalysis: false,
      wantsRawWorkbook: false,
      wantsFields: false,
      wantsRecipe: false,
      wantsAppInspection: true,
      wantsExcel: false,
      changeAction: "none",
      changeTarget: "none",
      componentKind: "none",
      chartType: "auto",
      skillIds: ["dashboard-editing"],
      confidence: 0.98,
      rationale: "用户目标依赖最终页面渲染。",
    };
    const observations: HarnessObservation[] = [{
      toolCallId: "app_checked",
      toolName: "inspectAppSpec",
      summary: "已检查页面组件结构",
      data: { pageId: "page_home" },
    }];
    const verification = verifyHarnessTask({
      request: taskRequest,
      semanticIntent,
      plan: createHarnessExecutionPlan(taskRequest, semanticIntent),
      observations,
      attempt: 1,
      candidate: {
        outcome: "completed",
        message: "代码检查和组件结构检查均已通过。",
        formalAppSpecUnchanged: true,
      },
    });

    expect(verification.status).toBe("replan");
    expect(verification.checks).toContainEqual(expect.objectContaining({ id: "visual_render", status: "failed" }));
    expect(verification.issues).toContainEqual(expect.stringContaining("Playwright 截图"));
  });

  it("多模态模型确认 Playwright 截图后视觉任务才通过", () => {
    const taskRequest = request("检查当前页面布局是否有重叠");
    const semanticIntent: HarnessSemanticIntentDecision = {
      mode: "readOnlyTask",
      requiresVisualVerification: true,
      wantsData: false,
      wantsEdsAnalysis: false,
      wantsRawWorkbook: false,
      wantsFields: false,
      wantsRecipe: false,
      wantsAppInspection: true,
      wantsExcel: false,
      changeAction: "none",
      changeTarget: "none",
      componentKind: "none",
      chartType: "auto",
      skillIds: ["dashboard-editing"],
      confidence: 0.98,
      rationale: "用户目标依赖最终页面渲染。",
    };
    const observations: HarnessObservation[] = [{
      toolCallId: "app_checked",
      toolName: "inspectAppSpec",
      summary: "已检查页面组件结构",
      data: { pageId: "page_home" },
    }];
    const verification = verifyHarnessTask({
      request: taskRequest,
      semanticIntent,
      plan: createHarnessExecutionPlan(taskRequest, semanticIntent),
      observations,
      attempt: 1,
      visualEvidence: {
        required: true,
        status: "passed",
        source: "playwright-multimodal",
        summary: "桌面和窄屏截图均未发现重叠或裁切。",
        model: "vision-model",
        capturedAt: "2026-09-06T00:00:00.000Z",
        screenshots: [{
          viewport: { width: 1440, height: 1000 },
          pageUrl: "http://127.0.0.1:3102/",
          mimeType: "image/jpeg",
          byteLength: 1024,
          sha256: "a".repeat(64),
        }],
        checks: [{ id: "layout_integrity", label: "布局完整性", status: "passed", detail: "组件无重叠。" }],
        issues: [],
      },
      candidate: {
        outcome: "completed",
        message: "桌面与窄屏布局均未发现重叠。",
        formalAppSpecUnchanged: true,
      },
    });

    expect(verification.status).toBe("passed");
    expect(verification.visualEvidence?.status).toBe("passed");
  });

  it("ChangeSet 未应用时明确延期最终视觉验收且不伪装成已完成", () => {
    const taskRequest = request("把图表颜色改成蓝色");
    const semanticIntent: HarnessSemanticIntentDecision = {
      mode: "changePreview",
      requiresVisualVerification: true,
      wantsData: false,
      wantsEdsAnalysis: false,
      wantsRawWorkbook: false,
      wantsFields: false,
      wantsRecipe: false,
      wantsAppInspection: false,
      wantsExcel: false,
      changeAction: "update",
      changeTarget: "chart",
      componentKind: "chart",
      chartType: "auto",
      skillIds: ["data-visualization", "dashboard-editing"],
      confidence: 0.98,
      rationale: "图表样式变更需要看最终渲染。",
    };
    const plan = createHarnessExecutionPlan(taskRequest, semanticIntent);
    const observations: HarnessObservation[] = [{
      toolCallId: "change_preview",
      toolName: "createChangeSetPreview",
      summary: "已生成图表颜色变更预览",
      data: { operationCount: 1 },
    }];
    const verification = verifyHarnessTask({
      request: taskRequest,
      semanticIntent,
      plan,
      observations,
      attempt: 1,
      visualEvidence: deferredHarnessVisualEvidence(),
      candidate: {
        outcome: "awaitingConfirmation",
        message: "图表颜色变更预览已生成。",
        pendingChangeSet: {
          id: "changeset_visual_pending",
          title: "图表颜色变更",
          status: "ready",
          operations: [{
            id: "operation_visual_color",
            type: "updateNodeProps",
            label: "更新图表颜色",
            description: "将目标图表颜色改为蓝色",
            pageId: "page_home",
            nodeId: "chart_revenue",
            props: { color: "#2563eb" },
          }],
        },
        formalAppSpecUnchanged: true,
      },
    });

    expect(verification.status).toBe("passed");
    expect(verification.visualEvidence?.status).toBe("deferred");
    expect(verification.checks).toContainEqual(expect.objectContaining({ id: "visual_render", status: "passed" }));
  });
});
