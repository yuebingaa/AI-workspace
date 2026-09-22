"use client";

import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import type { AiPlanMetadata } from "@/core/ai/contracts";
import { cancelPreview } from "@/core/changesets";
import { EDS_WORKSPACE_PAGE_ID, type EdsWorkspaceSnapshot } from "@/core/eds";
import { HarnessClientError, requestHarnessTask } from "@/core/harness/client";
import { DEFAULT_HARNESS_LIMITS, MAX_HARNESS_IMAGE_ATTACHMENTS, MAX_HARNESS_IMAGE_BYTES, MAX_HARNESS_TOTAL_IMAGE_BYTES, MAX_HARNESS_REQUEST_RECIPES, type HarnessExecutionTiming, type HarnessTaskSummary } from "@/core/harness/contracts";
import { appendAssistantConversationTurn, assistantConversationFromHarnessTasks, isLightweightConversation, isUiMutationCapabilityQuestion, lightweightConversationReply, uiMutationCapabilityReply, type AssistantConversationTurn } from "@/core/harness/conversation";
import { harnessConversationId, clearHarnessConversations } from "@/core/harness/conversation-client";
import { activeAssistantSession, createAssistantSessions, MAX_ASSISTANT_SESSIONS, newAssistantSession, updateActiveAssistantSession, type AssistantSessions } from "@/core/harness/assistant-sessions";
import { failureResponse } from "@/core/harness/failure-response";
import { instructionRequestsRawWorkbook } from "@/core/harness/raw-workbook";
import { resolveHarnessPageDataSourceIds } from "@/core/harness/source-scope";
import { appendHarnessEvent, appendHarnessTask, createHarnessTask, type HarnessTaskClock } from "@/core/harness/task-state";
import type { AppSpec, ChangeSet, ChangeSetAuditRecord, DataProduct, DataSourceDefinition, QueryExecutionRecord } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import { readableValidationError } from "@/core/schemas";
import { selectedSemanticModel } from "@/core/semantic/model";
import type { HarnessPublicRequest } from "@/core/harness/contracts";
import type { AiRequestUiStatus } from "../AiBuilderAssistant";
import type { ImportedWorkbookAttachment } from "../CsvUploadDialog";
import type { PersistWorkspace, WorkspaceFeedback, WorkspacePreviewBindings } from "./contracts";

export const harnessUiClock: HarnessTaskClock = {
  now: () => new Date(),
  id: () => `harness_ui_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`,
};

function initialHarnessTiming(): HarnessExecutionTiming {
  return {
    phase: "planning",
    activeElapsedMs: 0,
    remainingMs: DEFAULT_HARNESS_LIMITS.totalExecutionTimeoutMs,
    totalBudgetMs: DEFAULT_HARNESS_LIMITS.totalExecutionTimeoutMs,
    modelRequestTimeoutMs: DEFAULT_HARNESS_LIMITS.modelRequestTimeoutMs,
    toolCallTimeoutMs: DEFAULT_HARNESS_LIMITS.toolCallTimeoutMs,
    modelDurationMs: 0,
    toolDurationMs: 0,
    otherDurationMs: 0,
    retainedObservationCount: 0,
  };
}

export function useStudioAssistantState(repurchaseChangeSet: ChangeSet) {
  const [aiChangeSet, setAiChangeSet] = useState<ChangeSet>(() => structuredClone(repurchaseChangeSet));
  const [aiMessage, setAiMessage] = useState("我已检查数据结构和当前画布，建议先预览以下结构化变更。");
  const [aiMetadata, setAiMetadata] = useState<AiPlanMetadata | null>(null);
  const [assistantSessions, setAssistantSessions] = useState(createAssistantSessions);
  const selectedSession = activeAssistantSession(assistantSessions);
  const aiInstruction = selectedSession.draft;
  const setAiInstruction = useCallback((value: SetStateAction<string>) => setAssistantSessions((sessions) => {
    const draft = typeof value === "function" ? value(activeAssistantSession(sessions).draft) : value;
    if (draft === activeAssistantSession(sessions).draft) return sessions;
    return updateActiveAssistantSession(sessions, { draft });
  }), []);
  const [aiImageAttachments, setAiImageAttachments] = useState<File[]>([]);
  const [lastSubmittedImages, setLastSubmittedImages] = useState<File[]>([]);
  const [lastSubmittedInstruction, setLastSubmittedInstruction] = useState("");
  const [aiRequestStatus, setAiRequestStatus] = useState<AiRequestUiStatus>("idle");
  const [aiRequestError, setAiRequestError] = useState<string | null>(null);
  const [hasValidAiPlan, setHasValidAiPlan] = useState(true);
  const [harnessTasks, setHarnessTasks] = useState<HarnessTaskSummary[]>([]);
  const assistantConversation = selectedSession.turns;
  const setAssistantConversation = useCallback((value: SetStateAction<AssistantConversationTurn[]>) => setAssistantSessions((sessions) => {
    const turns = typeof value === "function" ? value(activeAssistantSession(sessions).turns) : value;
    if (turns === activeAssistantSession(sessions).turns) return sessions;
    return updateActiveAssistantSession(sessions, { turns });
  }), []);
  const [isSessionChanging, setIsSessionChanging] = useState(false);
  const sessionImagesRef = useRef(new Map<string, { draft: File[]; submitted: File[] }>());
  const [lastHarnessTaskId, setLastHarnessTaskId] = useState("");
  const [isLocalAssistantReply, setIsLocalAssistantReply] = useState(false);
  const aiRequestAbortRef = useRef<AbortController | null>(null);
  const harnessRequestActiveRef = useRef(false);
  useEffect(() => () => aiRequestAbortRef.current?.abort(), []);
  return {
    aiChangeSet,
    setAiChangeSet,
    aiMessage,
    setAiMessage,
    aiMetadata,
    setAiMetadata,
    aiInstruction,
    setAiInstruction,
    aiImageAttachments,
    setAiImageAttachments,
    lastSubmittedImages,
    setLastSubmittedImages,
    lastSubmittedInstruction,
    setLastSubmittedInstruction,
    aiRequestStatus,
    setAiRequestStatus,
    aiRequestError,
    setAiRequestError,
    hasValidAiPlan,
    setHasValidAiPlan,
    harnessTasks,
    setHarnessTasks,
    assistantConversation,
    setAssistantConversation,
    assistantSessions,
    setAssistantSessions,
    isSessionChanging,
    setIsSessionChanging,
    sessionImagesRef,
    lastHarnessTaskId,
    setLastHarnessTaskId,
    isLocalAssistantReply,
    setIsLocalAssistantReply,
    aiRequestAbortRef,
    harnessRequestActiveRef
  };
}
export type StudioAssistantState = ReturnType<typeof useStudioAssistantState>;

export interface StudioAssistantActionsContext extends WorkspaceFeedback,
  Pick<WorkspacePreviewBindings, "execution" | "setExecution" | "setPendingPuckChangeSet" | "setPendingChangeSource" | "setCanvasMode" | "auditCurrentPreviewCancellation"> {
  assistant: StudioAssistantState;
  role: StudioRole;
  activePageId: string;
  renderedSpec: AppSpec;
  activeDataSource: DataSourceDefinition | undefined;
  activeOriginalWorkbook: ImportedWorkbookAttachment | undefined;
  edsWorkspace: EdsWorkspaceSnapshot | null;
  dataProduct: DataProduct;
  auditRecords: ChangeSetAuditRecord[];
  queryRecords: QueryExecutionRecord[];
  persistExplicitly: PersistWorkspace;
  notebookContext?: HarnessPublicRequest["notebookContext"];
  notebookInteractionBusy?: boolean;
  conversationSwitchBlocked?: boolean;
}

export function createStudioAssistantActions(context: StudioAssistantActionsContext) {
  const { setAiChangeSet, setAiMessage, setAiMetadata, aiInstruction, setAiInstruction, aiImageAttachments, setAiImageAttachments, lastSubmittedImages, setLastSubmittedImages, lastSubmittedInstruction, setLastSubmittedInstruction, aiRequestStatus, setAiRequestStatus, setAiRequestError, setHasValidAiPlan, harnessTasks, setHarnessTasks, assistantConversation, setAssistantConversation, lastHarnessTaskId, setLastHarnessTaskId, setIsLocalAssistantReply, aiRequestAbortRef, harnessRequestActiveRef } = context.assistant;
  const {
    role, activePageId, renderedSpec, activeDataSource, activeOriginalWorkbook,
    edsWorkspace, dataProduct, execution, auditRecords, queryRecords, persistExplicitly,
    setExecution, setPendingPuckChangeSet, setPendingChangeSource, setCanvasMode,
    auditCurrentPreviewCancellation, setValidationError, setSaveLabel,
  } = context;
  const { assistantSessions, setAssistantSessions, sessionImagesRef, setIsSessionChanging } = context.assistant;
  const selectedSession = activeAssistantSession(assistantSessions);

  async function handleGenerateAiPlan(
    instructionOverride?: string,
    retryOfTaskId?: string,
    analysisContext?: { dataSourceId: string; rawWorkbook?: File },
  ) {
    if (context.notebookInteractionBusy) {
      setAiRequestError("请先保存或取消 Notebook 单元编辑，并等待当前查询结束，再交给 AI 处理。");
      return;
    }
    const submittedImages = retryOfTaskId ? lastSubmittedImages : instructionOverride ? [] : aiImageAttachments;
    const submittedInstruction = (instructionOverride ?? aiInstruction).trim() || (submittedImages.length ? "请分析我上传的图片。" : "");
    if (!submittedInstruction || harnessRequestActiveRef.current || context.assistant.isSessionChanging) return;

    const requestedDataSource = analysisContext
      ? renderedSpec.dataSources.find((source) => source.id === analysisContext.dataSourceId)
      : context.notebookContext && !context.notebookContext.sourceIds.includes(activeDataSource?.id ?? "")
        ? renderedSpec.dataSources.find((source) => source.id === context.notebookContext?.sourceIds[0])
        : activeDataSource;
    const semanticModel = selectedSemanticModel(dataProduct, activePageId, requestedDataSource?.id ?? "");
    const requestedWorkbook = analysisContext?.rawWorkbook
      ? { file: analysisContext.rawWorkbook }
      : activeOriginalWorkbook;
    const hasEdsContext = Boolean(edsWorkspace && activePageId === EDS_WORKSPACE_PAGE_ID);
    const localReply = !retryOfTaskId && submittedImages.length === 0
      ? isLightweightConversation(submittedInstruction)
        ? lightweightConversationReply(submittedInstruction, hasEdsContext)
        : isUiMutationCapabilityQuestion(submittedInstruction)
          ? uiMutationCapabilityReply(hasEdsContext)
          : undefined
      : undefined;
    if (localReply) {
      const nextConversation = appendAssistantConversationTurn(assistantConversation, {
        id: `local_conversation_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`,
        pageId: activePageId,
        instruction: submittedInstruction,
        response: localReply,
        createdAt: new Date().toISOString(),
        state: "success",
      });
      setLastSubmittedInstruction(submittedInstruction);
      setAiInstruction("");
      setAiMessage(localReply);
      setAssistantConversation(nextConversation);
      setAiMetadata(null);
      setAiRequestStatus("success");
      setAiRequestError(null);
      setHasValidAiPlan(false);
      setValidationError(null);
      setIsLocalAssistantReply(true);
      setSaveLabel("已回复 · 未调用 DeepSeek");
      persistExplicitly(execution, auditRecords, queryRecords, dataProduct, harnessTasks, edsWorkspace, nextConversation,
        updateActiveAssistantSession(assistantSessions, { turns: nextConversation, draft: "" }));
      return;
    }

    const recipeSourceIds = new Set(resolveHarnessPageDataSourceIds({
      appSpec: execution.present, pageId: activePageId, instruction: submittedInstruction,
      dataSourceId: requestedDataSource?.id, notebookContext: context.notebookContext,
    }));
    const requestRecipes = dataProduct.recipes.filter((recipe) => recipeSourceIds.has(recipe.sourceDatasetId));
    if (requestRecipes.length > MAX_HARNESS_REQUEST_RECIPES) {
      setAiRequestError(`当前分析范围有 ${requestRecipes.length} 个相关数据配方，单次请求最多 ${MAX_HARNESS_REQUEST_RECIPES} 个。请缩小数据范围，或整理该来源的配方后重试；本次未发送请求，配方和草稿均已保留。`);
      setAiRequestStatus("error");
      return;
    }

    aiRequestAbortRef.current?.abort();
    const controller = new AbortController();
    aiRequestAbortRef.current = controller;
    harnessRequestActiveRef.current = true;
    const baseExecution = cancelPreview(execution);
    if (execution.preview) auditCurrentPreviewCancellation();
    const idempotencyKey = `request_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`;
    const initialTask = createHarnessTask(idempotencyKey, submittedInstruction, activePageId, role, harnessUiClock, {
      executionTiming: initialHarnessTiming(),
      ...(retryOfTaskId ? { retryOfTaskId } : {}),
    });
    const initialTasks = appendHarnessTask(harnessTasks, initialTask);
    const requestSessions = updateActiveAssistantSession(assistantSessions, {
      pendingTaskId: initialTask.id,
      pageIds: [...new Set([...selectedSession.pageIds, activePageId])].slice(-100), draft: retryOfTaskId ? aiInstruction : "",
    });
    setAssistantSessions(requestSessions);
    let progressTask = initialTask;
    setExecution(baseExecution);
    setHarnessTasks(initialTasks);
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    setCanvasMode("preview");
    setLastSubmittedInstruction(submittedInstruction);
    setLastSubmittedImages(submittedImages);
    if (!retryOfTaskId) setAiInstruction("");
    if (!retryOfTaskId) setAiImageAttachments([]);
    setLastHarnessTaskId(initialTask.id);
    setIsLocalAssistantReply(false);
    setAiRequestStatus("loading");
    setAiRequestError(null);
    setHasValidAiPlan(false);
    setValidationError(null);
    setSaveLabel("Harness 运行中 · 正式 AppSpec 未修改");
    persistExplicitly(baseExecution, auditRecords, queryRecords, dataProduct, initialTasks, edsWorkspace, assistantConversation, requestSessions);

    try {
      const pageConversation = assistantConversation.filter((turn) =>
        (turn.pageId ?? harnessTasks.find((candidate) => candidate.id === turn.taskId)?.pageId) === activePageId);
      const previousConversationTurn = pageConversation.at(-1);
      const previousInstruction = (previousConversationTurn?.instruction ?? "").trim().slice(0, 1_000);
      const previousAssistantMessage = (previousConversationTurn?.response ?? "").trim().slice(0, 2_000);
      const conversationTaskIds = new Set(assistantConversation.flatMap((turn) => turn.taskId ? [turn.taskId] : []));
      const previousWorkingMemory = harnessTasks.find((task) => {
        const memory = task.workingMemory;
        return task.pageId === activePageId && conversationTaskIds.has(task.id) && Boolean(memory) && Boolean(
          memory && (memory.completedSteps.length
            || memory.keyStatistics.length
            || memory.pendingGoals.length
            || memory.failedAttempts.length),
        );
      })?.workingMemory;
      const hasConversationContext = previousInstruction.length > 0
        || previousAssistantMessage.length > 0
        || Boolean(previousWorkingMemory);
      const { task } = await requestHarnessTask({
        idempotencyKey,
        conversation_id: harnessConversationId(activePageId, selectedSession.contextId),
        instruction: submittedInstruction,
        pageId: activePageId,
        ...(requestedDataSource ? { dataSourceId: requestedDataSource.id } : {}),
        ...(semanticModel ? { semanticModel } : {}),
        ...(context.notebookContext ? { notebookContext: context.notebookContext } : {}),
        ...(hasConversationContext ? {
          conversationContext: {
            recentMessages: pageConversation.slice(-10).map(({ instruction, response }) => ({ instruction, response })),
            ...(previousInstruction ? { previousInstruction } : {}),
            ...(previousAssistantMessage ? { previousAssistantMessage } : {}),
            ...(previousWorkingMemory ? { workingMemory: previousWorkingMemory } : {}),
          },
        } : {}),
        appSpec: baseExecution.present,
        recipes: requestRecipes,
        ...(edsWorkspace ? { edsWorkspace } : {}),
        ...(retryOfTaskId ? { retryOfTaskId } : {}),
      }, {
        signal: controller.signal,
        stream: true,
        onEvent: (event) => {
          if (controller.signal.aborted || event.taskId !== initialTask.id) return;
          progressTask = { ...progressTask, state: event.taskState ?? progressTask.state,
            counters: event.counters ?? progressTask.counters, executionTiming: event.executionTiming ?? progressTask.executionTiming,
            updatedAt: event.timestamp, trace: [...(progressTask.trace ?? []), event].slice(-256) };
          setHarnessTasks((tasks) => appendHarnessTask(tasks, progressTask));
        },
        ...(submittedImages.length ? { imageAttachments: submittedImages } : {}),
        ...(requestedWorkbook && instructionRequestsRawWorkbook(submittedInstruction, previousInstruction)
          ? { rawWorkbook: requestedWorkbook.file }
          : {}),
      });
      const nextTasks = appendHarnessTask(initialTasks, task);
      const [conversationTurn] = assistantConversationFromHarnessTasks([task]);
      const nextConversation = conversationTurn
        ? appendAssistantConversationTurn(assistantConversation, conversationTurn)
        : assistantConversation;
      setHarnessTasks(nextTasks);
      setAssistantConversation(nextConversation);
      setAiMetadata(null);
      setAiMessage(task.resultMessage ?? task.events.at(-1)?.message ?? "Harness 任务已结束。");
      if (task.state === "awaitingConfirmation" && task.pendingChangeSet) {
        setAiChangeSet(task.pendingChangeSet);
        setAiRequestStatus("success");
        setAiRequestError(null);
        setHasValidAiPlan(true);
        setSaveLabel("Harness 已暂停 · 等待人工确认");
      } else if (task.state === "awaitingConfirmation" && task.notebookArtifact) {
        setAiRequestStatus("success"); setAiRequestError(null); setHasValidAiPlan(false);
        setSaveLabel("Notebook 草稿待采用 · 看板未修改");
      } else if (task.state === "completed") {
        setAiRequestStatus("success");
        setAiRequestError(null);
        setHasValidAiPlan(false);
        setSaveLabel(task.exportArtifact ? "Harness 已完成 · Excel 可下载" : "Harness 已完成 · 只读任务");
      } else {
        const taskError = task.resultMessage ?? task.error ?? (task.state === "cancelled" ? "这次任务已停止。" : "这次任务暂时没能完成，请稍后重试。");
        setAiRequestStatus(task.state === "blocked" ? "blocked" : task.state === "cancelled" ? "cancelled" : "error");
        setAiRequestError(taskError);
        setHasValidAiPlan(false);
        setSaveLabel("已保存 · Harness 未修改 AppSpec");
      }
      persistExplicitly(baseExecution, auditRecords, queryRecords, dataProduct, nextTasks, edsWorkspace, nextConversation,
        updateActiveAssistantSession(requestSessions, { turns: nextConversation }));
    } catch (error) {
      const clientError = error instanceof HarnessClientError
        ? error
        : new HarnessClientError("invalid_response", readableValidationError(error), true);
      const nextStatus: AiRequestUiStatus = clientError.code === "timeout"
        ? "timeout"
        : clientError.code === "cancelled"
          ? "cancelled"
          : "error";
      setAiRequestStatus(nextStatus);
      setAiMetadata(null);
      setHasValidAiPlan(false);
      setSaveLabel("已保存 · Harness 未修改 AppSpec");
      const failedTask = appendHarnessEvent(progressTask, {
        type: clientError.code === "cancelled" ? "state" : "error",
        state: clientError.code === "cancelled" ? "cancelled" : "failed",
        message: clientError.message,
      }, harnessUiClock, { error: clientError.message });
      failedTask.resultMessage = failureResponse(failedTask);
      setAiRequestError(failedTask.resultMessage);
      setAiMessage(failedTask.resultMessage);
      const nextTasks = appendHarnessTask(initialTasks, failedTask);
      const [conversationTurn] = assistantConversationFromHarnessTasks([failedTask]);
      const nextConversation = conversationTurn
        ? appendAssistantConversationTurn(assistantConversation, conversationTurn)
        : assistantConversation;
      setHarnessTasks(nextTasks);
      setAssistantConversation(nextConversation);
      persistExplicitly(baseExecution, auditRecords, queryRecords, dataProduct, nextTasks, edsWorkspace, nextConversation,
        updateActiveAssistantSession(requestSessions, { turns: nextConversation }));
    } finally {
      if (aiRequestAbortRef.current === controller) aiRequestAbortRef.current = null;
      harnessRequestActiveRef.current = false;
    }
  }


  function handleCancelAiRequest() {
    aiRequestAbortRef.current?.abort();
  }


  async function handleClearAssistantConversation() {
    if (harnessRequestActiveRef.current || !assistantConversation.length || context.assistant.isSessionChanging) return;
    harnessRequestActiveRef.current = true;
    setIsSessionChanging(true);
    try { await clearHarnessConversations({ contextId: selectedSession.contextId,
      pageIds: [...selectedSession.pageIds, ...assistantConversation.flatMap((turn) => turn.pageId ? [turn.pageId] : [])] }); }
    catch { setAiRequestError("服务端上下文清除失败，尚未清除聊天。请稍后重试。"); return; }
    finally { harnessRequestActiveRef.current = false; setIsSessionChanging(false); }
    setAssistantConversation([]);
    const nextSessions = updateActiveAssistantSession(assistantSessions, { turns: [], draft: "", title: "新会话", pageIds: [], contextId: newAssistantSession().contextId });
    setAssistantSessions(nextSessions);
    setLastSubmittedInstruction("");
    setLastHarnessTaskId("");
    setAiImageAttachments([]);
    setLastSubmittedImages([]);
    setAiMessage("对话上下文已清除。下一条消息将作为新会话开始；Harness 任务与变更审计记录仍保留。");
    setAiRequestStatus("idle");
    setAiRequestError(null);
    setValidationError(null);
    setIsLocalAssistantReply(true);
    setHasValidAiPlan(false);
    setSaveLabel("已保存 · 对话上下文已清除");
    persistExplicitly(execution, auditRecords, queryRecords, dataProduct, harnessTasks, edsWorkspace, [], nextSessions);
  }

  function activateSession(nextSessions: AssistantSessions) {
    if (harnessRequestActiveRef.current || context.assistant.isSessionChanging || context.conversationSwitchBlocked || context.notebookInteractionBusy) return;
    const target = activeAssistantSession(nextSessions);
    sessionImagesRef.current.set(selectedSession.id, { draft: aiImageAttachments, submitted: lastSubmittedImages });
    setAssistantSessions(nextSessions);
    setAiImageAttachments(sessionImagesRef.current.get(target.id)?.draft ?? []);
    setLastSubmittedImages(sessionImagesRef.current.get(target.id)?.submitted ?? []);
    const last = target.turns.at(-1);
    const task = last?.taskId ? harnessTasks.find((candidate) => candidate.id === last.taskId) : undefined;
    setLastHarnessTaskId(task?.id ?? "");
    setLastSubmittedInstruction(last?.instruction ?? "");
    setAiMessage(last?.response ?? "从一个新问题开始。");
    setAiMetadata(null); setAiRequestError(null); setValidationError(null);
    setAiRequestStatus(last ? last.state === "failed" ? "error" : last.state : "idle");
    setIsLocalAssistantReply(!task);
    const pending = task?.state === "awaitingConfirmation" && task.pendingChangeSet;
    setHasValidAiPlan(Boolean(pending));
    if (pending) setAiChangeSet(pending);
    persistExplicitly(execution, auditRecords, queryRecords, dataProduct, harnessTasks, edsWorkspace, target.turns, nextSessions);
  }

  function handleSelectAssistantSession(id: string) {
    if (id === assistantSessions.activeId || !assistantSessions.items.some((item) => item.id === id)) return;
    activateSession({ ...assistantSessions, activeId: id });
  }
  function handleNewAssistantSession() {
    if (!selectedSession.turns.length && !aiInstruction && !aiImageAttachments.length) return;
    if (assistantSessions.items.length >= MAX_ASSISTANT_SESSIONS) { setAiRequestError(`当前项目最多保留 ${MAX_ASSISTANT_SESSIONS} 个会话。`); return; }
    const session = newAssistantSession();
    activateSession({ activeId: session.id, items: [...assistantSessions.items, session] });
  }


  function handleRetryAiRequest() {
    if (lastSubmittedInstruction) void handleGenerateAiPlan(lastSubmittedInstruction, lastHarnessTaskId || undefined);
  }


  function handleImageAttachmentsChange(files: File[]) {
    const totalBytes = files.reduce((total, file) => total + file.size, 0);
    const invalid = files.length > MAX_HARNESS_IMAGE_ATTACHMENTS
      || totalBytes > MAX_HARNESS_TOTAL_IMAGE_BYTES
      || files.some((file) => file.size < 1
        || file.size > MAX_HARNESS_IMAGE_BYTES
        || !["image/jpeg", "image/png", "image/webp"].includes(file.type));
    if (invalid) {
      setAiRequestError("图片须为 JPEG、PNG 或 WebP；最多 3 张，单张不超过 3 MiB、合计不超过 6 MiB。");
      setAiRequestStatus("error");
      return;
    }
    setAiRequestError(null);
    if (aiRequestStatus === "error") setAiRequestStatus("idle");
    setAiImageAttachments(files);
  }

  return { handleGenerateAiPlan, handleCancelAiRequest, handleClearAssistantConversation, handleRetryAiRequest, handleImageAttachmentsChange, handleSelectAssistantSession, handleNewAssistantSession };
}

export function useStudioAssistantActions(context: StudioAssistantActionsContext) {
  return createStudioAssistantActions(context);
}
