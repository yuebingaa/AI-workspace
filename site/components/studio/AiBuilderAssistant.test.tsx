import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { appendHarnessEvent, createHarnessTask, type AssistantConversationTurn, type HarnessTaskSummary } from "@/core/harness";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { AiBuilderAssistant, clipboardImageFiles, isConversationNearBottom, type AiRequestUiStatus } from "./AiBuilderAssistant";

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
  presentation: "sidebar" | "workspace" = "sidebar",
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
    aiMessage="测试消息"
    aiMetadata={null}
    instruction="测试指令"
    requestStatus={status}
    requestError={requestError}
    canRetry={status === "error"}
    harnessTask={harnessTask}
    presentation={presentation}
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
  it("失败解释只显示在当前聊天回复中，保留重试入口", () => {
    const failed = task("failed");
    const response = "暂时没能完成销售数据检查，你可以缩小范围后再试。";
    const turns: AssistantConversationTurn[] = [{ id: "failed_turn", instruction: failed.instruction,
      response, taskId: failed.id, createdAt: failed.updatedAt, state: "failed" }];
    const html = render("error", failed, response, false, turns);
    expect(html.split(response)).toHaveLength(2);
    expect(html).not.toContain("AI 生成失败");
    expect(html).toContain("重试这次任务");
    // An unrelated error (e.g. failed context clearing) must still be visible.
    expect(render("error", failed, "上下文清除失败", false, turns)).toContain("上下文清除失败");
  });
  it("工作台和侧栏移除顶部运行详情，保留回答执行过程和下载入口", () => {
    const completed: HarnessTaskSummary = {
      ...task("completed"),
      trace: [{
        id: "trace_no_diagnostics",
        sequence: 1,
        taskId: task("completed").id,
        timestamp: clock.now().toISOString(),
        type: "context_loaded",
        message: "已读取数据上下文。",
      }],
    };
    const turns: AssistantConversationTurn[] = [{
      id: "turn_no_diagnostics",
      instruction: completed.instruction,
      response: completed.resultMessage!,
      createdAt: completed.updatedAt,
      state: "success",
      taskId: completed.id,
    }];
    for (const presentation of ["sidebar", "workspace"] as const) {
      const html = render("success", completed, null, false, turns, "", [], presentation);
      expect(html).not.toContain("运行详情");
      expect(html).not.toContain("assistant-diagnostics");
      expect(html).toContain("harness-trace success");
      expect(html).toContain("已完成分析");
      expect(html).toContain("已读取数据上下文。");
      expect(html).toContain("下载 Excel");
    }
  });

  it("输入框提供图片上传入口并显示待发送图片", () => {
    const image = new File([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], "页面问题.jpg", { type: "image/jpeg" });
    const html = render("idle", task("completed"), null, false, [], "", [image]);

    expect(html).toContain('aria-label="上传图片"');
    expect(html).toContain("页面问题.jpg");
    expect(html).toContain("1 张图片");
    expect(html).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(html).toContain("Ctrl+V 粘贴图片");
  });

  it("从剪贴板提取支持的图片并忽略文字或不支持文件", () => {
    const png = new File([new Uint8Array([1, 2, 3])], "截图.png", { type: "image/png" });
    const gif = new File([new Uint8Array([4, 5, 6])], "动图.gif", { type: "image/gif" });
    const files = clipboardImageFiles([
      { kind: "string", type: "text/plain", getAsFile: () => null },
      { kind: "file", type: "image/png", getAsFile: () => png },
      { kind: "file", type: "image/gif", getAsFile: () => gif },
    ]);

    expect(files).toEqual([png]);
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
    expect(html).not.toContain("运行详情");
    expect(html).not.toContain("assistant-diagnostics");
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
