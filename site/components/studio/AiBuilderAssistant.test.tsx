import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { appendHarnessEvent, createHarnessTask, type AssistantConversationTurn, type HarnessTaskSummary } from "@/core/harness";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { AiBuilderAssistant, isConversationNearBottom, type AiRequestUiStatus } from "./AiBuilderAssistant";

const clock = {
  now: () => new Date("2026-09-02T03:00:00.000Z"),
  id: () => "assistant_ui_event",
};

function task(state: "blocked" | "failed" | "completed"): HarnessTaskSummary {
  const base = createHarnessTask("assistant_ui_task", "测试 Harness UI", "page_home", "editor", clock);
  return appendHarnessEvent(base, {
    type: state === "failed" ? "error" : "state",
    state,
    message: state === "blocked" ? "缺少外部能力。" : state === "failed" ? "执行异常。" : "Excel 已生成。",
  }, clock, state === "completed" ? {
    resultMessage: "Excel 已生成。",
    exportArtifact: {
      id: "assistant_excel_artifact_001",
      status: "ready",
      fileName: "华东异常订单.xlsx",
      downloadUrl: "/api/exports/assistant_excel_artifact_001",
      rowCount: 4,
      fieldCount: 6,
      sizeBytes: 4096,
      createdAt: "2026-09-02T03:00:00.000Z",
      expiresAt: "2026-09-02T03:10:00.000Z",
    },
  } : { error: state === "blocked" ? "缺少外部能力。" : "执行异常。" });
}

function render(
  status: AiRequestUiStatus,
  harnessTask: HarnessTaskSummary,
  requestError: string | null,
  dataAnalysisMode = false,
  conversationTurns: AssistantConversationTurn[] = [],
  pendingInstruction = "",
  imageAttachments: File[] = [],
) {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return renderToStaticMarkup(<AiBuilderAssistant
    pageTitle="客户洞察"
    datasetName="retail_orders"
    changeSet={demoFixtureResult.data.repurchaseChangeSet}
    status="pending"
    validationError={null}
    canApply
    canPreview={false}
    auditRecords={[]}
    aiMessage="测试消息"
    aiMetadata={null}
    instruction="测试指令"
    requestStatus={status}
    requestError={requestError}
    canRetry={false}
    harnessTask={harnessTask}
    harnessTaskCount={1}
    conversationTurns={conversationTurns}
    pendingInstruction={pendingInstruction}
    dataAnalysisMode={dataAnalysisMode}
    imageAttachments={imageAttachments}
    onInstructionChange={() => {}}
    onImageAttachmentsChange={() => {}}
    onGenerate={() => {}}
    onCancelRequest={() => {}}
    onClearConversation={() => {}}
    onRetry={() => {}}
    onPreview={() => {}}
    onApply={() => {}}
    onCancelPreview={() => {}}
  />);
}

describe("AI 助手 Harness 状态", () => {
  it("输入框提供图片上传入口并显示待发送图片", () => {
    const image = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "页面问题.jpg", { type: "image/jpeg" });
    const html = render("idle", task("completed"), null, false, [], "", [image]);

    expect(html).toContain('aria-label="上传图片"');
    expect(html).toContain("页面问题.jpg");
    expect(html).toContain("1 张图片");
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
  });

  it("只有接近消息底部时才保持自动贴底", () => {
    expect(isConversationNearBottom({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 560 } as HTMLElement)).toBe(true);
    expect(isConversationNearBottom({ scrollHeight: 1_000, clientHeight: 400, scrollTop: 300 } as HTMLElement)).toBe(false);
  });

  it("blocked 使用黄色任务受限提示，failed 才显示红色失败提示", () => {
    const blocked = render("blocked", task("blocked"), "缺少外部能力。");
    const failed = render("error", task("failed"), "执行异常。");
    expect(blocked).toContain("blocked-warning");
    expect(blocked).toContain("任务受限/缺少能力");
    expect(blocked).not.toContain("AI 生成失败");
    expect(failed).toContain("AI 生成失败");
    expect(failed).not.toContain("blocked-warning");
  });

  it("完成导出后显示明确的 Excel 下载按钮", () => {
    const completed = render("success", task("completed"), null);
    expect(completed).toContain("下载 Excel");
    expect(completed).toContain("/api/exports/assistant_excel_artifact_001");
    expect(completed).toContain("华东异常订单.xlsx");
  });

  it("运行详情显示本次 Harness 自动加载的 Skill", () => {
    const skilledTask = createHarnessTask("assistant_skill_task", "增加一个饼图", "page_home", "editor", clock, {
      skills: [{ id: "data-visualization", name: "数据可视化", version: "1.0.0" }],
    });
    const html = render("success", skilledTask, null, true);

    expect(html).toContain("已加载 Skill");
    expect(html).toContain("数据可视化 v1.0.0");
    expect(html).toContain('aria-label="本次加载的技能"');
  });

  it("运行详情显示 Working Memory 的完成、验证、待办与失败路径", () => {
    const memoryTask: HarnessTaskSummary = {
      ...createHarnessTask("assistant_memory_task", "检查并分析数据", "page_home", "editor", clock),
      workingMemory: {
        goal: "检查并分析数据",
        iteration: 3,
        confirmedDataSources: [{ id: "dataset_retail_orders", rowCount: 48, columnCount: 14 }],
        confirmedFields: [],
        completedTools: ["inspectDataset"],
        completedSteps: ["已检查数据集概况"],
        keyStatistics: ["dataset_retail_orders: 48 行 / 14 列"],
        pendingGoals: ["确认分析字段"],
        failedAttempts: [{
          toolName: "inspectFields",
          failureKind: "execution",
          attempt: 1,
          issueSummary: ["字段服务暂时不可用"],
          status: "recovering",
        }],
        missingCapabilities: [],
      },
    };
    const html = render("success", memoryTask, null, true);

    expect(html).toContain('aria-label="Harness Working Memory"');
    expect(html).toContain("Working Memory");
    expect(html).toContain("第 3 轮");
    expect(html).toContain("已完成 1");
    expect(html).toContain("已验证 1");
    expect(html).toContain("待办 1");
    expect(html).toContain("失败路径 1");
    expect(html).toContain("下一步：确认分析字段");
  });

  it("运行详情显示 Planner 计划版本与逐步执行状态", () => {
    const plannedTask: HarnessTaskSummary = {
      ...createHarnessTask("assistant_plan_task", "检查数据后生成图表", "page_home", "editor", clock),
      executionPlan: {
        revision: 2,
        goal: "检查数据后生成图表",
        currentStepId: "step_2_preview",
        allowedTools: ["createChangeSetPreview"],
        replanReason: "第 1 次重新规划：图表专用工具暂时不可用",
        steps: [{
          id: "step_1_inspect",
          kind: "tool",
          objective: "检查目标数据集概况",
          toolName: "inspectDataset",
          status: "completed",
          attempts: 0,
        }, {
          id: "step_2_preview",
          kind: "tool",
          objective: "生成页面变更预览",
          toolName: "createChangeSetPreview",
          status: "active",
          attempts: 1,
        }, {
          id: "step_3_finalize",
          kind: "finalize",
          objective: "提交待确认 ChangeSet 并暂停，等待用户确认",
          status: "pending",
          attempts: 0,
        }],
      },
    };
    const html = render("loading", plannedTask, null, true);

    expect(html).toContain('aria-label="Planner 执行计划"');
    expect(html).toContain("Planner 执行计划");
    expect(html).toContain("v2");
    expect(html).toContain("检查目标数据集概况");
    expect(html).toContain("生成页面变更预览");
    expect(html).toContain("已完成");
    expect(html).toContain("执行中");
    expect(html).toContain("Replan：第 1 次重新规划");
  });

  it("运行详情显示真正的任务级 Verifier 验收结果", () => {
    const verifiedTask: HarnessTaskSummary = {
      ...createHarnessTask("assistant_verifier_task", "检查数据质量", "page_home", "editor", clock),
      verification: {
        attempt: 2,
        status: "passed",
        checks: [{
          id: "planned_steps",
          label: "计划完成度",
          status: "passed",
          detail: "Planner 要求的工具步骤均有成功观察证据。",
        }, {
          id: "formal_app_protection",
          label: "正式页面保护",
          status: "passed",
          detail: "正式 AppSpec 未被执行过程直接修改。",
        }],
        issues: [],
        evidenceToolCallIds: ["call_dataset"],
        visualEvidence: {
          required: true,
          status: "passed",
          source: "playwright-multimodal",
          summary: "桌面与窄屏均无重叠。",
          model: "vision-test",
          capturedAt: "2026-09-06T00:00:00.000Z",
          screenshots: [{
            viewport: { width: 1440, height: 1000 },
            pageUrl: "http://127.0.0.1:3102/",
            mimeType: "image/jpeg",
            byteLength: 1024,
            sha256: "a".repeat(64),
          }],
          checks: [],
          issues: [],
        },
      },
    };
    const html = render("success", verifiedTask, null, true);

    expect(html).toContain('aria-label="任务级 Verifier"');
    expect(html).toContain("验收通过 · 第 2 次");
    expect(html).toContain("计划完成度");
    expect(html).toContain("正式页面保护");
    expect(html).toContain('aria-label="Playwright 视觉证据"');
    expect(html).toContain("视觉通过 · 1 张截图");
  });

  it("EDS 上下文显示数据分析、看板预览能力和隐私边界", () => {
    const html = render("success", task("completed"), null, true);
    expect(html).toContain("AI 数据分析与看板助手");
    expect(html).toContain("看板变更需确认");
    expect(html).toContain("不会获得原始工作簿或逐行明细");
    expect(html).toContain("增加 B5FSL01 异常类型柱状图");
  });

  it("按时间显示过去聊天，并区分 Harness 与本地回复", () => {
    const conversationTurns: AssistantConversationTurn[] = [{
      id: "conversation_1",
      instruction: "先分析 B5FSL01",
      response: "B5FSL01 的异常次数为 12 次。",
      createdAt: "2026-09-05T00:00:00.000Z",
      state: "success",
      taskId: "task_1",
    }, {
      id: "conversation_2",
      instruction: "好的",
      response: "我在。可以继续追问。",
      createdAt: "2026-09-05T00:01:00.000Z",
      state: "success",
    }];
    const html = render("success", task("completed"), null, true, conversationTurns);

    expect(html).toContain("对话上下文");
    expect(html).toContain("已保留 2 轮");
    expect(html.indexOf("先分析 B5FSL01")).toBeLessThan(html.indexOf("好的"));
    expect(html).toContain("已回复 · Harness");
    expect(html).toContain("已回复 · 本地回复");
    expect(html).toContain("清除上下文");
    expect(html).toContain("运行详情");
    expect(html).not.toContain('class="assistant-diagnostics" open');
    expect(html).not.toContain("测试指令</div>");
  });

  it("只把正在执行的已提交问题显示为待处理消息", () => {
    const html = render("loading", task("completed"), null, true, [], "比较白班和夜班");
    expect(html).toContain("比较白班和夜班");
    expect(html).toContain("正在处理");
    expect(html).toContain("正在请求 DeepSeek 并校验结果");
    expect(html).not.toContain("尚无历史对话</span><div class=\"user-message\">测试指令");
  });
});
