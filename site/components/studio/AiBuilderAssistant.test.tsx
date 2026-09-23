import type { ComponentProps } from "react";
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
  harnessTask: HarnessTaskSummary | null,
  requestError: string | null,
  dataAnalysisMode = false,
  conversationTurns: AssistantConversationTurn[] = [],
  pendingInstruction = "",
  imageAttachments: File[] = [],
  presentation: "sidebar" | "workspace" = "sidebar",
  notebook: Partial<Pick<ComponentProps<typeof AiBuilderAssistant>, "notebookOptions" | "selectedNotebookCellIds" | "notebookContextDisabled" | "onRemoveNotebookCell" | "aiMessage" | "instruction">> = {},
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
    onRetry={() => {}}
    onPreview={() => {}}
    onApply={() => {}}
    onCancelPreview={() => {}}
    {...notebook}
  />);
}

describe("Notebook focus in both assistant layouts", () => {
  const options = [{ id: "parameter", kind: "parameter" as const, name: "Saved threshold", detail: "参数 · threshold" }];
  it.each(["sidebar", "workspace"] as const)("renders removable metadata chips in %s", (presentation) => {
    const html = render("idle", task("completed"), null, false, [], "", [], presentation, {
      notebookOptions: options, selectedNotebookCellIds: ["parameter"], onRemoveNotebookCell: () => {},
    });
    expect(html).toContain('aria-label="已选择的 Notebook 上下文"');
    expect(html).toContain('aria-label="移除 Notebook 上下文 Saved threshold"');
    expect(html).toContain("选择本身不会读取或运行数据");
    expect(html).not.toContain("parameter.value");
  });
  it.each(["sidebar", "workspace"] as const)("keeps the no-selection layout unchanged in %s", (presentation) => {
    expect(render("idle", task("completed"), null, false, [], "", [], presentation, { notebookOptions: options }))
      .not.toContain('aria-label="已选择的 Notebook 上下文"');
  });
  it.each(["loading", "editing"])("disables chip removal during %s", (state) => {
    const html = render(state === "loading" ? "loading" : "idle", task("completed"), null, false, [], "", [], "sidebar", {
      notebookOptions: options, selectedNotebookCellIds: ["parameter"], notebookContextDisabled: state === "editing",
    });
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="移除 Notebook 上下文 Saved threshold"/u);
  });
});

describe("AI final answers use shared safe formatting", () => {
  const response = "## 本轮结论\n\n当前参数是 **East**，字段为 `region`。\n\n- 已读取定义\n- 没有运行数据";

  it.each(["sidebar", "workspace"] as const)("formats history responses in %s while leaving user instructions literal", (presentation) => {
    const instruction = '**用户原文** `user_field` <img src="https://invalid.example/user">';
    const turns: AssistantConversationTurn[] = [{
      id: "formatted_response", instruction, response, createdAt: clock.now().toISOString(), state: "success",
    }];
    const html = render("success", task("completed"), null, false, turns, "", [], presentation, { instruction, aiMessage: "未使用的后备消息" });
    expect(html).toContain('class="assistant-answer"');
    expect(html).toContain("<strong>East</strong>");
    expect(html).toContain("<code>region</code>");
    expect(html).toMatch(/<h[34](?:\s[^>]*)?>本轮结论<\/h[34]>/u);
    expect(html).toContain("<li>已读取定义</li>");
    expect(html).toContain("**用户原文** `user_field` &lt;img src=&quot;https://invalid.example/user&quot;&gt;");
    expect(html).not.toContain("<strong>用户原文</strong>");
    expect(html).not.toContain("<code>user_field</code>");
    expect(html).not.toContain("未使用的后备消息");
    expect(html).not.toMatch(/<img(?:\s|>)/u);
  });

  it.each(["sidebar", "workspace"] as const)("preserves the fallback message as plain text in %s", (presentation) => {
    const html = render("idle", task("completed"), null, false, [], "", [], presentation, { aiMessage: response, instruction: "测试指令" });
    expect(html).toContain(`<p>${response}</p>`);
    expect(html).not.toContain('class="assistant-answer"');
    expect(html).not.toContain("<strong>East</strong>");
    expect(html).not.toContain("<code>region</code>");
  });

  it.each(["sidebar", "workspace"] as const)("retains failed, blocked, and cancelled labels and error deduplication in %s", (presentation) => {
    const cases = [
      { state: "failed", requestStatus: "error", label: "执行失败", retry: true, harness: task("failed") },
      { state: "blocked", requestStatus: "blocked", label: "任务受限", retry: false, harness: task("blocked") },
      { state: "cancelled", requestStatus: "cancelled", label: "已取消", retry: false, harness: task("failed") },
    ] as const;
    for (const entry of cases) {
      const failureResponse = `**${entry.state}独立解释**：本次操作未完成。`;
      const turns: AssistantConversationTurn[] = [{
        id: `${entry.state}_format`, instruction: "测试状态保留", response: failureResponse,
        taskId: entry.harness.id, createdAt: clock.now().toISOString(), state: entry.state,
      }];
      const html = render(entry.requestStatus, entry.harness, failureResponse, false, turns, "", [], presentation);
      expect(html).toContain(`<p>${failureResponse}</p>`);
      expect(html).not.toContain('class="assistant-answer"');
      expect(html).not.toContain(`<strong>${entry.state}独立解释</strong>`);
      expect(html.split(`${entry.state}独立解释`)).toHaveLength(2);
      expect(html).toContain(`${entry.label} · Harness`);
      expect(html).not.toContain("AI 生成失败");
      expect(html.includes("重试这次任务")).toBe(entry.retry);
      expect(html).not.toContain('class="validation-error');
    }
  });

  it("keeps unrelated error messages and pending user instructions literal", () => {
    const plainError = "**原始错误** `error_code`";
    const html = render("error", task("failed"), plainError);
    expect(html).toContain(`<p>${plainError}</p>`);
    expect(html).not.toContain("<strong>原始错误</strong>");
    const pending = render("loading", task("failed"), null, false, [], "**待处理原文** `raw`");
    expect(pending).toContain("<span>**待处理原文** `raw`</span>");
    expect(pending).not.toContain("<strong>待处理原文</strong>");
  });

  it("formats the answer without formatting trace messages or rewriting the saved response", () => {
    const traceMessage = "**读取说明** `cellSearch` <script>不可执行</script>";
    const completed: HarnessTaskSummary = {
      ...task("completed"),
      trace: [{
        id: "trace_format_boundary", sequence: 1, taskId: task("completed").id,
        timestamp: clock.now().toISOString(), type: "context_loaded", message: traceMessage,
      }],
    };
    const turn: AssistantConversationTurn = Object.freeze({
      id: "saved_raw_answer", instruction: "读取定义", response,
      taskId: completed.id, createdAt: clock.now().toISOString(), state: "success",
    });
    const html = render("success", completed, null, false, [turn]);
    expect(html).toContain("<strong>East</strong>");
    expect(html).toContain("<p>**读取说明** `cellSearch` &lt;script&gt;不可执行&lt;/script&gt;</p>");
    expect(html).not.toContain("<strong>读取说明</strong>");
    expect(html).not.toContain("<code>cellSearch</code>");
    expect(turn.response).toBe(response);
    expect(completed.trace?.[0].message).toBe(traceMessage);
  });
});

describe("restored failure without retained task summary", () => {
  const response = "这次任务没有完成，请重新尝试。";
  const turn: AssistantConversationTurn = {
    id: "restored_failure", instruction: "合成问题", response,
    taskId: "evicted_task", createdAt: clock.now().toISOString(), state: "failed",
  };
  it.each(["sidebar", "workspace"] as const)("keeps one explanation and the original retry button in %s", (presentation) => {
    const html = render("error", null, response, false, [turn], "", [], presentation);
    expect(html.split(response)).toHaveLength(2);
    expect(html).toContain("重试这次任务");
    expect(html).not.toContain("AI 生成失败");
    expect(html).toContain("执行失败 · Harness");
  });
  it("does not hide a same-worded error belonging to a different current task", () => {
    const html = render("error", task("failed"), response, false, [turn]);
    expect(html).toContain("AI 生成失败");
    expect(html).toContain(">重试</button>");
  });
});

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
    expect(html).toContain("若需查询完整原始工作簿，请重新导入 XLSX");
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

    expect(html).not.toContain('class="conversation-heading"');
    expect(html).not.toContain("已保留 2 轮");
    expect(html.indexOf("先分析 B5FSL01")).toBeLessThan(html.indexOf("好的"));
    expect(html).toContain("已回复 · Harness");
    expect(html).toContain("已回复 · 本地回复");
    expect(html).not.toContain("清除上下文");
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
