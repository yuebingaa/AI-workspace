import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionState } from "@/core/changesets";
import { HarnessClientError, requestHarnessTask } from "@/core/harness/client";
import { clearHarnessConversations } from "@/core/harness/conversation-client";
import type { HarnessResponse, HarnessTaskSummary } from "@/core/harness/contracts";
import { createHarnessTask } from "@/core/harness/task-state";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { saveSemanticModel } from "@/core/semantic/model";
import { createStudioAssistantActions, harnessUiClock, useStudioAssistantState, type StudioAssistantState, type StudioAssistantActionsContext } from "./assistant";

vi.mock("@/core/harness/client", async (original) => ({ ...await original<object>(), requestHarnessTask: vi.fn() }));
vi.mock("@/core/harness/conversation-client", () => ({
  harnessConversationId: vi.fn(() => "conversation_existing"), clearHarnessConversations: vi.fn(),
}));

function context() {
  if (!demoFixtureResult.success) throw new Error(demoFixtureResult.error);
  const fixtures = demoFixtureResult.data;
  let assistant!: StudioAssistantState;
  function Probe() { assistant = useStudioAssistantState(fixtures.repurchaseChangeSet); return null; }
  renderToStaticMarkup(createElement(Probe));
  const values: Record<string, unknown> = { ...assistant };
  const bindings = assistant as unknown as Record<string, unknown>;
  for (const key of Object.keys(bindings).filter((key) => key.startsWith("set"))) {
    const valueKey = key[3].toLowerCase() + key.slice(4);
    bindings[key] = vi.fn((next: unknown) => {
      values[valueKey] = typeof next === "function" ? next(values[valueKey]) : next;
    });
  }
  assistant.aiInstruction = "请检查当前数据的字段结构";
  const dataProduct = structuredClone(fixtures.dataProduct);
  const execution = createExecutionState(dataProduct.appSpec);
  const state: StudioAssistantActionsContext = {
    assistant, role: "editor", activePageId: execution.present.pages[0].id,
    renderedSpec: execution.present, activeDataSource: execution.present.dataSources[0], activeOriginalWorkbook: undefined,
    edsWorkspace: null, dataProduct, execution, auditRecords: [], queryRecords: [],
    persistExplicitly: vi.fn(() => ({ persisted: true, notice: null })),
    setExecution: vi.fn(), setPendingPuckChangeSet: vi.fn(), setPendingChangeSource: vi.fn(), setCanvasMode: vi.fn(),
    auditCurrentPreviewCancellation: vi.fn(), setValidationError: vi.fn(), setSaveLabel: vi.fn(),
  };
  return { state, values };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(clearHarnessConversations).mockResolvedValue();
  vi.mocked(requestHarnessTask).mockImplementation(async (request) => ({ task: {
    ...createHarnessTask(request.idempotencyKey, request.instruction, request.pageId, "editor", harnessUiClock),
    state: "completed", resultMessage: "已核实数据。",
  } }));
});

describe("聊天控制器保持请求、会话与确认边界", () => {
  it("AI 请求携带当前选中模型，取消选择后不残留旧口径", async () => {
    const { state } = context(), { product, model, source } = semanticFixture();
    state.dataProduct = saveSemanticModel(product, model, "page_home", "editor");
    state.activePageId = "page_home"; state.activeDataSource = source; state.renderedSpec = product.appSpec;
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    expect(vi.mocked(requestHarnessTask).mock.calls.at(-1)?.[0].semanticModel).toEqual(model);
    state.dataProduct = product;
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    expect(vi.mocked(requestHarnessTask).mock.calls.at(-1)?.[0].semanticModel).toBeUndefined();
  });
  it("本地简短回复不调用模型，仍保存带页面归属的会话", async () => {
    const { state, values } = context(); state.assistant.aiInstruction = "你好";
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    expect(requestHarnessTask).not.toHaveBeenCalled();
    expect(values.aiRequestStatus).toBe("success");
    expect(values.isLocalAssistantReply).toBe(true);
    expect(values.assistantConversation).toEqual([expect.objectContaining({ pageId: state.activePageId, instruction: "你好" })]);
    expect(state.persistExplicitly).toHaveBeenCalled();
  });

  it("SSE 进度先展示，最终待确认结果不直接写入正式 AppSpec", async () => {
    const { state, values } = context(), original = structuredClone(state.execution.present);
    let finish!: (response: HarnessResponse) => void;
    let terminal!: HarnessTaskSummary;
    vi.mocked(requestHarnessTask).mockImplementation((request, options) => {
      terminal = { ...createHarnessTask(request.idempotencyKey, request.instruction, request.pageId, "editor", harnessUiClock),
        state: "awaitingConfirmation", pendingChangeSet: state.assistant.aiChangeSet, resultMessage: "已生成预览，等待确认。" };
      options?.onEvent?.({ id: "stream-1", sequence: 1, taskId: terminal.id, timestamp: terminal.createdAt,
        type: "tool_started", message: "正在读取数据", taskState: "executingTool" });
      return new Promise((resolve) => { finish = resolve; });
    });
    const run = createStudioAssistantActions(state).handleGenerateAiPlan();
    expect(values.aiRequestStatus).toBe("loading");
    expect((values.harnessTasks as HarnessTaskSummary[])[0].trace?.[0].message).toBe("正在读取数据");
    expect(state.assistant.harnessRequestActiveRef.current).toBe(true);
    finish({ task: terminal }); await run;
    expect(values.hasValidAiPlan).toBe(true);
    expect(values.aiChangeSet).toEqual(terminal.pendingChangeSet);
    expect(state.execution.present).toEqual(original);
    expect(state.assistant.harnessRequestActiveRef.current).toBe(false);
    expect(vi.mocked(requestHarnessTask).mock.calls[0][1]?.stream).toBe(true);
  });

  it("追问沿用会话 ID，仅携带当前页面最近十轮", async () => {
    const { state } = context();
    state.assistant.assistantConversation = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `turn-${i}`, pageId: state.activePageId,
        instruction: `问题 ${i}`, response: `回答 ${i}`, createdAt: "2026-09-10T00:00:00.000Z", state: "success" as const })),
      { id: "another-page", pageId: "another-page", instruction: "别的页面问题", response: "别的页面回答", createdAt: "2026-09-10T00:00:00.000Z", state: "success" },
    ];
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    const request = vi.mocked(requestHarnessTask).mock.calls[0][0];
    expect(request.conversation_id).toBe("conversation_existing");
    expect(request.conversationContext?.recentMessages).toHaveLength(10);
    expect(request.conversationContext?.previousInstruction).toBe("问题 11");
    expect(JSON.stringify(request.conversationContext)).not.toContain("别的页面");
  });

  it("取消中断请求，保留已收到的执行记录并释放运行锁", async () => {
    const { state, values } = context();
    vi.mocked(requestHarnessTask).mockImplementation((request, options) => new Promise((_, reject) => {
      const task = createHarnessTask(request.idempotencyKey, request.instruction, request.pageId, "editor", harnessUiClock);
      options?.onEvent?.({ id: "progress", sequence: 1, taskId: task.id, timestamp: task.createdAt,
        type: "context_loaded", message: "已加载上下文" });
      options?.signal?.addEventListener("abort", () => reject(new HarnessClientError("cancelled", "已取消", true)), { once: true });
    }));
    const actions = createStudioAssistantActions(state), run = actions.handleGenerateAiPlan();
    actions.handleCancelAiRequest(); await run;
    expect(values.aiRequestStatus).toBe("cancelled");
    expect((values.harnessTasks as HarnessTaskSummary[])[0].trace?.[0].message).toBe("已加载上下文");
    expect(state.assistant.harnessRequestActiveRef.current).toBe(false);
    expect(values.hasValidAiPlan).toBe(false);
  });

  it("服务端清除失败不丢聊天；成功后不删除任务和审计", async () => {
    const { state, values } = context();
    state.assistant.assistantConversation = [{ id: "turn", pageId: state.activePageId, instruction: "你好",
      response: "你好", createdAt: "2026-09-10T00:00:00.000Z", state: "success" }];
    const actions = createStudioAssistantActions(state);
    vi.mocked(clearHarnessConversations).mockRejectedValueOnce(new Error("offline"));
    await actions.handleClearAssistantConversation();
    expect(state.assistant.setAssistantConversation).not.toHaveBeenCalled();
    expect(state.persistExplicitly).not.toHaveBeenCalled();
    expect(state.assistant.harnessRequestActiveRef.current).toBe(false);
    await actions.handleClearAssistantConversation();
    expect(values.assistantConversation).toEqual([]);
    expect(state.assistant.setHarnessTasks).not.toHaveBeenCalled();
    expect(state.persistExplicitly).toHaveBeenLastCalledWith(state.execution, state.auditRecords, state.queryRecords,
      state.dataProduct, state.assistant.harnessTasks, state.edsWorkspace, []);
  });

  it("重试保留原指令、任务关联和图片，重复发送仍被拦截", async () => {
    const { state } = context();
    const image = new File(["image"], "chart.png", { type: "image/png" });
    state.assistant.lastSubmittedImages = [image];
    const actions = createStudioAssistantActions(state);
    state.assistant.harnessRequestActiveRef.current = true;
    await actions.handleGenerateAiPlan();
    expect(requestHarnessTask).not.toHaveBeenCalled();
    state.assistant.harnessRequestActiveRef.current = false;
    await actions.handleGenerateAiPlan("检查图表", "old_task");
    expect(vi.mocked(requestHarnessTask).mock.calls[0][0].retryOfTaskId).toBe("old_task");
    expect(vi.mocked(requestHarnessTask).mock.calls[0][1]?.imageAttachments).toEqual([image]);
    expect(state.assistant.setAiImageAttachments).not.toHaveBeenCalled();
  });

  it("图片类型和数量限制保持不变", () => {
    const { state, values } = context();
    const actions = createStudioAssistantActions(state);
    actions.handleImageAttachmentsChange([new File(["gif"], "bad.gif", { type: "image/gif" })]);
    expect(values.aiRequestStatus).toBe("error");
    expect(state.assistant.setAiImageAttachments).not.toHaveBeenCalled();
    const image = new File(["png"], "good.png", { type: "image/png" });
    actions.handleImageAttachmentsChange([image]);
    expect(values.aiImageAttachments).toEqual([image]);
  });
});
