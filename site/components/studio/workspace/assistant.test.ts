import { createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionState } from "@/core/changesets";
import { HarnessClientError, requestHarnessTask } from "@/core/harness/client";
import { clearHarnessConversations } from "@/core/harness/conversation-client";
import { harnessPublicRequestSchema, type HarnessResponse, type HarnessTaskSummary } from "@/core/harness/contracts";
import { createHarnessTask } from "@/core/harness/task-state";
import { demoFixtureResult } from "@/fixtures/demo-product";
import { semanticFixture } from "@/core/semantic/test-fixture";
import { saveSemanticModel } from "@/core/semantic/model";
import { activeAssistantSession, createAssistantSessions, newAssistantSession, type AssistantSessions } from "@/core/harness/assistant-sessions";
import { createStudioAssistantActions, harnessUiClock, useStudioAssistantState, type StudioAssistantState, type StudioAssistantActionsContext } from "./assistant";
import { composerNotebookContext } from "./notebook-context-selection";
import type { NotebookDocument } from "@/core/notebook/contracts";

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

describe("explicit Notebook focus request composition", () => {
  const document: NotebookDocument = { name: "Synthetic notebook", revision: 2, cells: [
    { id: "parameter", kind: "parameter", title: "Current threshold", outputName: "threshold", parameter: { type: "number", value: 3 } },
    { id: "summary", kind: "text", title: "Current summary", markdown: "Synthetic static definition" },
  ] };
  it.each(["agent", "notebook", "canvas"] as const)("sends stable explicit IDs with the current definition (%s)", async (notebookMode) => {
    const { state } = context();
    const sourceIds = [state.activeDataSource!.id];
    state.notebookContext = composerNotebookContext(document, sourceIds, ["summary", "parameter"], notebookMode);
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    const request = vi.mocked(requestHarnessTask).mock.calls[0][0];
    expect(request.notebookContext).toEqual({ document, sourceIds, selectedCellIds: ["summary", "parameter"] });
    expect(Object.keys(request.notebookContext!)).toEqual(["document", "sourceIds", "selectedCellIds"]);
    expect(request.notebookContext?.document).toBe(document);
    expect(request.notebookContext?.sourceIds).toEqual(sourceIds);
    expect(vi.mocked(requestHarnessTask).mock.calls[0][1]?.stream).toBe(true);
  });
  it("does not introduce implicit Notebook context to an unselected canvas request", async () => {
    const { state } = context();
    state.notebookContext = composerNotebookContext(document, [state.activeDataSource!.id], [], "canvas");
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    expect(vi.mocked(requestHarnessTask).mock.calls[0][0]).not.toHaveProperty("notebookContext");
  });
  it("AI workbench submits the current document without manual Cell focus or changing its definition", async () => {
    const { state } = context();
    const previous = structuredClone(document), sourceIds = [state.activeDataSource!.id];
    state.notebookContext = composerNotebookContext(document, sourceIds, [], "agent");
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    expect(vi.mocked(requestHarnessTask).mock.calls[0][0].notebookContext).toEqual({ document, sourceIds });
    expect(document).toEqual(previous);
  });
  it("permits a viewer to submit focus metadata without adopting or mutating the document", async () => {
    const { state } = context();
    state.role = "viewer";
    state.notebookContext = composerNotebookContext(document, [state.activeDataSource!.id], ["parameter"], "canvas");
    const previous = structuredClone(document);
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    expect(vi.mocked(requestHarnessTask).mock.calls[0][0].notebookContext?.selectedCellIds).toEqual(["parameter"]);
    expect(document).toEqual(previous);
    // The existing request path clears a preview, but never applies a definition.
    expect(state.setExecution).toHaveBeenCalledExactlyOnceWith({ ...state.execution, preview: null });
  });
  it("does not submit a selection while Notebook editing or execution is busy", async () => {
    const { state } = context();
    state.notebookContext = composerNotebookContext(document, [], ["summary"], "canvas");
    state.notebookInteractionBusy = true;
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    expect(requestHarnessTask).not.toHaveBeenCalled();
    expect(state.notebookContext?.selectedCellIds).toEqual(["summary"]);
  });
});

describe("request recipe scope", () => {
  function scopedContext(relevantCount: number, unrelatedCount = 39) {
    const result = context(), { state } = result;
    const selected = state.activeDataSource!;
    const unrelated = { ...structuredClone(selected), id: "dataset_unrelated", name: "Unrelated source" };
    state.execution.present.dataSources.push(unrelated);
    state.notebookContext = { document: { name: "Selected notebook", revision: 0, cells: [] }, sourceIds: [selected.id] };
    const template = state.dataProduct.recipes[0];
    state.dataProduct.recipes = [
      ...Array.from({ length: unrelatedCount }, (_, index) => ({ ...structuredClone(template), id: `unrelated_${index}`, sourceDatasetId: unrelated.id })),
      ...Array.from({ length: relevantCount }, (_, index) => ({ ...structuredClone(template), id: `relevant_${index}`, sourceDatasetId: selected.id })),
    ];
    return result;
  }

  it("sends the selected recipe after 39 unrelated recipes without altering project data", async () => {
    const { state } = scopedContext(1);
    const before = structuredClone(state.dataProduct);
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    const request = vi.mocked(requestHarnessTask).mock.calls[0][0];
    expect(request.recipes.map((recipe) => recipe.id)).toEqual(["relevant_0"]);
    expect(harnessPublicRequestSchema.safeParse(request).success).toBe(true);
    expect(state.dataProduct).toEqual(before);
  });

  it("retains every recipe for all Notebook sources, not only the active source", async () => {
    const { state } = scopedContext(1, 2);
    state.notebookContext!.sourceIds.push("dataset_unrelated");
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    expect(vi.mocked(requestHarnessTask).mock.calls[0][0].recipes.map((recipe) => recipe.id))
      .toEqual(["unrelated_0", "unrelated_1", "relevant_0"]);
  });

  it("uses current-page bindings and explicit source mentions when there is no Notebook", async () => {
    const { state } = scopedContext(1, 2);
    state.notebookContext = undefined;
    state.activeDataSource = undefined;
    state.activePageId = "page_customers";
    await createStudioAssistantActions(state).handleGenerateAiPlan("检查当前页面绑定的数据，以及 Unrelated source 的配方");
    expect(vi.mocked(requestHarnessTask).mock.calls[0][0].recipes.map((recipe) => recipe.id))
      .toEqual(["unrelated_0", "unrelated_1", "relevant_0"]);
  });

  it.each([true, false])("sends no recipes when the current source scope is empty (Notebook %s)", async (notebook) => {
    const { state } = scopedContext(1);
    state.notebookContext = notebook ? { ...state.notebookContext!, sourceIds: [] } : undefined;
    state.activeDataSource = undefined;
    state.execution.present.pages.find((page) => page.id === state.activePageId)!.root.children = [];
    await createStudioAssistantActions(state).handleGenerateAiPlan("说明当前工作区");
    const request = vi.mocked(requestHarnessTask).mock.calls[0][0];
    expect(request.recipes).toEqual([]);
    expect(harnessPublicRequestSchema.safeParse(request).success).toBe(true);
  });

  it("preserves all 20 relevant recipes at the public request boundary", async () => {
    const { state } = scopedContext(20);
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    const request = vi.mocked(requestHarnessTask).mock.calls[0][0];
    expect(request.recipes.map((recipe) => recipe.id)).toEqual(Array.from({ length: 20 }, (_, index) => `relevant_${index}`));
    expect(harnessPublicRequestSchema.safeParse(request).success).toBe(true);
  });

  it("blocks 21 relevant recipes explicitly before clearing drafts, previews, or persisting a task", async () => {
    const { state, values } = scopedContext(21);
    const before = structuredClone(state.dataProduct);
    expect(harnessPublicRequestSchema.shape.recipes.safeParse(state.dataProduct.recipes
      .filter((recipe) => recipe.sourceDatasetId === state.activeDataSource!.id)).success).toBe(false);
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    expect(requestHarnessTask).not.toHaveBeenCalled();
    expect(values.aiRequestStatus).toBe("error");
    expect(values.aiRequestError).toContain("21 个相关数据配方");
    expect(values.aiRequestError).toContain("最多 20 个");
    expect(state.assistant.setAiInstruction).not.toHaveBeenCalled();
    expect(state.setExecution).not.toHaveBeenCalled();
    expect(state.auditCurrentPreviewCancellation).not.toHaveBeenCalled();
    expect(state.persistExplicitly).not.toHaveBeenCalled();
    expect(values.harnessTasks).toEqual([]);
    expect(state.assistant.harnessRequestActiveRef.current).toBe(false);
    expect(state.dataProduct).toEqual(before);
  });
});

describe("聊天控制器保持请求、会话与确认边界", () => {
  it("does not include transient diagnostic code in a subsequent chat request", async () => {
    const { state } = context();
    const source = "diagnostic-only-synthetic-source";
    const task = { ...createHarnessTask("diagnostic_previous", "检查单元", state.activePageId, "editor", harnessUiClock),
      state: "failed" as const, resultMessage: "单元运行失败。", notebookDiagnostics: {
        version: 1 as const, baseRevision: 0, status: "unavailable" as const, omittedCellCount: 0,
        cells: [{ cellId: "python_example", kind: "python" as const, title: "测试", status: "unknown" as const,
          source, sourceChars: source.length, sourceTruncated: false }],
      } };
    state.assistant.harnessTasks = [task];
    state.assistant.assistantConversation = [{ id: "diagnostic_turn", taskId: task.id, pageId: state.activePageId,
      instruction: "检查单元", response: "单元运行失败。", state: "failed", createdAt: task.createdAt }];
    await createStudioAssistantActions(state).handleGenerateAiPlan("解释前一次任务的失败状态");
    const request = vi.mocked(requestHarnessTask).mock.calls[0][0];
    expect(request.conversationContext?.previousAssistantMessage).toBe("单元运行失败。");
    expect(JSON.stringify(request)).not.toContain(source);
    expect(JSON.stringify(request)).not.toContain("notebookDiagnostics");
    expect(task.notebookDiagnostics.cells[0].source).toBe(source);
  });
  it("switches only to a current-project thread and restores its draft, reply and task", () => {
    const { state, values } = context();
    const session = newAssistantSession([{ id: "turn", instruction: "另一个问题", response: "独立回答", createdAt: new Date().toISOString(), state: "success", taskId: "saved-task" }]);
    session.draft = "会话草稿"; state.assistant.assistantSessions.items.push(session);
    state.assistant.harnessTasks = [{ ...createHarnessTask("saved_request", "另一个问题", state.activePageId, "editor", harnessUiClock), id: "saved-task", state: "completed" }];
    const actions = createStudioAssistantActions(state);
    actions.handleSelectAssistantSession("another_project_thread"); expect(state.persistExplicitly).not.toHaveBeenCalled();
    actions.handleSelectAssistantSession(session.id);
    expect(activeAssistantSession(values.assistantSessions as AssistantSessions)).toEqual(session);
    expect(values.lastHarnessTaskId).toBe("saved-task"); expect(values.aiMessage).toBe("独立回答");
    expect(requestHarnessTask).not.toHaveBeenCalled();
  });
  it.each([
    ["failed", "error"], ["blocked", "blocked"], ["cancelled", "cancelled"],
  ] as const)("restores the saved %s reply as the retry error when selecting its session", (turnState, requestStatus) => {
    const { state, values } = context();
    const response = `Synthetic saved ${turnState} response`;
    const task = { ...createHarnessTask(`saved_${turnState}`, "检查测试数据", state.activePageId, "editor", harnessUiClock),
      state: turnState, resultMessage: response };
    const session = newAssistantSession([{ id: `turn_${turnState}`, taskId: task.id, pageId: state.activePageId,
      instruction: task.instruction, response, createdAt: task.createdAt, state: turnState }]);
    session.draft = "保留未发送的问题";
    state.assistant.assistantSessions.items.push(session);
    state.assistant.harnessTasks = [task];
    const original = structuredClone({ execution: state.execution, product: state.dataProduct, task, session });

    createStudioAssistantActions(state).handleSelectAssistantSession(session.id);

    expect(values.aiRequestStatus).toBe(requestStatus);
    expect(values.aiRequestError).toBe(response);
    expect(values.aiMessage).toBe(response);
    expect(values.lastSubmittedInstruction).toBe(task.instruction);
    expect(values.lastHarnessTaskId).toBe(task.id);
    expect(values.hasValidAiPlan).toBe(false);
    expect(activeAssistantSession(values.assistantSessions as AssistantSessions)).toEqual(original.session);
    expect(state.persistExplicitly).toHaveBeenCalledExactlyOnceWith(state.execution, state.auditRecords,
      state.queryRecords, state.dataProduct, [task], state.edsWorkspace, session.turns,
      { ...state.assistant.assistantSessions, activeId: session.id });
    expect(requestHarnessTask).not.toHaveBeenCalled();
    expect(clearHarnessConversations).not.toHaveBeenCalled();
    expect(state.setExecution).not.toHaveBeenCalled();
    expect(state.auditCurrentPreviewCancellation).not.toHaveBeenCalled();
    expect(state.assistant.setHarnessTasks).not.toHaveBeenCalled();
    expect({ execution: state.execution, product: state.dataProduct, task, session }).toEqual(original);
  });
  it.each([true, false])("clears stale retry errors when selecting a success or empty session (has reply %s)", (hasReply) => {
    const { state, values } = context();
    const session = newAssistantSession(hasReply ? [{ id: "completed_turn", instruction: "已完成的问题",
      response: "已完成的回答", createdAt: "2026-09-23T00:00:00.000Z", state: "success" }] : []);
    state.assistant.assistantSessions.items.push(session);
    state.assistant.aiRequestError = "Another session failed";
    state.assistant.aiRequestStatus = "error";
    createStudioAssistantActions(state).handleSelectAssistantSession(session.id);
    expect(values.aiRequestStatus).toBe(hasReply ? "success" : "idle");
    expect(values.aiRequestError).toBeNull();
    expect(values.lastHarnessTaskId).toBe("");
    expect(values.hasValidAiPlan).toBe(false);
    expect(requestHarnessTask).not.toHaveBeenCalled();
    expect(clearHarnessConversations).not.toHaveBeenCalled();
    expect(state.setExecution).not.toHaveBeenCalled();
  });
  it("preserves a failed turn's retry identity when its task summary has been evicted", () => {
    const { state, values } = context();
    const session = newAssistantSession([{ id: "evicted_turn", instruction: "分析测试表",
      response: "本次测试任务没有完成。", createdAt: "2026-09-23T00:00:00.000Z", state: "failed", taskId: "evicted_task" }]);
    state.assistant.assistantSessions.items.push(session);
    state.assistant.harnessTasks = [];
    createStudioAssistantActions(state).handleSelectAssistantSession(session.id);
    expect(values.lastHarnessTaskId).toBe("evicted_task");
    expect(values.lastSubmittedInstruction).toBe(session.turns[0].instruction);
    expect(values.aiRequestStatus).toBe("error");
    expect(values.aiRequestError).toBe(session.turns[0].response);
    expect(values.isLocalAssistantReply).toBe(false);
    expect(values.hasValidAiPlan).toBe(false);
    expect(requestHarnessTask).not.toHaveBeenCalled();
    expect(state.assistant.setHarnessTasks).not.toHaveBeenCalled();
    expect(state.setExecution).not.toHaveBeenCalled();
  });
  it("restores a pending ChangeSet as confirmation, not as a failed task retry", () => {
    const { state, values } = context();
    const pending = structuredClone(state.assistant.aiChangeSet);
    const task = { ...createHarnessTask("pending_confirmation", "修改测试图表", state.activePageId, "editor", harnessUiClock),
      state: "awaitingConfirmation" as const, pendingChangeSet: pending, resultMessage: "预览已生成，等待确认。" };
    const session = newAssistantSession([{ id: "pending_turn", taskId: task.id, instruction: task.instruction,
      response: task.resultMessage, createdAt: task.createdAt, state: "success" }]);
    state.assistant.assistantSessions.items.push(session);
    state.assistant.harnessTasks = [task];
    state.assistant.aiRequestError = "Another task failed";
    createStudioAssistantActions(state).handleSelectAssistantSession(session.id);
    expect(values.aiRequestStatus).toBe("success");
    expect(values.aiRequestError).toBeNull();
    expect(values.hasValidAiPlan).toBe(true);
    expect(values.aiChangeSet).toEqual(pending);
    expect(values.lastHarnessTaskId).toBe(task.id);
    expect(requestHarnessTask).not.toHaveBeenCalled();
    expect(state.setExecution).not.toHaveBeenCalled();
    expect(state.auditCurrentPreviewCancellation).not.toHaveBeenCalled();
  });
  it.each([true, false])("restores only the selected session's in-memory images, without inventing persisted attachments (%s)", (hasSessionImages) => {
    const { state } = context();
    const draft = new File(["target draft"], "selected.png", { type: "image/png" });
    const submitted = new File(["target submitted"], "selected-submitted.png", { type: "image/png" });
    let finished = false;
    function Probe() {
      const [step, setStep] = useState(0), [page, setPage] = useState("page_a");
      const assistant = useStudioAssistantState(state.assistant.aiChangeSet, page);
      // The owner hook schedules its own rerender before exposing children.
      if (activeAssistantSession(assistant.assistantSessions).pageId !== page) return null;
      if (step === 0) {
        if (hasSessionImages) { assistant.setAiImageAttachments([draft]); assistant.setLastSubmittedImages([submitted]); }
        setStep(1);
      } else if (step === 1) {
        setPage("page_b"); setStep(2);
      } else if (step === 2) {
        expect(assistant.aiImageAttachments).toEqual([]);
        expect(assistant.lastSubmittedImages).toEqual([]);
        setPage("page_a"); setStep(3);
      } else if (step === 3) {
        expect(assistant.aiImageAttachments).toEqual(hasSessionImages ? [draft] : []);
        expect(assistant.lastSubmittedImages).toEqual(hasSessionImages ? [submitted] : []);
        expect(JSON.stringify(assistant.assistantSessions)).not.toContain("selected.png");
        assistant.clearSessionImages(); setStep(4);
      } else {
        expect(assistant.aiImageAttachments).toEqual([]);
        expect(assistant.lastSubmittedImages).toEqual([]);
        finished = true;
      }
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    expect(finished).toBe(true);
    expect(requestHarnessTask).not.toHaveBeenCalled();
  });
  it("rejects a session owned by another interface even if its ID is supplied directly", () => {
    const { state } = context();
    const other = newAssistantSession([], "another_page");
    state.assistant.assistantSessions.items.push(other);
    createStudioAssistantActions(state).handleSelectAssistantSession(other.id);
    expect(state.assistant.setAssistantSessions).not.toHaveBeenCalled();
    expect(state.persistExplicitly).not.toHaveBeenCalled();
  });
  it("scopes legacy in-memory state before exposing it and restores errors only on their owning page", () => {
    const { state } = context();
    const now = new Date().toISOString();
    const old = createAssistantSessions([
      { id: "page_a_turn", pageId: "page_a", instruction: "A 问题", response: "A 回复", state: "success", createdAt: now },
      { id: "page_b_turn", pageId: "page_b", instruction: "B 问题", response: "B 失败", state: "failed", createdAt: now },
    ]);
    old.items[0].draft = "B 的旧草稿";
    let finished = false;
    function Probe() {
      const [page, setPage] = useState("page_a"), [step, setStep] = useState(0);
      const assistant = useStudioAssistantState(state.assistant.aiChangeSet, page);
      if (activeAssistantSession(assistant.assistantSessions).pageId !== page) return null;
      if (step === 0) { assistant.setAssistantSessions(old); setStep(1); }
      else if (step === 1) {
        expect(assistant.assistantConversation.map((turn) => turn.instruction)).toEqual(["A 问题"]);
        expect(assistant.aiRequestError).toBeNull();
        expect(assistant.aiInstruction).toBe("");
        setPage("page_b"); setStep(2);
      } else if (step === 2) {
        expect(assistant.aiRequestError).toBe("B 失败");
        expect(assistant.lastSubmittedInstruction).toBe("B 问题");
        expect(assistant.aiInstruction).toBe("B 的旧草稿");
        setPage("page_c"); setStep(3);
      } else {
        expect(assistant.assistantConversation).toEqual([]);
        expect(assistant.aiRequestError).toBeNull();
        expect(assistant.lastSubmittedInstruction).toBe("");
        expect(assistant.hasValidAiPlan).toBe(false);
        finished = true;
      }
      return null;
    }
    renderToStaticMarkup(createElement(Probe));
    expect(finished).toBe(true);
    expect(requestHarnessTask).not.toHaveBeenCalled();
  });
  it("does not send a request with another interface's current session", async () => {
    const { state } = context();
    state.assistant.assistantSessions = createAssistantSessions([], "another_page");
    await createStudioAssistantActions(state).handleGenerateAiPlan();
    expect(requestHarnessTask).not.toHaveBeenCalled();
    expect(state.persistExplicitly).not.toHaveBeenCalled();
  });
  it("preserves old threads and blocks switching during a request or preview", () => {
    const { state, values } = context();
    state.assistant.assistantSessions = createAssistantSessions([{ id: "first", instruction: "你好", response: "你好", createdAt: new Date().toISOString(), state: "success" }]);
    const actions = createStudioAssistantActions(state);
    state.assistant.harnessRequestActiveRef.current = true;
    actions.handleNewAssistantSession(); expect(state.persistExplicitly).not.toHaveBeenCalled();
    state.assistant.harnessRequestActiveRef.current = false; state.conversationSwitchBlocked = true;
    actions.handleNewAssistantSession(); expect(state.persistExplicitly).not.toHaveBeenCalled();
    state.conversationSwitchBlocked = false; actions.handleNewAssistantSession();
    const sessions = values.assistantSessions as AssistantSessions;
    expect(sessions.items).toHaveLength(2); expect(sessions.items[0]).toEqual(state.assistant.assistantSessions.items[0]);
    expect(activeAssistantSession(sessions).turns).toEqual([]);
    expect(values.lastHarnessTaskId).toBe(""); expect(values.hasValidAiPlan).toBe(false);
  });
  it("完整工作簿提问默认携带原件，普通数据请求不附带无关原件", async () => {
    const { state } = context();
    const file = new File(["synthetic-workbook"], "analysis.xlsx");
    state.activeOriginalWorkbook = { file, sheetNames: ["First", "Second"] };
    await createStudioAssistantActions(state).handleGenerateAiPlan("读取原始工作簿，统计所有工作表的行数");
    expect(vi.mocked(requestHarnessTask).mock.calls.at(-1)?.[1]?.rawWorkbook).toBe(file);
    await createStudioAssistantActions(state).handleGenerateAiPlan("请检查当前数据的字段结构");
    expect(vi.mocked(requestHarnessTask).mock.calls.at(-1)?.[1]?.rawWorkbook).toBeUndefined();
  });

  it("刷新后原件不可用时不伪造附件，显式指定的数据源原件仍可读取", async () => {
    const { state } = context();
    await createStudioAssistantActions(state).handleGenerateAiPlan("读取原始工作簿第 2 行");
    expect(vi.mocked(requestHarnessTask).mock.calls.at(-1)?.[1]?.rawWorkbook).toBeUndefined();
    const file = new File(["synthetic-other-workbook"], "selected.xlsx");
    await createStudioAssistantActions(state).handleGenerateAiPlan("读取原始工作簿第 2 行", undefined, { dataSourceId: state.activeDataSource!.id, rawWorkbook: file });
    expect(vi.mocked(requestHarnessTask).mock.calls.at(-1)?.[1]?.rawWorkbook).toBe(file);
  });

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
      state.dataProduct, state.assistant.harnessTasks, state.edsWorkspace, [], expect.objectContaining({ activeId: state.assistant.assistantSessions.activeId }));
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
