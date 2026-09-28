// @vitest-environment happy-dom
import { markupRoot } from "@/test-support/markup";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "@/test-support/render-themed";
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
  harnessTask: HarnessTaskSummary | null,
  requestError: string | null,
  dataAnalysisMode = false,
  conversationTurns: AssistantConversationTurn[] = [],
  pendingInstruction = "",
  imageAttachments: File[] = [],
  presentation: "sidebar" | "workspace" = "sidebar",
  notebook: Partial<ComponentProps<typeof AiBuilderAssistant>> = {},
) {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  return renderToStaticMarkup(<AiBuilderAssistant
    pageTitle="客户洞察"
    changeSet={demoFixtureResult.data.repurchaseChangeSet}
    status="pending"
    validationError={null}
    canApply
    canPreview={false}
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
    onSubmitInstruction={async () => {}}
    onCancelRequest={() => {}}
    onRetry={() => {}}
    onPreview={() => {}}
    onApply={() => {}}
    onCancelPreview={() => {}}
    {...notebook}
  />);
}

describe("DSH official assistant replaces website chat chrome", () => {
  const official = { notebookAutoRunEnabled: true, onSubmitInstruction: async () => {} };
  it("lets the official surface own the empty layout without the legacy bottom-aligned welcome classes", () => {
    const html = render("idle", null, null, false, [], "", [], "workspace", official);
    expect(html).toContain("official-dsh-panel");
    expect(html).not.toContain("agent-workspace-empty");
    expect(html).not.toContain("assistant-empty");
    const legacy = render("idle", null, null, false, [], "", [], "workspace");
    expect(legacy).toContain("official-dsh-panel");
    expect(legacy).not.toContain("agent-workspace-empty");
    expect(legacy).not.toContain("assistant-empty");
  });
  it("shows a non-interactive introduction only for a truly empty main DSH conversation", () => {
    const empty = render("idle", null, null, false, [], "", [], "workspace", { ...official, instruction: "" });
    expect(empty).toContain('data-agentcanvas-dsh-empty-welcome="true"');
    expect(empty).toContain('class="dsh-web-empty-art"');
    expect(empty).toContain("想从数据中了解什么？");
    expect(empty).not.toContain("agent-suggestions");

    const sidebar = render("idle", null, null, false, [], "", [], "sidebar", { ...official, instruction: "" });
    const draft = render("idle", null, null, false, [], "", [], "workspace", { ...official, instruction: "先分析数据" });
    const running = render("loading", null, null, false, [], "问题", [], "workspace", { ...official, instruction: "" });
    const answered = render("success", null, null, false,
      [{ id: "turn", instruction: "问题", response: "回答", createdAt: clock.now().toISOString(), state: "success" }], "", [], "workspace", { ...official, instruction: "" });
    for (const html of [sidebar, draft, running, answered]) expect(html).not.toContain("data-agentcanvas-dsh-empty-welcome");
  });
  it.each(["workspace", "sidebar"] as const)("has no legacy chat, footer cards or step trace in %s", (presentation) => {
    const html = render("success", createHarnessTask("completed_task", "问题", "page_home", "editor", clock), null, false,
      [{ id: "turn", taskId: "completed_task", instruction: "问题", response: "回答", createdAt: clock.now().toISOString(), state: "success" }], "", [], presentation, official);
    expect(html).toContain('aria-label="官方 DSH 对话界面"');
    expect(html).toContain('aria-label="选择分析数据与上下文"');
    for (const removed of ['class="safe-note"', "agent-context-bar", "dsh-web-receipt", "harness-trace", 'class="prompt-box"', "assistant-controls", "context-pill", "新 Notebook 草稿自动运行预览", "添加上下文，让回答更有依据", "本轮已完成"]) {
      expect(html).not.toContain(removed);
    }
  });
  it.each(["workspace", "sidebar"] as const)("does not repeat the selected data source in a gray context strip in %s", (presentation) => {
    const html = render("idle", null, null, false, [], "", [], presentation,
      { ...official, dataSources: [{ id: "source", name: "测试数据" }], activeDataSourceId: "source" });
    expect(html).toContain('title="当前数据：测试数据"');
    expect(html).not.toContain('class="context-pill"');
  });
  it("keeps preflight errors visible even when there is no conversation turn", () => {
    const html = render("error", null, "来源已经过期，请重新导入。", false, [], "", [], "workspace", official);
    expect(html).toContain('role="alert"');
    expect(html.split("来源已经过期，请重新导入。")).toHaveLength(2);
    expect(html).toContain("重试");
    expect(html).not.toContain('class="safe-note"');
  });
  it("does not duplicate a recorded failure outside the official conversation", () => {
    const failed = task("failed");
    const html = render("error", failed, "执行异常。", false,
      [{ id: "turn", taskId: failed.id, instruction: "问题", response: "执行异常。", createdAt: clock.now().toISOString(), state: "failed" }], "", [], "workspace", official);
    expect(html).not.toContain("assistant-controls");
    expect(html).toContain("重试这次任务");
  });
  it("preserves validation and explicit ChangeSet confirmation without the permanent safety note", () => {
    const html = render("success", null, null, false, [], "", [], "workspace", { ...official, canPreview: true, validationError: "目标已变化，请重新预览。" });
    expect(html).toContain("目标已变化，请重新预览。");
    expect(html).toContain("画布预览");
    expect(markupRoot(html).querySelector("button.apply")?.hasAttribute("disabled")).toBe(true);
    expect(html).toContain("确认并应用");
    expect(html).not.toContain('class="safe-note"');
  });
  it("preserves Notebook delivery and actual exports", () => {
    const html = render("success", { ...task("completed"), notebookArtifact: { id: "draft", version: 1, name: "分析草稿", status: "draft", baseRevision: 0,
      cells: [{ id: "summary", kind: "text", title: "说明", markdown: "合成测试" }], executionOrder: ["summary"], lineage: [{ cellId: "summary", dependsOn: [] }],
      sourceDataSourceIds: [], createdAt: clock.now().toISOString() } }, null, false, [], "", [], "workspace", { ...official, onOpenNotebook: () => {} });
    expect(html).toContain("下载 Excel");
    expect(html).toContain("打开 Notebook 查看分析");
    expect(html).not.toContain('class="safe-note"');
  });
  it("does not trap unsupported pending images behind a retired entrance", () => {
    const html = render("idle", null, null, false, [], "", [new File(["synthetic"], "test.png", { type: "image/png" })], "sidebar", official);
    expect(html).toContain("移除待发送图片");
    expect(html).not.toContain("返回过渡入口");
  });
  it("keeps context selection but disables the compact action while running", () => {
    const html = render("loading", null, null, false, [], "问题", [], "sidebar", { ...official, dataSources: [{ id: "source", name: "测试数据" }], activeDataSourceId: "source" });
    expect(html).toMatch(/<button[^>]*aria-label="选择分析数据与上下文"[^>]*disabled=""/u);
    expect(html).toContain("当前数据：测试数据");
    expect(html).not.toContain("agent-context-bar");
  });
  it("does not render the gray context strip in the default sidebar either", () => {
    const html = render("idle", null, null, false, [], "", [], "sidebar");
    expect(html).not.toContain('class="context-pill"');
  });
});

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
    expect(markupRoot(html).querySelector('[aria-label="移除 Notebook 上下文 Saved threshold"]')?.hasAttribute("disabled")).toBe(true);
  });
});


describe("DSH business feedback retained after legacy UI retirement", () => {
  it.each(["sidebar", "workspace"] as const)("retains restored failure retry without duplicating the official message in %s", (presentation) => {
    const response = "这次任务没有完成，请重新尝试。";
    const turn: AssistantConversationTurn = { id: "restored", taskId: "evicted_task", instruction: "问题",
      response, createdAt: clock.now().toISOString(), state: "failed" };
    const html = render("error", null, response, false, [turn], "", [], presentation);
    expect(html).toContain("官方 DSH 对话界面");
    expect(html).toContain("重试这次任务");
    expect(html).not.toContain(response);
    expect(html).not.toContain("AI 生成失败");
    const unrelated = render("error", task("failed"), response, false, [turn], "", [], presentation);
    expect(unrelated).toContain(response);
    expect(unrelated).toContain("AI 生成失败");
    expect(unrelated).toContain(">重试</button>");
  });

  it.each([
    ["blocked", "任务受限/缺少能力", "status"],
    ["error", "AI 生成失败", "alert"],
    ["cancelled", "请求已取消", "alert"],
    ["timeout", "请求超时", "alert"],
  ] as const)("retains %s preflight feedback", (status, label, role) => {
    const html = render(status, null, "未建立任务", false);
    expect(html).toContain(label);
    expect(html).toContain(`role="${role}"`);
    expect(html.split("未建立任务")).toHaveLength(2);
    expect(html.includes("blocked-warning")).toBe(status === "blocked");
  });

  it("does not interpret error text as markup", () => {
    const html = render("error", task("failed"), '**错误** <img src="https://invalid.example">');
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<strong>错误");
  });

  it.each([
    ["pending", true, "idle", true],
    ["preview", false, "idle", true],
    ["preview", true, "loading", true],
    ["preview", true, "idle", false],
    ["applied", true, "success", true],
  ] as const)("keeps apply gate for %s / permission %s / request %s", (status, canApply, requestStatus, disabled) => {
    const html = render(requestStatus, null, null, false, [], "", [], "sidebar", { status, canApply, canPreview: true });
    expect(markupRoot(html).querySelector("button.apply")?.hasAttribute("disabled")).toBe(disabled);
    expect(html).toContain(status === "applied" ? "已全部应用" : "确认并应用");
    if (status === "preview") expect(html).toContain("取消预览");
  });

  it("retains explicit rejection of pending ChangeSets", () => {
    const awaiting: HarnessTaskSummary = { ...task("completed"), state: "awaitingConfirmation",
      pendingChangeSet: demoFixtureResult.success ? demoFixtureResult.data.repurchaseChangeSet : undefined };
    const html = render("success", awaiting, null, false, [], "", [], "sidebar", { canPreview: true });
    expect(html).toContain("拒绝变更");
    expect(html).toContain("画布预览");
  });

  it("hides stale delivery buttons while another task is running", () => {
    const html = render("loading", task("completed"), null);
    expect(html).not.toContain("下载 Excel");
  });

  it("preserves parent feedback scrolling without scrolling someone reading older feedback", () => {
    expect(isConversationNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 560 })).toBe(true);
    expect(isConversationNearBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 300 })).toBe(false);
  });
});
