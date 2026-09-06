"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import {
  appSpecRevision,
  appSpecToPuckData,
  initializePuckDraft,
  puckDataToChangeSet,
  updatePuckDraft,
  type PuckDraftOrigin,
  type StudioPuckData,
} from "@/adapters/puck";
import type { AiPlanMetadata } from "@/core/ai/contracts";
import {
  applyChangeSet,
  cancelPreview,
  createExecutionState,
  previewChangeSet,
  undoLastChange,
} from "@/core/changesets";
import { createChangeSetAuditRecord, createChangeSetAuditRecordFromSummary, appendChangeSetAuditRecord } from "@/core/audit";
import { appendQueryExecutionRecord } from "@/core/data";
import {
  HarnessClientError,
  requestHarnessTask,
} from "@/core/harness/client";
import {
  DEFAULT_HARNESS_LIMITS,
  MAX_HARNESS_IMAGE_ATTACHMENTS,
  MAX_HARNESS_IMAGE_BYTES,
  MAX_HARNESS_TOTAL_IMAGE_BYTES,
  type HarnessExecutionTiming,
  type HarnessTaskSummary,
} from "@/core/harness/contracts";
import {
  appendAssistantConversationTurn,
  assistantConversationFromHarnessTasks,
  isLightweightConversation,
  isUiMutationCapabilityQuestion,
  lightweightConversationReply,
  uiMutationCapabilityReply,
  type AssistantConversationTurn,
} from "@/core/harness/conversation";
import {
  appendHarnessEvent,
  appendHarnessTask,
  createHarnessTask,
  settleHarnessConfirmation,
  type HarnessTaskClock,
} from "@/core/harness/task-state";
import { instructionRequestsRawWorkbook } from "@/core/harness/raw-workbook";
import {
  confirmDatasetAiAccess,
  DatasetAiAccessConflictError,
  deleteUploadedDataset,
  loadUploadedDataset,
} from "@/core/datasets/client";
import type { DatasetUploadResponse, UploadedDatasetDescriptor } from "@/core/datasets";
import {
  removeUploadedDatasetFromWorkspace,
  synchronizeUploadedDatasetExecution,
  synchronizeUploadedDatasetProduct,
  synchronizeUploadedDatasetWorkspace,
} from "@/core/datasets/workspace-state";
import {
  createEdsAuditSummary,
  createEdsWorkspaceSnapshotForResults,
  EDS_OVERVIEW_DATA_SOURCE_ID,
  EDS_WORKSPACE_PAGE_ID,
  getEdsWorkspaceReports,
  installEdsWorkspaceInDataProduct,
  installEdsWorkspaceInExecution,
  mergeEdsWorkspaceRuntime,
  selectEdsWorkspaceReport,
  type EdsAnalysisResponse,
  type EdsWorkspaceSnapshot,
} from "@/core/eds";
import type { AiChangeSetAuditMetadata, AppNode, AppSpec, ChangeSet, ChangeSetAuditRecord, ChangeSetAuditSource, ChangeSetAuditStatus, QueryExecutionRecord } from "@/core/models";
import type { StudioRole } from "@/core/permissions";
import {
  createBrowserStudioRepository,
  createStudioSnapshot,
  exportStudioBackup,
  importStudioBackup,
  loadStudioStateSafely,
  restoreStudioBackup,
  saveStudioStateSafely,
  STUDIO_BACKUP_MAX_BYTES,
  type StudioRepository,
} from "@/core/repository";
import { readableValidationError } from "@/core/schemas";
import { demoFixtureResult, type DemoFixtures } from "@/fixtures/demo-product";
import { AiBuilderAssistant, type AiRequestUiStatus, type ChangeSetUiStatus } from "./AiBuilderAssistant";
import { ActivityHistoryPanel, restoreDialogTrigger, restoreDialogTriggerUnlessOpen } from "./ActivityHistoryPanel";
import { CsvUploadDialog } from "./CsvUploadDialog";
import { DataProductCanvas, type CanvasMode } from "./DataProductCanvas";
import { DataSourceDetailsPanel } from "./DataSourceDetailsPanel";
import { EdsAnalysisDialog } from "./EdsAnalysisDialog";
import { triggerBrowserDownload } from "./ExcelDownloadButton";
import { PageStructurePanel } from "./PageStructurePanel";
import { PublishReadinessDialog } from "./PublishReadinessDialog";
import { OriginalWorkbookDialog } from "./OriginalWorkbookDialog";
import { StudioHeader, type PreviewDevice, type StudioInterfaceOption } from "./StudioHeader";
import { WorkspaceSidebarRail } from "./WorkspaceSidebarRail";
import {
  ASSISTANT_PANEL_MAX_WIDTH,
  ASSISTANT_PANEL_MIN_WIDTH,
  clampAssistantPanelWidth,
  getAssistantPanelWidthBounds,
} from "./assistant-panel-layout";

const harnessUiClock: HarnessTaskClock = {
  now: () => new Date(),
  id: () => `harness_ui_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`,
};

const EDS_AI_ANALYSIS_INSTRUCTION = "请读取全部 EDS 日期和班次的派生汇总，对比异常次数、异常时长、命中率、主要异常线体和异常类别，指出跨班次差异、优先排查项与可执行改善建议。引用具体数值，不要修改页面，不要创建 ChangeSet。";
const STUDIO_INTERFACES: StudioInterfaceOption[] = [{
  id: "eds-analysis",
  label: "EDS 飞达异常分析",
  description: "导入工作簿、查看派生看板并进行 AI 诊断",
}];

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

function nodeUsesDataSource(node: AppNode, dataSourceId: string): boolean {
  const binding = "binding" in node.props ? node.props.binding : undefined;
  return Boolean(binding && typeof binding === "object" && "dataSourceId" in binding && binding.dataSourceId === dataSourceId)
    || Boolean(node.children?.some((child) => nodeUsesDataSource(child, dataSourceId)));
}

function appSpecUsesDataSource(appSpec: AppSpec, dataSourceId: string): boolean {
  return appSpec.pages.some((page) => nodeUsesDataSource(page.root, dataSourceId));
}

export function StudioWorkspace() {
  if (!demoFixtureResult.success) {
    return (
      <main className="studio-shell fixture-failure-shell">
        <div className="brand"><span className="brand-mark">D</span><span>DataCanvas AI</span><small>AI 数据产品工作室</small></div>
        <aside className="fixture-failure-panel">
          <span className="ai-mark">!</span>
          <div><b>演示数据无法进入工作台</b><p>{demoFixtureResult.error}</p></div>
        </aside>
      </main>
    );
  }

  return <ValidatedStudioWorkspace fixtures={demoFixtureResult.data} />;
}

function ValidatedStudioWorkspace({ fixtures }: { fixtures: DemoFixtures }) {
  const { repurchaseChangeSet } = fixtures;
  const [dataProduct, setDataProduct] = useState(() => structuredClone(fixtures.dataProduct));
  const [execution, setExecution] = useState(() => createExecutionState(fixtures.dataProduct.appSpec));
  const [dataRuntime, setDataRuntime] = useState(() => structuredClone(fixtures.dataRuntime));
  const [edsWorkspace, setEdsWorkspace] = useState<EdsWorkspaceSnapshot | null>(null);
  const [activePageId, setActivePageId] = useState(fixtures.dataProduct.appSpec.navigation[0].pageId);
  const [activeDataSourceId, setActiveDataSourceId] = useState(fixtures.dataProduct.datasets[0]?.id ?? "");
  const [device, setDevice] = useState<PreviewDevice>("desktop");
  const [saveLabel, setSaveLabel] = useState("已保存 · 演示草稿");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [canvasMode, setCanvasMode] = useState<CanvasMode>("preview");
  const [puckDraft, setPuckDraft] = useState<StudioPuckData | null>(null);
  const [puckSessionKey, setPuckSessionKey] = useState(0);
  const [pendingPuckChangeSet, setPendingPuckChangeSet] = useState<ChangeSet | null>(null);
  const [role, setRole] = useState<StudioRole>("editor");
  const [queryRecords, setQueryRecords] = useState<QueryExecutionRecord[]>([]);
  const [auditRecords, setAuditRecords] = useState<ChangeSetAuditRecord[]>([]);
  const [pendingChangeSource, setPendingChangeSource] = useState<ChangeSetAuditSource | null>(null);
  const [isDataSourceOpen, setIsDataSourceOpen] = useState(false);
  const [isCsvUploadOpen, setIsCsvUploadOpen] = useState(false);
  const [isEdsAnalysisOpen, setIsEdsAnalysisOpen] = useState(false);
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(null);
  const [aiChangeSet, setAiChangeSet] = useState<ChangeSet>(() => structuredClone(repurchaseChangeSet));
  const [aiMessage, setAiMessage] = useState("我已检查数据结构和当前画布，建议先预览以下结构化变更。");
  const [aiMetadata, setAiMetadata] = useState<AiPlanMetadata | null>(null);
  const [aiInstruction, setAiInstruction] = useState("整理华东异常订单，创建复购分析，并提供 Excel 下载。");
  const [aiImageAttachments, setAiImageAttachments] = useState<File[]>([]);
  const [lastSubmittedImages, setLastSubmittedImages] = useState<File[]>([]);
  const [lastSubmittedInstruction, setLastSubmittedInstruction] = useState("");
  const [aiRequestStatus, setAiRequestStatus] = useState<AiRequestUiStatus>("idle");
  const [aiRequestError, setAiRequestError] = useState<string | null>(null);
  const [hasValidAiPlan, setHasValidAiPlan] = useState(true);
  const [harnessTasks, setHarnessTasks] = useState<HarnessTaskSummary[]>([]);
  const [assistantConversation, setAssistantConversation] = useState<AssistantConversationTurn[]>([]);
  const [lastHarnessTaskId, setLastHarnessTaskId] = useState("");
  const [isLocalAssistantReply, setIsLocalAssistantReply] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isPublishInfoOpen, setIsPublishInfoOpen] = useState(false);
  const [originalWorkbook, setOriginalWorkbook] = useState<{ file: File; sheetNames: string[]; aiRawAccess: boolean } | null>(null);
  const [isOriginalWorkbookOpen, setIsOriginalWorkbookOpen] = useState(false);
  const [compactPanel, setCompactPanel] = useState<"pages" | "assistant" | null>(null);
  const [isPagesExpanded, setIsPagesExpanded] = useState(false);
  const [assistantPanelWidth, setAssistantPanelWidth] = useState<number | null>(null);
  const [isHistoryLoading, setIsHistoryLoading] = useState(true);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const publishButtonRef = useRef<HTMLButtonElement>(null);
  const pagesButtonRef = useRef<HTMLButtonElement>(null);
  const assistantButtonRef = useRef<HTMLButtonElement>(null);
  const originalWorkbookButtonRef = useRef<HTMLButtonElement>(null);
  const originalWorkbookTriggerRef = useRef<HTMLButtonElement | null>(null);
  const backupFileInputRef = useRef<HTMLInputElement>(null);
  const edsAnalysisButtonRef = useRef<HTMLButtonElement>(null);
  const edsAnalysisTriggerRef = useRef<HTMLButtonElement | null>(null);
  const sidebarRailToggleRef = useRef<HTMLButtonElement>(null);
  const sidebarPanelCloseRef = useRef<HTMLButtonElement>(null);
  const assistantPanelSlotRef = useRef<HTMLDivElement>(null);
  const assistantResizeStateRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const edsAnalysisOpenRef = useRef(false);
  const repositoryRef = useRef<StudioRepository | null>(null);
  const persistedQueryRecordsRef = useRef<QueryExecutionRecord[] | null>(null);
  const puckDraftOriginRef = useRef<PuckDraftOrigin | null>(null);
  const aiRequestAbortRef = useRef<AbortController | null>(null);
  const harnessRequestActiveRef = useRef(false);
  const latestDatasetWorkspaceRef = useRef({
    execution,
    dataProduct,
    dataRuntime,
    activeDataSourceId,
    auditRecords,
    queryRecords,
    harnessTasks,
    assistantConversation,
    edsWorkspace,
  });

  const isApplied = execution.appliedChangeSetIds.includes(aiChangeSet.id);
  const isAiPreview = execution.preview?.changeSetId === aiChangeSet.id;
  const status: ChangeSetUiStatus = isApplied ? "applied" : isAiPreview ? "preview" : "pending";
  const renderedSpec = execution.preview?.appSpec ?? execution.present;
  const activePage = renderedSpec.pages.find((page) => page.id === activePageId) ?? renderedSpec.pages[0];
  const dataset = dataProduct.datasets.find((candidate) => candidate.id === activeDataSourceId) ?? dataProduct.datasets[0];
  const activeDataSource = renderedSpec.dataSources.find((source) => source.id === activeDataSourceId) ?? renderedSpec.dataSources[0];
  const formalAppSpecRevision = useMemo(() => appSpecRevision(execution.present), [execution.present]);
  const edsReportOptions = useMemo(() => {
    if (!edsWorkspace || activePageId !== EDS_WORKSPACE_PAGE_ID) return undefined;
    return getEdsWorkspaceReports(edsWorkspace).map((report) => ({
      date: report.summary.date,
      shift: report.summary.shift,
      selected: report.summary.date === edsWorkspace.summary.date && report.summary.shift === edsWorkspace.summary.shift,
    }));
  }, [activePageId, edsWorkspace]);

  useEffect(() => {
    if (!compactPanel) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      const trigger = compactPanel === "pages" ? pagesButtonRef.current : assistantButtonRef.current;
      setCompactPanel(null);
      queueMicrotask(() => trigger?.focus());
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [compactPanel]);

  useEffect(() => {
    if (assistantPanelWidth === null) return;
    const clampToViewport = () => {
      setAssistantPanelWidth((current) => current === null
        ? null
        : clampAssistantPanelWidth(current, window.innerWidth, isPagesExpanded));
    };
    clampToViewport();
    window.addEventListener("resize", clampToViewport);
    return () => window.removeEventListener("resize", clampToViewport);
  }, [assistantPanelWidth, isPagesExpanded]);

  useEffect(() => () => {
    document.documentElement.classList.remove("assistant-panel-resizing");
  }, []);

  function closeCompactPanel(restoreFocus = false) {
    const trigger = compactPanel === "pages" ? pagesButtonRef.current : assistantButtonRef.current;
    setCompactPanel(null);
    if (restoreFocus) queueMicrotask(() => trigger?.focus());
  }

  function expandPagesPanel() {
    setIsPagesExpanded(true);
    requestAnimationFrame(() => sidebarPanelCloseRef.current?.focus());
  }

  function collapsePagesPanel() {
    setIsPagesExpanded(false);
    requestAnimationFrame(() => sidebarRailToggleRef.current?.focus());
  }

  function resizeAssistantPanel(width: number) {
    setAssistantPanelWidth(clampAssistantPanelWidth(width, window.innerWidth, isPagesExpanded));
  }

  function handleAssistantResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    const startWidth = assistantPanelSlotRef.current?.getBoundingClientRect().width;
    if (!startWidth) return;
    assistantResizeStateRef.current = { pointerId: event.pointerId, startX: event.clientX, startWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.classList.add("assistant-panel-resizing");
    event.preventDefault();
  }

  function handleAssistantResizeMove(event: ReactPointerEvent<HTMLDivElement>) {
    const resizeState = assistantResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    resizeAssistantPanel(resizeState.startWidth + resizeState.startX - event.clientX);
  }

  function handleAssistantResizeEnd(event: ReactPointerEvent<HTMLDivElement>) {
    const resizeState = assistantResizeStateRef.current;
    if (!resizeState || resizeState.pointerId !== event.pointerId) return;
    assistantResizeStateRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    document.documentElement.classList.remove("assistant-panel-resizing");
  }

  function handleAssistantResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const bounds = getAssistantPanelWidthBounds(window.innerWidth, isPagesExpanded);
    const currentWidth = assistantPanelSlotRef.current?.getBoundingClientRect().width ?? assistantPanelWidth ?? 350;
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") nextWidth = currentWidth + 24;
    if (event.key === "ArrowRight") nextWidth = currentWidth - 24;
    if (event.key === "Home") nextWidth = bounds.minimum;
    if (event.key === "End") nextWidth = bounds.maximum;
    if (nextWidth === null) return;
    event.preventDefault();
    resizeAssistantPanel(nextWidth);
  }

  const handleQueryExecuted = useCallback((record: QueryExecutionRecord) => {
    setQueryRecords((current) => current.some((item) => item.id === record.id)
      ? current
      : appendQueryExecutionRecord(current, record));
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      const repository = createBrowserStudioRepository();
      repositoryRef.current = repository;
      const restored = loadStudioStateSafely(repository, fixtures.dataProduct);
      setDataProduct(restored.dataProduct);
      setExecution(restored.execution);
      setAuditRecords(restored.auditRecords);
      if (restored.restored) setQueryRecords(restored.queryRecords);
      setHarnessTasks(restored.harnessTasks);
      setAssistantConversation(restored.assistantConversation);
      setEdsWorkspace(restored.edsWorkspace);
      setDataRuntime(mergeEdsWorkspaceRuntime(fixtures.dataRuntime, restored.edsWorkspace));
      setActivePageId(restored.edsWorkspace ? EDS_WORKSPACE_PAGE_ID : restored.dataProduct.appSpec.navigation[0].pageId);
      setActiveDataSourceId(restored.edsWorkspace ? EDS_OVERVIEW_DATA_SOURCE_ID : restored.dataProduct.datasets[0]?.id ?? "");
      const uploadedSourceIds = restored.execution.present.dataSources
        .filter((source) => source.sourceType === "csv" && source.ephemeral)
        .map((source) => source.id);
      uploadedSourceIds.forEach((datasetId) => {
        void loadUploadedDataset(datasetId).then((loaded) => {
          if (cancelled) return;
          setExecution((current) => synchronizeUploadedDatasetExecution(current, loaded.dataset));
          setDataProduct((current) => synchronizeUploadedDatasetProduct(current, loaded.dataset));
          setDataRuntime((current) => ({
            rowsByDataSourceId: { ...current.rowsByDataSourceId, [datasetId]: loaded.rows },
          }));
        }).catch(() => {
          if (!cancelled) setPersistenceNotice(`临时数据集 ${datasetId} 已过期、未启用服务端持久化或恢复失败，请重新上传。`);
        });
      });
      const latestConversationTurn = restored.assistantConversation.at(-1);
      if (latestConversationTurn) {
        setLastSubmittedInstruction(latestConversationTurn.instruction);
        setAiInstruction("");
        setAiMessage(latestConversationTurn.response);
        setHasValidAiPlan(false);
        setAiRequestStatus(latestConversationTurn.state === "success"
          ? "success"
          : latestConversationTurn.state === "blocked"
            ? "blocked"
            : latestConversationTurn.state === "cancelled"
              ? "cancelled"
              : "error");
        setIsLocalAssistantReply(!latestConversationTurn.taskId);
      }
      const pendingHarnessTask = restored.harnessTasks.find((task) => task.state === "awaitingConfirmation" && task.pendingChangeSet);
      if (pendingHarnessTask?.pendingChangeSet) {
        setAiChangeSet(pendingHarnessTask.pendingChangeSet);
        setAiMessage(pendingHarnessTask.resultMessage ?? "Harness 已恢复待确认变更，请重新预览后人工确认。");
        setAiMetadata(null);
        setHasValidAiPlan(true);
        setAiRequestStatus("success");
      } else if (restored.edsWorkspace && !latestConversationTurn) {
        setAiInstruction("检查 EDS 分析数据，说明异常次数最多的线体和累计时间最长的异常类型。不要修改页面。");
        setAiMessage("EDS 派生汇总已从本地工作区恢复，并进入当前页面与 AI 数据上下文；原始工作簿和逐行明细未保存。");
        setAiMetadata(null);
        setHasValidAiPlan(false);
        setAiRequestStatus("idle");
      } else if (!latestConversationTurn) {
        setAiMessage("告诉我你想分析的数据或希望调整的页面。对话会保存在当前浏览器中，也可以随时清除上下文。");
        setAiMetadata(null);
        setHasValidAiPlan(false);
        setAiRequestStatus("idle");
      }
      setSaveLabel(restored.restored ? "已恢复 · 本地草稿" : "已保存 · 演示草稿");
      setPersistenceNotice(restored.notice?.includes("回退") ? restored.notice : null);
      setIsHistoryLoading(false);
    });
    return () => { cancelled = true; };
  }, [fixtures.dataProduct, fixtures.dataRuntime]);

  useEffect(() => () => aiRequestAbortRef.current?.abort(), []);

  useEffect(() => {
    latestDatasetWorkspaceRef.current = {
      execution,
      dataProduct,
      dataRuntime,
      activeDataSourceId,
      auditRecords,
      queryRecords,
      harnessTasks,
      assistantConversation,
      edsWorkspace,
    };
  }, [activeDataSourceId, assistantConversation, auditRecords, dataProduct, dataRuntime, edsWorkspace, execution, harnessTasks, queryRecords]);

  useEffect(() => {
    if (isHistoryLoading || persistedQueryRecordsRef.current === queryRecords) return;
    persistedQueryRecordsRef.current = queryRecords;
    const result = saveStudioStateSafely(
      repositoryRef.current,
      createStudioSnapshot(dataProduct, execution, auditRecords, queryRecords, harnessTasks, edsWorkspace, assistantConversation),
    );
    if (!result.persisted) setPersistenceNotice(result.notice);
  }, [assistantConversation, auditRecords, dataProduct, edsWorkspace, execution, harnessTasks, isHistoryLoading, queryRecords]);

  function persistExplicitly(
    nextExecution = execution,
    nextAuditRecords = auditRecords,
    nextQueryRecords = queryRecords,
    nextDataProduct = dataProduct,
    nextHarnessTasks = harnessTasks,
    nextEdsWorkspace = edsWorkspace,
    nextAssistantConversation = assistantConversation,
  ) {
    const result = saveStudioStateSafely(
      repositoryRef.current,
      createStudioSnapshot(nextDataProduct, nextExecution, nextAuditRecords, nextQueryRecords, nextHarnessTasks, nextEdsWorkspace, nextAssistantConversation),
    );
    if (!result.persisted) setPersistenceNotice(result.notice);
    return result;
  }

  function clearPuckDraft() {
    puckDraftOriginRef.current = null;
    setPuckDraft(null);
  }

  function ensurePuckDraft(pageId: string, appSpec = execution.present) {
    const origin = { pageId, appSpecRevision: appSpecRevision(appSpec) };
    const current = { data: puckDraft, origin: puckDraftOriginRef.current };
    const next = initializePuckDraft(current, origin, () => appSpecToPuckData(appSpec, pageId));
    if (next === current) return;
    puckDraftOriginRef.current = next.origin;
    setPuckDraft(next.data);
    setPuckSessionKey((value) => value + 1);
  }

  const handlePuckDataChange = useCallback((data: StudioPuckData) => {
    setPuckDraft((current) => updatePuckDraft(current, data));
  }, []);
  const handleOpenHistory = useCallback(() => setIsHistoryOpen(true), []);
  const handleCloseHistory = useCallback(() => setIsHistoryOpen(false), []);
  const handleRestoreHistoryFocus = useCallback(() => restoreDialogTrigger(historyButtonRef.current), []);
  const handleOpenPublishInfo = useCallback(() => setIsPublishInfoOpen(true), []);
  const handleClosePublishInfo = useCallback(() => {
    setIsPublishInfoOpen(false);
    requestAnimationFrame(() => restoreDialogTrigger(publishButtonRef.current));
  }, []);
  const handleOpenEdsAnalysis = useCallback(() => {
    if (document.activeElement instanceof HTMLButtonElement) edsAnalysisTriggerRef.current = document.activeElement;
    edsAnalysisOpenRef.current = true;
    setIsEdsAnalysisOpen(true);
  }, []);
  const handleCloseEdsAnalysis = useCallback(() => {
    edsAnalysisOpenRef.current = false;
    setIsEdsAnalysisOpen(false);
    requestAnimationFrame(() => restoreDialogTriggerUnlessOpen(
      edsAnalysisTriggerRef.current ?? edsAnalysisButtonRef.current,
      edsAnalysisOpenRef.current,
    ));
  }, []);

  function handleCreateEdsWorkspace(results: EdsAnalysisResponse[], activeResultIndex: number, source: File, allowAiRawAccess: boolean) {
    if (role === "viewer") throw new Error("查看者无权生成 EDS 工作区看板，请切换为编辑者或管理员。");
    aiRequestAbortRef.current?.abort();
    const current = latestDatasetWorkspaceRef.current;
    const snapshot = createEdsWorkspaceSnapshotForResults(results, activeResultIndex);
    let nextAuditRecords = current.auditRecords;
    if (current.execution.preview) {
      const previewId = current.execution.preview.changeSetId;
      const previous = current.auditRecords.find((record) => record.changeSetId === previewId && record.status === "previewed");
      const cancelled = createChangeSetAuditRecordFromSummary(
        previewId,
        previous?.operationSummary ?? "取消当前变更预览",
        role,
        previewId === aiChangeSet.id ? "ai" : pendingChangeSource ?? "manual",
        "cancelled",
      );
      nextAuditRecords = appendChangeSetAuditRecord(nextAuditRecords, cancelled);
    }
    const nextExecution = installEdsWorkspaceInExecution(cancelPreview(current.execution), snapshot);
    const nextDataProduct = {
      ...installEdsWorkspaceInDataProduct(current.dataProduct, snapshot),
      appSpec: nextExecution.present,
    };
    const nextDataRuntime = mergeEdsWorkspaceRuntime(current.dataRuntime, snapshot);
    const nextHarnessTasks = current.harnessTasks.map((task) => (
      task.state === "awaitingConfirmation" && task.pendingChangeSet
        ? settleHarnessConfirmation(task, false, harnessUiClock)
        : task
    ));
    const audit = createChangeSetAuditRecordFromSummary(
      `eds_workspace_${Date.now()}_${crypto.randomUUID().replaceAll("-", "")}`,
      createEdsAuditSummary(snapshot),
      role,
      "manual",
      "applied",
    );
    nextAuditRecords = appendChangeSetAuditRecord(nextAuditRecords, audit);

    setExecution(nextExecution);
    setDataProduct(nextDataProduct);
    setDataRuntime(nextDataRuntime);
    setEdsWorkspace(snapshot);
    setOriginalWorkbook({
      file: source,
      sheetNames: [...new Set(results.flatMap((result) => result.summary.sourceSheets))],
      aiRawAccess: allowAiRawAccess,
    });
    setAuditRecords(nextAuditRecords);
    setHarnessTasks(nextHarnessTasks);
    setActivePageId(EDS_WORKSPACE_PAGE_ID);
    setActiveDataSourceId(EDS_OVERVIEW_DATA_SOURCE_ID);
    setCanvasMode("preview");
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    clearPuckDraft();
    setPuckSessionKey((value) => value + 1);
    setIsDataSourceOpen(false);
    setAiInstruction("检查 EDS 分析数据，说明异常次数最多的线体和累计时间最长的异常类型。不要修改页面。");
    setAiMessage(allowAiRawAccess
      ? "EDS 派生汇总已进入 AI 数据上下文；原始工作簿仅保留在本次浏览器会话，并已授权 Harness 在相关提问中完整扫描所有数据行、执行结构化查询。原文件不会写入聊天、localStorage、备份或审计正文。"
      : "EDS 派生汇总已进入 AI 数据上下文；原始工作簿仅挂载在本次会话的“原始资料”区，AI 完整扫描尚未授权。原文件不会进入本地持久化。");
    setAiMetadata(null);
    setAiRequestStatus("idle");
    setAiRequestError(null);
    setHasValidAiPlan(false);
    setSaveLabel("已保存 · EDS 分析看板");
    setValidationError(null);
    const persistence = persistExplicitly(
      nextExecution,
      nextAuditRecords,
      current.queryRecords,
      nextDataProduct,
      nextHarnessTasks,
      snapshot,
    );
    if (!persistence.persisted) setSaveLabel("已生成 · 当前页面未持久化");
    handleCloseEdsAnalysis();
  }

  function handleSelectEdsWorkspaceReport(reportIndex: number) {
    const current = latestDatasetWorkspaceRef.current;
    if (!current.edsWorkspace) return;
    const reports = getEdsWorkspaceReports(current.edsWorkspace);
    const selected = reports[reportIndex];
    if (!selected || (
      selected.summary.date === current.edsWorkspace.summary.date
      && selected.summary.shift === current.edsWorkspace.summary.shift
    )) return;
    aiRequestAbortRef.current?.abort();
    const nextSnapshot = selectEdsWorkspaceReport(current.edsWorkspace, reportIndex);
    const nextExecution = installEdsWorkspaceInExecution(current.execution, nextSnapshot);
    const nextDataProduct = {
      ...installEdsWorkspaceInDataProduct(current.dataProduct, nextSnapshot),
      appSpec: nextExecution.present,
    };
    const nextDataRuntime = mergeEdsWorkspaceRuntime(current.dataRuntime, nextSnapshot);

    setExecution(nextExecution);
    setDataProduct(nextDataProduct);
    setDataRuntime(nextDataRuntime);
    setEdsWorkspace(nextSnapshot);
    setActivePageId(EDS_WORKSPACE_PAGE_ID);
    setActiveDataSourceId(EDS_OVERVIEW_DATA_SOURCE_ID);
    setCanvasMode("preview");
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    clearPuckDraft();
    setPuckSessionKey((value) => value + 1);
    setAiInstruction("比较当前 EDS 班次与同批次其他班次的异常次数、异常时间和主要异常类别。不要修改页面。");
    setAiMessage(`EDS 看板已切换到 ${nextSnapshot.summary.date} ${nextSnapshot.summary.shift}；${reports.length} 份派生汇总仍同时保存在 AI 数据上下文和本地工作区，原始工作簿仍只挂载于本次会话。`);
    setAiMetadata(null);
    setAiRequestStatus("idle");
    setAiRequestError(null);
    setHasValidAiPlan(false);
    setSaveLabel(`已保存 · ${nextSnapshot.summary.shift}报告`);
    setValidationError(null);
    const persistence = persistExplicitly(
      nextExecution,
      current.auditRecords,
      current.queryRecords,
      nextDataProduct,
      current.harnessTasks,
      nextSnapshot,
    );
    if (!persistence.persisted) setSaveLabel(`已切换 · ${nextSnapshot.summary.shift}未持久化`);
  }

  function handleAnalyzeEdsReports() {
    if (!edsWorkspace || harnessRequestActiveRef.current) return;
    setAiInstruction(EDS_AI_ANALYSIS_INSTRUCTION);
    void handleGenerateAiPlan(EDS_AI_ANALYSIS_INSTRUCTION);
  }

  function toAuditMetadata(metadata: AiPlanMetadata | AiChangeSetAuditMetadata | null): AiChangeSetAuditMetadata | undefined {
    return metadata ? {
      model: metadata.model,
      durationMs: metadata.durationMs,
      usage: metadata.usage,
      ...(metadata && "transport" in metadata ? { transport: metadata.transport } : {}),
      ...(metadata && "repairAttempted" in metadata ? { repairAttempted: metadata.repairAttempted } : {}),
      ...(metadata && "validationIssues" in metadata && metadata.validationIssues
        ? { validationIssues: metadata.validationIssues }
        : {}),
    } : undefined;
  }

  function addAudit(
    changeSet: ChangeSet,
    source: ChangeSetAuditSource,
    auditStatus: ChangeSetAuditStatus,
    error?: string,
    metadata: AiPlanMetadata | AiChangeSetAuditMetadata | null = source === "ai" ? aiMetadata : null,
  ) {
    const record = createChangeSetAuditRecord(changeSet, role, source, auditStatus, error, undefined, toAuditMetadata(metadata));
    setAuditRecords((current) => appendChangeSetAuditRecord(
      current,
      record,
    ));
    return record;
  }

  function addAuditSummary(
    changeSetId: string,
    summary: string,
    source: ChangeSetAuditSource,
    auditStatus: ChangeSetAuditStatus,
    error?: string,
    metadata: AiPlanMetadata | AiChangeSetAuditMetadata | null = source === "ai" ? aiMetadata : null,
  ) {
    const record = createChangeSetAuditRecordFromSummary(changeSetId, summary, role, source, auditStatus, error, undefined, toAuditMetadata(metadata));
    setAuditRecords((current) => appendChangeSetAuditRecord(
      current,
      record,
    ));
    return record;
  }

  function auditCurrentPreviewCancellation() {
    const changeSetId = execution.preview?.changeSetId;
    if (!changeSetId) return;
    const previous = auditRecords.find((record) => record.changeSetId === changeSetId && record.status === "previewed");
    addAuditSummary(
      changeSetId,
      previous?.operationSummary ?? "取消当前变更预览",
      changeSetId === aiChangeSet.id ? "ai" : pendingChangeSource ?? "manual",
      "cancelled",
    );
  }

  function handlePreview() {
    try {
      if (!hasValidAiPlan) throw new Error("当前没有通过校验的 AI ChangeSet，请先重新生成。");
      if (execution.preview && execution.preview.changeSetId !== aiChangeSet.id) auditCurrentPreviewCancellation();
      setExecution(previewChangeSet(execution, aiChangeSet, role));
      setActivePageId(aiChangeSet.operations[0]?.pageId ?? activePageId);
      setCanvasMode("preview");
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      setSaveLabel("预览中 · 尚未保存");
      setValidationError(null);
      addAudit(aiChangeSet, "ai", "previewed");
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(aiChangeSet, "ai", "failed", message);
    }
  }

  function handleApply() {
    try {
      if (execution.preview?.changeSetId !== aiChangeSet.id) {
        throw new Error("请先完成当前 AI ChangeSet 的画布预览，再人工确认应用。");
      }
      const nextExecution = applyChangeSet(execution, aiChangeSet, role);
      const audit = addAudit(aiChangeSet, "ai", "applied");
      const relatedTask = harnessTasks.find((task) => task.pendingChangeSet?.id === aiChangeSet.id);
      const nextHarnessTasks = relatedTask
        ? appendHarnessTask(harnessTasks, settleHarnessConfirmation(relatedTask, true, harnessUiClock))
        : harnessTasks;
      setExecution(nextExecution);
      setHarnessTasks(nextHarnessTasks);
      setActivePageId(aiChangeSet.operations[0]?.pageId ?? activePageId);
      setCanvasMode("preview");
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      clearPuckDraft();
      setPuckSessionKey((value) => value + 1);
      setSaveLabel("已保存 · 变更已应用");
      setValidationError(null);
      persistExplicitly(nextExecution, appendChangeSetAuditRecord(auditRecords, audit), queryRecords, dataProduct, nextHarnessTasks);
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(aiChangeSet, "ai", "failed", message);
    }
  }

  function handleCancelPreview() {
    const audit = addAudit(aiChangeSet, "ai", "cancelled");
    const nextExecution = cancelPreview(execution);
    const relatedTask = harnessTasks.find((task) => task.pendingChangeSet?.id === aiChangeSet.id);
    const nextHarnessTasks = relatedTask
      ? appendHarnessTask(harnessTasks, settleHarnessConfirmation(relatedTask, false, harnessUiClock))
      : harnessTasks;
    setExecution(nextExecution);
    setHarnessTasks(nextHarnessTasks);
    if (relatedTask) setHasValidAiPlan(false);
    setSaveLabel("已保存 · 已取消 AI 预览");
    setValidationError(null);
    persistExplicitly(nextExecution, appendChangeSetAuditRecord(auditRecords, audit), queryRecords, dataProduct, nextHarnessTasks);
  }

  async function handleGenerateAiPlan(instructionOverride?: string, retryOfTaskId?: string) {
    const submittedImages = retryOfTaskId ? lastSubmittedImages : instructionOverride ? [] : aiImageAttachments;
    const submittedInstruction = (instructionOverride ?? aiInstruction).trim() || (submittedImages.length ? "请分析我上传的图片。" : "");
    if (!submittedInstruction || harnessRequestActiveRef.current) return;

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
      persistExplicitly(execution, auditRecords, queryRecords, dataProduct, harnessTasks, edsWorkspace, nextConversation);
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
    persistExplicitly(baseExecution, auditRecords, queryRecords, dataProduct, initialTasks);

    try {
      const previousConversationTurn = assistantConversation.at(-1);
      const previousInstruction = (previousConversationTurn?.instruction ?? "").trim().slice(0, 1_000);
      const previousAssistantMessage = (previousConversationTurn?.response ?? "").trim().slice(0, 2_000);
      const conversationTaskIds = new Set(assistantConversation.flatMap((turn) => turn.taskId ? [turn.taskId] : []));
      const previousWorkingMemory = harnessTasks.find((task) => {
        const memory = task.workingMemory;
        return conversationTaskIds.has(task.id) && Boolean(memory) && Boolean(
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
        instruction: submittedInstruction,
        pageId: activePageId,
        ...(activeDataSource ? { dataSourceId: activeDataSource.id } : {}),
        ...(hasConversationContext ? {
          conversationContext: {
            ...(previousInstruction ? { previousInstruction } : {}),
            ...(previousAssistantMessage ? { previousAssistantMessage } : {}),
            ...(previousWorkingMemory ? { workingMemory: previousWorkingMemory } : {}),
          },
        } : {}),
        appSpec: baseExecution.present,
        recipes: dataProduct.recipes,
        ...(edsWorkspace ? { edsWorkspace } : {}),
        ...(retryOfTaskId ? { retryOfTaskId } : {}),
      }, {
        signal: controller.signal,
        ...(submittedImages.length ? { imageAttachments: submittedImages } : {}),
        ...(originalWorkbook?.aiRawAccess && instructionRequestsRawWorkbook(submittedInstruction, previousInstruction)
          ? { rawWorkbook: originalWorkbook.file }
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
      } else if (task.state === "completed") {
        setAiRequestStatus("success");
        setAiRequestError(null);
        setHasValidAiPlan(false);
        setSaveLabel(task.exportArtifact ? "Harness 已完成 · Excel 可下载" : "Harness 已完成 · 只读任务");
      } else {
        const taskError = task.error ?? (task.state === "cancelled" ? "Harness 任务已取消。" : "Harness 任务执行失败。");
        setAiRequestStatus(task.state === "blocked" ? "blocked" : task.state === "cancelled" ? "cancelled" : "error");
        setAiRequestError(taskError);
        setHasValidAiPlan(false);
        setSaveLabel("已保存 · Harness 未修改 AppSpec");
      }
      persistExplicitly(baseExecution, auditRecords, queryRecords, dataProduct, nextTasks, edsWorkspace, nextConversation);
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
      setAiRequestError(clientError.message);
      setAiMessage("Harness 未生成可用待确认变更，正式 AppSpec 保持不变。");
      setAiMetadata(null);
      setHasValidAiPlan(false);
      setSaveLabel("已保存 · Harness 未修改 AppSpec");
      const failedTask = appendHarnessEvent(initialTask, {
        type: clientError.code === "cancelled" ? "state" : "error",
        state: clientError.code === "cancelled" ? "cancelled" : "failed",
        message: clientError.message,
      }, harnessUiClock, { error: clientError.message, resultMessage: "任务未完成，正式 AppSpec 未修改。" });
      const nextTasks = appendHarnessTask(initialTasks, failedTask);
      const [conversationTurn] = assistantConversationFromHarnessTasks([failedTask]);
      const nextConversation = conversationTurn
        ? appendAssistantConversationTurn(assistantConversation, conversationTurn)
        : assistantConversation;
      setHarnessTasks(nextTasks);
      setAssistantConversation(nextConversation);
      persistExplicitly(baseExecution, auditRecords, queryRecords, dataProduct, nextTasks, edsWorkspace, nextConversation);
    } finally {
      if (aiRequestAbortRef.current === controller) aiRequestAbortRef.current = null;
      harnessRequestActiveRef.current = false;
    }
  }

  function handleCancelAiRequest() {
    aiRequestAbortRef.current?.abort();
  }

  function handleClearAssistantConversation() {
    if (harnessRequestActiveRef.current || !assistantConversation.length) return;
    setAssistantConversation([]);
    setLastSubmittedInstruction("");
    setLastHarnessTaskId("");
    setAiImageAttachments([]);
    setLastSubmittedImages([]);
    setAiMessage("对话上下文已清除。下一条消息将作为新会话开始；Harness 任务与变更审计记录仍保留。");
    setAiRequestStatus("idle");
    setAiRequestError(null);
    setValidationError(null);
    setIsLocalAssistantReply(true);
    setSaveLabel("已保存 · 对话上下文已清除");
    persistExplicitly(execution, auditRecords, queryRecords, dataProduct, harnessTasks, edsWorkspace, []);
  }

  function handleRetryAiRequest() {
    if (lastSubmittedInstruction) void handleGenerateAiPlan(lastSubmittedInstruction, lastHarnessTaskId || undefined);
  }

  function handleUndo() {
    const changeSetId = execution.appliedChangeSetIds.at(-1) ?? "unknown_changeset";
    const prior = auditRecords.find((record) => record.changeSetId === changeSetId && record.status === "applied");
    try {
      const nextExecution = undoLastChange(execution, role);
      const audit = addAuditSummary(changeSetId, prior?.operationSummary ?? "撤销最近一次正式变更", prior?.source ?? "manual", "undone", undefined, prior?.ai ?? null);
      setExecution(nextExecution);
      setCanvasMode("preview");
      setPendingPuckChangeSet(null);
      clearPuckDraft();
      setPuckSessionKey((value) => value + 1);
      setSaveLabel("已保存 · 已撤销最近变更");
      setValidationError(null);
      persistExplicitly(nextExecution, appendChangeSetAuditRecord(auditRecords, audit));
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAuditSummary(changeSetId, prior?.operationSummary ?? "撤销最近一次正式变更", prior?.source ?? "manual", "failed", message);
    }
  }

  function handleCanvasModeChange(mode: CanvasMode) {
    if (mode === canvasMode) return;
    if (mode === "preview") {
      setCanvasMode("preview");
      return;
    }

    if (role === "viewer") {
      setValidationError("查看者只能查看和预览，不能进入编辑模式。");
      return;
    }

    try {
      auditCurrentPreviewCancellation();
      const nextExecution = cancelPreview(execution);
      setExecution(nextExecution);
      ensurePuckDraft(activePageId, nextExecution.present);
      setPendingPuckChangeSet(null);
      setCanvasMode("edit");
      setSaveLabel("可视化编辑 · 尚未生成变更集");
      setValidationError(null);
    } catch (error) {
      setValidationError(readableValidationError(error));
    }
  }

  function handlePageChange(pageId: string) {
    try {
      auditCurrentPreviewCancellation();
      const nextExecution = cancelPreview(execution);
      setExecution(nextExecution);
      setActivePageId(pageId);
      setPendingPuckChangeSet(null);
      if (canvasMode === "edit") {
        ensurePuckDraft(pageId, nextExecution.present);
      }
      setValidationError(null);
    } catch (error) {
      setValidationError(readableValidationError(error));
    }
  }

  function handleInterfaceChange(interfaceId: string) {
    if (interfaceId !== "eds-analysis") return;
    if (latestDatasetWorkspaceRef.current.edsWorkspace) {
      handlePageChange(EDS_WORKSPACE_PAGE_ID);
      setActiveDataSourceId(EDS_OVERVIEW_DATA_SOURCE_ID);
      return;
    }
    handleOpenEdsAnalysis();
  }

  function handleOpenOriginalWorkbook() {
    if (!originalWorkbook) {
      handleOpenEdsAnalysis();
      return;
    }
    if (document.activeElement instanceof HTMLButtonElement) originalWorkbookTriggerRef.current = document.activeElement;
    setIsOriginalWorkbookOpen(true);
  }

  function handleRequestPuckPreview(data: StudioPuckData) {
    try {
      auditCurrentPreviewCancellation();
      const changeSet = puckDataToChangeSet(execution.present, activePageId, data, role);
      const nextExecution = previewChangeSet(cancelPreview(execution), changeSet, role);
      setExecution(nextExecution);
      handlePuckDataChange(data);
      setPendingPuckChangeSet(changeSet);
      setPendingChangeSource("puck");
      setCanvasMode("preview");
      setSaveLabel(`预览中 · ${changeSet.operations.length} 项可视化变更`);
      setValidationError(null);
      addAudit(changeSet, "puck", "previewed");
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAuditSummary(`changeset_puck_failed_${Date.now()}`, "生成可视化编辑变更", "puck", "failed", message);
    }
  }

  function handlePreviewRecipeBinding(changeSet: ChangeSet) {
    try {
      auditCurrentPreviewCancellation();
      const nextExecution = previewChangeSet(cancelPreview(execution), changeSet, role);
      setExecution(nextExecution);
      setActivePageId(changeSet.operations[0]?.pageId ?? activePageId);
      setPendingPuckChangeSet(changeSet);
      setPendingChangeSource("manual");
      setCanvasMode("preview");
      setIsDataSourceOpen(false);
      setSaveLabel(`预览中 · ${changeSet.operations.length} 项配方绑定变更`);
      setValidationError(null);
      addAudit(changeSet, "manual", "previewed");
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(changeSet, "manual", "failed", message);
    }
  }

  function handleApplyPuckPreview() {
    if (!pendingPuckChangeSet) return;
    try {
      const nextExecution = applyChangeSet(cancelPreview(execution), pendingPuckChangeSet, role);
      const audit = addAudit(pendingPuckChangeSet, pendingChangeSource ?? "puck", "applied");
      setExecution(nextExecution);
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      clearPuckDraft();
      setPuckSessionKey((value) => value + 1);
      setCanvasMode("preview");
      setSaveLabel("已保存 · 可视化编辑已应用");
      setValidationError(null);
      persistExplicitly(nextExecution, appendChangeSetAuditRecord(auditRecords, audit));
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(pendingPuckChangeSet, pendingChangeSource ?? "puck", "failed", message);
    }
  }

  function handleCancelPuckPreview() {
    if (pendingPuckChangeSet) addAudit(pendingPuckChangeSet, pendingChangeSource ?? "puck", "cancelled");
    setExecution(cancelPreview(execution));
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    setCanvasMode(puckDraft ? "edit" : "preview");
    setSaveLabel(puckDraft ? "可视化编辑 · 尚未应用" : "已保存 · 已取消页面变更");
    setValidationError(null);
  }

  function handleRoleChange(nextRole: StudioRole) {
    aiRequestAbortRef.current?.abort();
    auditCurrentPreviewCancellation();
    setRole(nextRole);
    setExecution(cancelPreview(execution));
    setCanvasMode("preview");
    setPendingPuckChangeSet(null);
    setPendingChangeSource(null);
    clearPuckDraft();
    setPuckSessionKey((value) => value + 1);
    setSaveLabel(`演示角色 · ${nextRole}`);
    setValidationError(null);
  }

  function handleRenamePage(pageId: string, currentTitle: string) {
    if (role !== "admin") return;
    const title = window.prompt("输入新的页面名称", currentTitle)?.trim();
    if (!title || title === currentTitle) return;
    const changeSet: ChangeSet = {
      id: `changeset_page_title_${Date.now()}`,
      title: `重命名页面：${currentTitle}`,
      status: "ready",
      operations: [{
        id: `operation_page_title_${Date.now()}`,
        type: "updatePage",
        label: "修改页面结构",
        description: `将页面“${currentTitle}”重命名为“${title}”`,
        pageId,
        title,
      }],
    };
    try {
      auditCurrentPreviewCancellation();
      setExecution(previewChangeSet(cancelPreview(execution), changeSet, role));
      setPendingPuckChangeSet(changeSet);
      setPendingChangeSource("manual");
      setCanvasMode("preview");
      setSaveLabel("预览中 · 页面结构变更");
      setValidationError(null);
      addAudit(changeSet, "manual", "previewed");
    } catch (error) {
      const message = readableValidationError(error);
      setValidationError(message);
      addAudit(changeSet, "manual", "failed", message);
    }
  }

  function applyUploadedDescriptor(descriptor: UploadedDatasetDescriptor) {
    const current = latestDatasetWorkspaceRef.current;
    const next = synchronizeUploadedDatasetWorkspace(current, descriptor);
    setExecution(next.execution);
    setDataProduct(next.dataProduct);
    const persistence = persistExplicitly(
      next.execution,
      current.auditRecords,
      current.queryRecords,
      next.dataProduct,
      current.harnessTasks,
    );
    return { nextExecution: next.execution, nextDataProduct: next.dataProduct, persistence };
  }

  function handleCsvUploaded(result: DatasetUploadResponse) {
    const { persistence } = applyUploadedDescriptor(result.dataset);
    setDataRuntime((current) => ({
      rowsByDataSourceId: { ...current.rowsByDataSourceId, [result.dataset.datasetId]: result.rows },
    }));
    setActiveDataSourceId(result.dataset.datasetId);
    setIsCsvUploadOpen(false);
    setIsDataSourceOpen(true);
    setPersistenceNotice(persistence.persisted
      ? result.dataset.persistenceNotice
      : `${persistence.notice} ${result.dataset.persistenceNotice}`);
    setSaveLabel(persistence.persisted ? "已注册 · 临时 CSV 数据源" : "已注册 · 当前页面未持久化");
  }

  async function handleConfirmDatasetAiAccess(policy: "masked" | "exclude-sensitive-samples") {
    if (!activeDataSource?.ephemeral) return;
    try {
      const descriptor = await confirmDatasetAiAccess(activeDataSource.id, policy);
      const { persistence } = applyUploadedDescriptor(descriptor);
      setSaveLabel(persistence.persisted ? "已保存 · 敏感字段策略已确认" : "已更新 · 当前页面未持久化");
    } catch (error) {
      if (error instanceof DatasetAiAccessConflictError) {
        const { persistence } = applyUploadedDescriptor(error.currentDataset);
        setSaveLabel(persistence.persisted ? "已保存 · 已同步服务端敏感字段策略" : "已同步 · 当前页面未持久化");
      }
      throw error;
    }
  }

  async function handleDeleteDataset() {
    if (!activeDataSource?.ephemeral) return;
    const dataSourceId = activeDataSource.id;
    const beforeDelete = latestDatasetWorkspaceRef.current;
    if (appSpecUsesDataSource(beforeDelete.execution.present, dataSourceId) || beforeDelete.execution.history.some((entry) => appSpecUsesDataSource(entry.appSpec, dataSourceId))) {
      throw new Error("该数据源仍被页面组件或变更历史引用，无法删除。请先撤销相关绑定。");
    }
    await deleteUploadedDataset(dataSourceId);
    const current = latestDatasetWorkspaceRef.current;
    const next = removeUploadedDatasetFromWorkspace(current, dataSourceId);
    setExecution(next.execution);
    setDataProduct(next.dataProduct);
    setDataRuntime(next.dataRuntime);
    if (current.activeDataSourceId === dataSourceId) {
      setActiveDataSourceId(next.dataProduct.datasets[0]?.id ?? "");
      setIsDataSourceOpen(false);
    }
    const persistence = persistExplicitly(
      next.execution,
      current.auditRecords,
      current.queryRecords,
      next.dataProduct,
      current.harnessTasks,
    );
    setSaveLabel(persistence.persisted ? "已保存 · 临时数据源已删除" : "已删除 · 当前页面未持久化");
  }

  function handleExportBackup() {
    try {
      const now = new Date();
      const serialized = exportStudioBackup(createStudioSnapshot(
        dataProduct,
        execution,
        auditRecords,
        queryRecords,
        harnessTasks,
        edsWorkspace,
        assistantConversation,
      ), now);
      const timestamp = now.toISOString().replaceAll(":", "-").replace(".000Z", "Z");
      triggerBrowserDownload(
        new Blob([serialized], { type: "application/json;charset=utf-8" }),
        `datacanvas-workspace-${timestamp}.json`,
      );
      setPersistenceNotice("工作区备份已下载。文件不包含原始工作簿、逐行明细或 API Key，请妥善保管其中的派生汇总与聊天记录。");
    } catch (error) {
      setPersistenceNotice(`工作区备份导出失败。${readableValidationError(error)}`);
    }
  }

  function handleChooseBackupFile() {
    backupFileInputRef.current?.click();
  }

  async function handleRestoreBackupFile(file: File | undefined) {
    if (!file) return;
    try {
      if (file.size > STUDIO_BACKUP_MAX_BYTES) {
        throw new Error(`备份文件不得超过 ${Math.floor(STUDIO_BACKUP_MAX_BYTES / 1024 / 1024)} MiB。`);
      }
      const serialized = await file.text();
      const inspected = importStudioBackup(serialized);
      const summary = [
        inspected.edsWorkspace ? `${getEdsWorkspaceReports(inspected.edsWorkspace).length} 份 EDS 派生汇总` : "无 EDS 派生汇总",
        `${inspected.assistantConversation.length} 轮聊天`,
        `${inspected.harnessTasks.length} 个 Harness 任务`,
        `${inspected.auditRecords.length} 条审计记录`,
      ].join("、");
      if (!window.confirm(`确定从“${file.name}”恢复工作区吗？\n\n备份包含：${summary}。\n\n当前页面状态将被覆盖；原始工作簿、逐行明细和 API Key 不在备份中。`)) return;
      const repository = repositoryRef.current;
      if (!repository) throw new Error("浏览器本地存储不可用，无法安全保存恢复结果。");
      aiRequestAbortRef.current?.abort();
      restoreStudioBackup(repository, serialized);
      const restored = loadStudioStateSafely(repository, fixtures.dataProduct);
      if (!restored.restored) throw new Error(restored.notice ?? "备份未能恢复。");

      const latestConversationTurn = restored.assistantConversation.at(-1);
      const pendingHarnessTask = restored.harnessTasks.find((task) => task.state === "awaitingConfirmation" && task.pendingChangeSet);
      setDataProduct(restored.dataProduct);
      setExecution(restored.execution);
      setDataRuntime(mergeEdsWorkspaceRuntime(fixtures.dataRuntime, restored.edsWorkspace));
      setEdsWorkspace(restored.edsWorkspace);
      setOriginalWorkbook(null);
      setIsOriginalWorkbookOpen(false);
      setAuditRecords(restored.auditRecords);
      setHarnessTasks(restored.harnessTasks);
      setAssistantConversation(restored.assistantConversation);
      persistedQueryRecordsRef.current = restored.queryRecords;
      setQueryRecords(restored.queryRecords);
      setActivePageId(restored.edsWorkspace ? EDS_WORKSPACE_PAGE_ID : restored.dataProduct.appSpec.navigation[0].pageId);
      setActiveDataSourceId(restored.edsWorkspace ? EDS_OVERVIEW_DATA_SOURCE_ID : restored.dataProduct.datasets[0]?.id ?? "");
      setPendingPuckChangeSet(null);
      setPendingChangeSource(null);
      clearPuckDraft();
      setPuckSessionKey((value) => value + 1);
      setCanvasMode("preview");
      setIsCsvUploadOpen(false);
      setIsDataSourceOpen(false);
      setValidationError(null);
      setAiMetadata(null);
      setAiRequestError(null);
      setLastHarnessTaskId(pendingHarnessTask?.id ?? "");

      if (pendingHarnessTask?.pendingChangeSet) {
        setAiChangeSet(pendingHarnessTask.pendingChangeSet);
        setAiMessage(pendingHarnessTask.resultMessage ?? "备份中的 Harness 待确认变更已恢复，请重新预览后人工确认。");
        setLastSubmittedInstruction(pendingHarnessTask.instruction);
        setAiInstruction("");
        setAiRequestStatus("success");
        setHasValidAiPlan(true);
        setIsLocalAssistantReply(false);
      } else if (latestConversationTurn) {
        setAiChangeSet(structuredClone(repurchaseChangeSet));
        setAiMessage(latestConversationTurn.response);
        setLastSubmittedInstruction(latestConversationTurn.instruction);
        setAiInstruction("");
        setAiRequestStatus(latestConversationTurn.state === "success"
          ? "success"
          : latestConversationTurn.state === "blocked"
            ? "blocked"
            : latestConversationTurn.state === "cancelled"
              ? "cancelled"
              : "error");
        setHasValidAiPlan(false);
        setIsLocalAssistantReply(!latestConversationTurn.taskId);
      } else {
        setAiChangeSet(structuredClone(repurchaseChangeSet));
        setAiMessage(restored.edsWorkspace
          ? "EDS 派生汇总已从备份恢复，并进入当前页面与 AI 数据上下文；原始工作簿和逐行明细不在备份中。"
          : "工作区已从备份恢复。告诉我你想分析的数据或希望调整的页面。");
        setLastSubmittedInstruction("");
        setAiInstruction(restored.edsWorkspace ? "检查 EDS 分析数据，说明异常次数最多的线体和累计时间最长的异常类型。不要修改页面。" : "");
        setAiRequestStatus("idle");
        setHasValidAiPlan(false);
        setIsLocalAssistantReply(true);
      }
      setSaveLabel("已恢复 · 工作区备份");
      setPersistenceNotice(`已从“${file.name}”恢复：${summary}。临时 CSV 原始数据仍需在原服务端有效期内重新加载。`);

      restored.execution.present.dataSources
        .filter((source) => source.sourceType === "csv" && source.ephemeral)
        .forEach((source) => {
          void loadUploadedDataset(source.id).then((loaded) => {
            setExecution((current) => synchronizeUploadedDatasetExecution(current, loaded.dataset));
            setDataProduct((current) => synchronizeUploadedDatasetProduct(current, loaded.dataset));
            setDataRuntime((current) => ({
              rowsByDataSourceId: { ...current.rowsByDataSourceId, [source.id]: loaded.rows },
            }));
          }).catch(() => setPersistenceNotice(`工作区已恢复，但临时数据集 ${source.id} 已过期或不属于当前服务端，请重新上传原始 CSV。`));
        });
    } catch (error) {
      setPersistenceNotice(`工作区备份恢复失败，当前页面未被覆盖。${readableValidationError(error)}`);
    } finally {
      if (backupFileInputRef.current) backupFileInputRef.current.value = "";
    }
  }

  return (
    <main className="studio-shell">
      <input
        ref={backupFileInputRef}
        className="visually-hidden"
        type="file"
        accept="application/json,.json"
        aria-label="选择工作区备份文件"
        onChange={(event) => { void handleRestoreBackupFile(event.target.files?.[0]); }}
      />
      <StudioHeader
        interfaces={STUDIO_INTERFACES}
        activeInterfaceId="eds-analysis"
        device={device}
        canUndo={role !== "viewer" && execution.history.length > 0}
        saveLabel={saveLabel}
        role={role}
        historyCount={harnessTasks.length + auditRecords.length}
        historyButtonRef={historyButtonRef}
        publishButtonRef={publishButtonRef}
        pagesButtonRef={pagesButtonRef}
        assistantButtonRef={assistantButtonRef}
        onDeviceChange={setDevice}
        onUndo={handleUndo}
        onRoleChange={handleRoleChange}
        onExportBackup={handleExportBackup}
        onChooseBackupFile={handleChooseBackupFile}
        onInterfaceChange={handleInterfaceChange}
        onOpenHistory={handleOpenHistory}
        onOpenPublish={handleOpenPublishInfo}
        onOpenPages={() => setCompactPanel("pages")}
        onOpenAssistant={() => setCompactPanel("assistant")}
      />
      {persistenceNotice && <div className="persistence-notice" role="alert"><span>{persistenceNotice}</span><button type="button" onClick={() => setPersistenceNotice(null)}>知道了</button></div>}
      <div
        className={`workspace${isPagesExpanded ? " pages-expanded" : ""}`}
        style={assistantPanelWidth === null ? undefined : { "--assistant-panel-width": `${assistantPanelWidth}px` } as CSSProperties}
      >
        <div className={`workspace-panel-slot pages-panel-slot${compactPanel === "pages" ? " open" : ""}`}>
          <WorkspaceSidebarRail
            toggleButtonRef={sidebarRailToggleRef}
            hasOriginalWorkbook={Boolean(originalWorkbook)}
            onExpand={expandPagesPanel}
            onOpenEdsAnalysis={handleOpenEdsAnalysis}
            onUploadCsv={() => setIsCsvUploadOpen(true)}
            onOpenOriginalWorkbook={handleOpenOriginalWorkbook}
          />
          <button ref={sidebarPanelCloseRef} type="button" className="workspace-sidebar-collapse" aria-label="收起侧边栏" onClick={collapsePagesPanel}>‹</button>
          <button type="button" className="compact-panel-close" aria-label="关闭页面与结构面板" onClick={() => closeCompactPanel(true)}>×</button>
          <PageStructurePanel
            dataProduct={dataProduct}
            appSpec={renderedSpec}
            activePageId={activePageId}
            onPageChange={(pageId) => { handlePageChange(pageId); closeCompactPanel(); }}
            role={role}
            onRenamePage={handleRenamePage}
            activeDataSourceId={activeDataSource?.id ?? ""}
            onOpenDataSource={(dataSourceId) => { setActiveDataSourceId(dataSourceId); setIsDataSourceOpen(true); closeCompactPanel(); }}
            onUploadCsv={() => { setIsCsvUploadOpen(true); closeCompactPanel(); }}
            onOpenEdsAnalysis={() => { handleOpenEdsAnalysis(); closeCompactPanel(); }}
            edsAnalysisButtonRef={edsAnalysisButtonRef}
            originalWorkbook={originalWorkbook?.file ?? null}
            aiRawAccess={originalWorkbook?.aiRawAccess ?? false}
            originalWorkbookButtonRef={originalWorkbookButtonRef}
            onOpenOriginalWorkbook={() => { handleOpenOriginalWorkbook(); closeCompactPanel(); }}
          />
        </div>
        <DataProductCanvas
          appSpec={renderedSpec}
          dataRuntime={dataRuntime}
          role={role}
          appSpecRevision={formalAppSpecRevision}
          activePageId={activePageId}
          device={device}
          isPreviewing={Boolean(execution.preview)}
          canUndo={role !== "viewer" && execution.history.length > 0}
          mode={canvasMode}
          puckData={puckDraft}
          puckSessionKey={puckSessionKey}
          hasPuckPreview={Boolean(pendingPuckChangeSet && execution.preview?.changeSetId === pendingPuckChangeSet.id)}
          edsReportOptions={edsReportOptions}
          edsAnalysisRunning={aiRequestStatus === "loading"}
          onUndo={handleUndo}
          onModeChange={handleCanvasModeChange}
          onPuckDataChange={handlePuckDataChange}
          onRequestPuckPreview={handleRequestPuckPreview}
          onApplyPuckPreview={handleApplyPuckPreview}
          onCancelPuckPreview={handleCancelPuckPreview}
          onEdsReportChange={handleSelectEdsWorkspaceReport}
          onAnalyzeEdsReports={handleAnalyzeEdsReports}
          onQueryExecuted={handleQueryExecuted}
        />
        <div ref={assistantPanelSlotRef} className={`workspace-panel-slot assistant-panel-slot${compactPanel === "assistant" ? " open" : ""}`}>
          <div
            className="assistant-resize-handle"
            role="separator"
            aria-label="调整 AI 助手宽度"
            aria-orientation="vertical"
            aria-valuemin={ASSISTANT_PANEL_MIN_WIDTH}
            aria-valuemax={ASSISTANT_PANEL_MAX_WIDTH}
            aria-valuenow={Math.round(assistantPanelWidth ?? 350)}
            aria-valuetext="左右拖动调整宽度，双击恢复默认宽度"
            tabIndex={0}
            title="左右拖动调整 AI 助手宽度；双击恢复默认宽度"
            onPointerDown={handleAssistantResizeStart}
            onPointerMove={handleAssistantResizeMove}
            onPointerUp={handleAssistantResizeEnd}
            onPointerCancel={handleAssistantResizeEnd}
            onDoubleClick={() => setAssistantPanelWidth(null)}
            onKeyDown={handleAssistantResizeKeyDown}
          />
          <button type="button" className="compact-panel-close" aria-label="关闭 AI 助手面板" onClick={() => closeCompactPanel(true)}>×</button>
          <AiBuilderAssistant
            pageTitle={activePage?.title ?? "未选择页面"}
            datasetName={dataset?.name ?? "未选择数据集"}
            changeSet={aiChangeSet}
            status={status}
            validationError={validationError}
            canApply={role !== "viewer"}
            canPreview={hasValidAiPlan}
            auditRecords={auditRecords}
            aiMessage={aiMessage}
            aiMetadata={aiMetadata}
            instruction={aiInstruction}
            requestStatus={aiRequestStatus}
            requestError={aiRequestError}
            canRetry={Boolean(lastSubmittedInstruction && aiRequestError)}
            harnessTask={isLocalAssistantReply ? null : harnessTasks[0] ?? null}
            harnessTaskCount={harnessTasks.length}
            conversationTurns={assistantConversation}
            pendingInstruction={aiRequestStatus === "loading" ? lastSubmittedInstruction : ""}
            dataAnalysisMode={Boolean(edsWorkspace && activePageId === EDS_WORKSPACE_PAGE_ID)}
            rawDataAccessEnabled={originalWorkbook?.aiRawAccess ?? false}
            imageAttachments={aiImageAttachments}
            onInstructionChange={setAiInstruction}
            onImageAttachmentsChange={(files) => {
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
            }}
            onGenerate={() => { void handleGenerateAiPlan(); }}
            onCancelRequest={handleCancelAiRequest}
            onClearConversation={handleClearAssistantConversation}
            onRetry={handleRetryAiRequest}
            onPreview={handlePreview}
            onApply={handleApply}
            onCancelPreview={handleCancelPreview}
          />
        </div>
      </div>
      {compactPanel && <button type="button" className="compact-panel-scrim" aria-label="关闭侧栏" onClick={() => closeCompactPanel(true)} />}
      {isDataSourceOpen && activeDataSource && (
        <DataSourceDetailsPanel
          key={activeDataSource.id}
          source={activeDataSource}
          rows={dataRuntime.rowsByDataSourceId[activeDataSource.id] ?? []}
          recipe={dataProduct.recipes.find((recipe) => recipe.sourceDatasetId === activeDataSource.id)}
          queryRecords={queryRecords}
          onPreviewRecipeBinding={handlePreviewRecipeBinding}
          onConfirmAiAccess={activeDataSource.ephemeral ? handleConfirmDatasetAiAccess : undefined}
          onDelete={activeDataSource.ephemeral ? handleDeleteDataset : undefined}
          onClose={() => setIsDataSourceOpen(false)}
        />
      )}
      {isCsvUploadOpen && <CsvUploadDialog onUploaded={handleCsvUploaded} onClose={() => setIsCsvUploadOpen(false)} />}
      {isEdsAnalysisOpen && <EdsAnalysisDialog onCreateWorkspace={handleCreateEdsWorkspace} onClose={handleCloseEdsAnalysis} />}
      {isOriginalWorkbookOpen && originalWorkbook && (
        <OriginalWorkbookDialog
          file={originalWorkbook.file}
          sheetNames={originalWorkbook.sheetNames}
          aiRawAccess={originalWorkbook.aiRawAccess}
          onClose={() => {
            setIsOriginalWorkbookOpen(false);
            requestAnimationFrame(() => restoreDialogTrigger(originalWorkbookTriggerRef.current ?? originalWorkbookButtonRef.current));
          }}
        />
      )}
      <ActivityHistoryPanel
        open={isHistoryOpen}
        harnessTasks={harnessTasks}
        auditRecords={auditRecords}
        loading={isHistoryLoading}
        onRestoreFocus={handleRestoreHistoryFocus}
        onClose={handleCloseHistory}
      />
      {isPublishInfoOpen && <PublishReadinessDialog onDownloadBackup={handleExportBackup} onClose={handleClosePublishInfo} />}
    </main>
  );
}
